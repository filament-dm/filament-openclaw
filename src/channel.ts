/**
 * The Filament OpenClaw **channel** — the single integration unit (approach A).
 *
 * Unlike a background service, a channel is a first-class messaging transport
 * the gateway drives: it gets a per-account `startAccount`/`stopAccount`
 * lifecycle and a `channelRuntime` surface that can wake agent turns and route
 * replies. So the whole Filament integration lives inside the channel account:
 *
 *   startAccount → resolve token → runConnect (get_self, accept invites/vouches,
 *   FCM register, register_push_token, heartbeat, first-contact greeting) → keep
 *   the FCM socket open, decoding inbound pushes → hold open until abort.
 *
 * Inbound dispatch:
 *   - liveness ping        → `pong` side-channel (LLM-free)
 *   - direct/channel msg   → wake an agent turn via
 *                            `dispatchInboundDirectDmWithRuntime`, then post the
 *                            reply back over MCP (message_principal / post_message)
 *   - invites/vouches/reactions → logged only; acting on them is not wired yet.
 */
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

import { type ConnectHandle, resolveMcpSettings, runConnect } from "./connect.js";
import type { FcmMessageEnvelope } from "./fcm.js";
import {
  type DecodedPush,
  decodeDirectPusher,
  isChatMessage,
  isInvite,
  isVouch,
} from "./inbound-core.js";
import { dispatchInboundGroupTurn } from "./inbound-dispatch.js";
import { loadIdentity } from "./token-store.js";

export const FILAMENT_CHANNEL_ID = "filament";

// Loose structural view of the plugin API surface the channel touches. The
// concrete OpenClaw SDK types only resolve inside the gateway, so we keep these
// minimal and let the runtime provide the real objects.
export interface FilamentChannelApi {
  config: unknown;
  pluginConfig?: unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  registerChannel: (registration: unknown) => void;
}

/** One-line summary of a decoded push for observability. */
function summarize(decoded: DecodedPush): string {
  const parts = [`type=${decoded.branchType}`];
  if (decoded.roomId) parts.push(`room=${decoded.roomId}`);
  if (decoded.senderId) parts.push(`from=${decoded.senderId}`);
  if (decoded.eventId) parts.push(`event=${decoded.eventId}`);
  if (decoded.text != null) {
    const preview = decoded.text.length > 60 ? `${decoded.text.slice(0, 60)}…` : decoded.text;
    parts.push(`text=${JSON.stringify(preview)}`);
  } else if (isChatMessage(decoded.branchType)) {
    parts.push("text=<media-only>");
  }
  if (decoded.nonce) parts.push(`nonce=${decoded.nonce}`);
  return parts.join(" ");
}

/** Extract the agent's reply text from the dispatcher's delivered payload. */
function replyText(payload: unknown): string {
  const text = payload && typeof payload === "object" ? (payload as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text : "";
}

/**
 * Register the Filament channel. `onConnectionChange` surfaces the live
 * ConnectHandle (for the conformance token snapshot); called with the handle
 * when an account connects and null when it stops.
 */
export function registerFilamentChannel(
  api: FilamentChannelApi,
  onConnectionChange: (connection: ConnectHandle | null) => void = () => {},
): void {
  const log = (message: string) => {
    if (api.logger?.info) api.logger.info(message);
    else console.log(message);
  };
  const mcp = resolveMcpSettings(api.pluginConfig);

  const plugin = {
    id: FILAMENT_CHANNEL_ID,
    meta: {
      id: FILAMENT_CHANNEL_ID,
      label: "Filament",
      selectionLabel: "Filament",
      docsPath: "/channels/filament",
      blurb: "Connects the agent to Filament via FCM push + MCP-over-HTTP",
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
      // oxlint-disable-next-line typescript/no-explicit-any
      resolveAccount: (_cfg: any, accountId?: string | null) => ({
        accountId: accountId ?? "default",
      }),
    },
    gateway: {
      // oxlint-disable-next-line typescript/no-explicit-any
      startAccount: async (ctx: any) => {
        // The live connection is assigned once runConnect resolves; inbound
        // handlers guard on it (a push can only arrive after FCM connects,
        // which is inside runConnect, so in practice it's set by first use).
        let connection: ConnectHandle | null = null;

        // Route one inbound push: ping → pong; chat → wake a turn + reply.
        const handleInbound = async (env: FcmMessageEnvelope) => {
          const decoded = decodeDirectPusher(env);
          if (!decoded) {
            log(`filament: inbound pid=${env.persistentId} (badge-only or unparseable; ignored)`);
            return;
          }
          log(`filament: inbound ${summarize(decoded)}`);

          if (decoded.branchType === "io.filament.ping") {
            if (decoded.nonce && connection) {
              try {
                await connection.client.pong(decoded.nonce);
                log(`filament: pong sent (nonce=${decoded.nonce})`);
              } catch (error) {
                log(`filament: pong failed: ${String(error)}`);
              }
            }
            return;
          }

          // Auto-accept invites/vouches at runtime (mirrors Hermes' _on_invite /
          // _on_vouch). Invites carry the room/space in the top-level room_id; a
          // vouch's loop id lives on the branch (falling back to room_id).
          if (isInvite(decoded.branchType) || isVouch(decoded.branchType)) {
            const targetId = isVouch(decoded.branchType)
              ? (decoded.loopId ?? decoded.roomId)
              : decoded.roomId;
            if (!connection || !targetId) {
              log(`filament: ${decoded.branchType} before connect / no id; skipping`);
              return;
            }
            try {
              const res = isVouch(decoded.branchType)
                ? await connection.client.acceptVouch(targetId)
                : await connection.client.acceptInvite(targetId);
              log(
                res.ok
                  ? `filament: ${isVouch(decoded.branchType) ? "accepted vouch into" : "accepted invite to"} ${targetId}`
                  : `filament: ${decoded.branchType} accept failed (${res.error?.code ?? "?"})`,
              );
            } catch (error) {
              log(`filament: ${decoded.branchType} accept threw: ${String(error)}`);
            }
            return;
          }

          if (!isChatMessage(decoded.branchType) || !decoded.roomId) {
            log(`filament: inbound ${decoded.branchType} not yet handled`);
            return;
          }

          if (!connection) {
            log("filament: inbound arrived before connect finished; dropping");
            return;
          }
          if (!ctx?.channelRuntime) {
            log("filament: ctx.channelRuntime unavailable; cannot wake a turn");
            return;
          }
          const client = connection.client;
          const roomId = decoded.roomId;
          const identity = loadIdentity();
          const isBackchannel = !!identity?.ccRoomId && roomId === identity.ccRoomId;

          // Post the agent's reply back to the originating conversation: the
          // backchannel replies to the principal (message_principal, matching
          // Hermes' control plane); any other room gets a normal post_message.
          const deliver = async (payload: unknown) => {
            const text = replyText(payload);
            if (!text.trim()) {
              log("filament: agent produced no text reply; nothing to post");
              return;
            }
            const res = isBackchannel
              ? await client.messagePrincipal(text)
              : await client.postMessage(roomId, text);
            log(
              res.ok
                ? `filament: reply posted to ${roomId}`
                : `filament: reply post failed (${res.error?.code ?? "?"})`,
            );
          };

          try {
            // The backchannel is a personal room that arrives as a channel_message
            // but is the control plane — route it (and true DMs) through the
            // direct path. Real group channels get a per-channel session via the
            // group path, so contexts don't bleed across rooms (the direct path,
            // under the default dmScope, collapses every room to one session).
            if (isBackchannel || decoded.branchType === "direct_message") {
              await dispatchInboundDirectDmWithRuntime({
                cfg: ctx.cfg,
                runtime: { channel: ctx.channelRuntime },
                channel: FILAMENT_CHANNEL_ID,
                channelLabel: "Filament",
                accountId: ctx.accountId ?? "default",
                peer: { kind: "direct", id: roomId },
                senderId: decoded.senderId ?? "unknown",
                senderAddress: decoded.senderId ?? "unknown",
                recipientAddress: identity?.mxid ?? `${FILAMENT_CHANNEL_ID}:agent`,
                conversationLabel: decoded.channel ?? decoded.sender ?? roomId,
                rawBody: decoded.text ?? "",
                messageId: decoded.eventId ?? env.persistentId,
                // The principal's own agent; Filament already gates who can reach it.
                commandAuthorized: true,
                deliver,
                onRecordError: (error: unknown) =>
                  log(`filament: record error (continuing): ${String(error)}`),
                // oxlint-disable-next-line typescript/no-explicit-any
                onDispatchError: (error: unknown, info: any) =>
                  log(`filament: dispatch error (${info?.kind ?? "?"}): ${String(error)}`),
              });
            } else {
              const sessionKey = await dispatchInboundGroupTurn({
                cfg: ctx.cfg,
                channelRuntime: ctx.channelRuntime,
                channel: FILAMENT_CHANNEL_ID,
                channelLabel: "Filament",
                accountId: ctx.accountId ?? "default",
                roomId,
                senderId: decoded.senderId ?? "unknown",
                recipientAddress: identity?.mxid ?? `${FILAMENT_CHANNEL_ID}:agent`,
                conversationLabel: decoded.channel ?? decoded.sender ?? roomId,
                rawBody: decoded.text ?? "",
                messageId: decoded.eventId ?? env.persistentId,
                deliver,
                log: (message: string) => log(`filament: ${message}`),
              });
              log(`filament: dispatched channel_message (session=${sessionKey ?? "?"})`);
            }
          } catch (error) {
            log(`filament: inbound dispatch threw: ${String(error)}`);
          }
        };

        // Resolve the connect token: a raw string, a `${ENV}` shorthand, or a
        // SecretRef pointing at an env/file/exec provider.
        let token = "";
        if (mcp.tokenInput !== undefined) {
          const resolved = await resolveConfiguredSecretInputString({
            config: api.config,
            env: process.env,
            value: mcp.tokenInput,
            path: "plugins.entries.filament-fcm.config.connectToken",
          });
          token = resolved.value ?? "";
          if (!token) {
            log(
              `filament: connect token did not resolve${
                resolved.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : ""
              }`,
            );
          }
        }

        if (token) {
          try {
            connection = await runConnect({
              mcpUrl: mcp.mcpUrl,
              token,
              log,
              onInbound: (env) => void handleInbound(env),
            });
            onConnectionChange(connection);
          } catch (error) {
            log(`filament: connect failed: ${String(error)}`);
          }
        } else {
          log("filament: no connect token configured; channel idle (set config.connectToken)");
        }

        // Hold the account open until the gateway aborts it, so the channel
        // stays "running" (no exit/auto-restart loop) and the FCM socket +
        // heartbeat keep going.
        await new Promise<void>((resolve) => {
          const signal: AbortSignal | undefined = ctx?.abortSignal;
          if (!signal) return resolve();
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });

        connection?.stop();
        onConnectionChange(null);
      },
      stopAccount: async () => {
        onConnectionChange(null);
      },
    },
  };

  try {
    api.registerChannel({ plugin });
    log(`filament: registered channel '${FILAMENT_CHANNEL_ID}'`);
  } catch (error) {
    log(`filament: registerChannel threw → ${String(error)}`);
  }
}
