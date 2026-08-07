import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { resolveMcpSettings, runConnect } from "./connect.js";
import { decodeDirectPusher, isChatMessage } from "./inbound-core.js";
import { dispatchInboundGroupTurn } from "./inbound-dispatch.js";
import { loadIdentity } from "./token-store.js";
const FILAMENT_CHANNEL_ID = "filament";
function summarize(decoded) {
  const parts = [`type=${decoded.branchType}`];
  if (decoded.roomId) parts.push(`room=${decoded.roomId}`);
  if (decoded.senderId) parts.push(`from=${decoded.senderId}`);
  if (decoded.eventId) parts.push(`event=${decoded.eventId}`);
  if (decoded.text != null) {
    const preview = decoded.text.length > 60 ? `${decoded.text.slice(0, 60)}\u2026` : decoded.text;
    parts.push(`text=${JSON.stringify(preview)}`);
  } else if (isChatMessage(decoded.branchType)) {
    parts.push("text=<media-only>");
  }
  if (decoded.nonce) parts.push(`nonce=${decoded.nonce}`);
  return parts.join(" ");
}
function replyText(payload) {
  const text = payload && typeof payload === "object" ? payload.text : void 0;
  return typeof text === "string" ? text : "";
}
function registerFilamentChannel(api, onConnectionChange = () => {
}) {
  const log = (message) => {
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
      blurb: "Connects the agent to Filament via FCM push + MCP-over-HTTP"
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
      // oxlint-disable-next-line typescript/no-explicit-any
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default"
      })
    },
    gateway: {
      // oxlint-disable-next-line typescript/no-explicit-any
      startAccount: async (ctx) => {
        let connection = null;
        const handleInbound = async (env) => {
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
          const deliver = async (payload) => {
            const text = replyText(payload);
            if (!text.trim()) {
              log("filament: agent produced no text reply; nothing to post");
              return;
            }
            const res = isBackchannel ? await client.messagePrincipal(text) : await client.postMessage(roomId, text);
            log(
              res.ok ? `filament: reply posted to ${roomId}` : `filament: reply post failed (${res.error?.code ?? "?"})`
            );
          };
          try {
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
                onRecordError: (error) => log(`filament: record error (continuing): ${String(error)}`),
                // oxlint-disable-next-line typescript/no-explicit-any
                onDispatchError: (error, info) => log(`filament: dispatch error (${info?.kind ?? "?"}): ${String(error)}`)
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
                log: (message) => log(`filament: ${message}`)
              });
              log(`filament: dispatched channel_message (session=${sessionKey ?? "?"})`);
            }
          } catch (error) {
            log(`filament: inbound dispatch threw: ${String(error)}`);
          }
        };
        let token = "";
        if (mcp.tokenInput !== void 0) {
          const resolved = await resolveConfiguredSecretInputString({
            config: api.config,
            env: process.env,
            value: mcp.tokenInput,
            path: "plugins.entries.filament-fcm.config.connectToken"
          });
          token = resolved.value ?? "";
          if (!token) {
            log(
              `filament: connect token did not resolve${resolved.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : ""}`
            );
          }
        }
        if (token) {
          try {
            connection = await runConnect({
              mcpUrl: mcp.mcpUrl,
              token,
              log,
              onInbound: (env) => void handleInbound(env)
            });
            onConnectionChange(connection);
          } catch (error) {
            log(`filament: connect failed: ${String(error)}`);
          }
        } else {
          log("filament: no connect token configured; channel idle (set config.connectToken)");
        }
        await new Promise((resolve) => {
          const signal = ctx?.abortSignal;
          if (!signal) return resolve();
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        connection?.stop();
        onConnectionChange(null);
      },
      stopAccount: async () => {
        onConnectionChange(null);
      }
    }
  };
  try {
    api.registerChannel({ plugin });
    log(`filament: registered channel '${FILAMENT_CHANNEL_ID}'`);
  } catch (error) {
    log(`filament: registerChannel threw \u2192 ${String(error)}`);
  }
}
export {
  FILAMENT_CHANNEL_ID,
  registerFilamentChannel
};
//# sourceMappingURL=channel.js.map
