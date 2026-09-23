/**
 * The Filament OpenClaw **channel**.
 *
 * A channel is a first-class messaging transport the gateway drives: it gets
 * a per-account `startAccount`/`stopAccount` lifecycle and a `channelRuntime`
 * surface that can wake agent turns and route replies. The whole Filament
 * integration lives inside the channel account:
 *
 *   startAccount → resolve token → runConnect (bearer resolve/exchange,
 *   get_self verification, heartbeat) → runPollLoop (poll_work long-poll,
 *   sequential, cancelable) → hold open until abort.
 *
 * Transport: `poll_work` (see src/poll-work.ts), not FCM. There is no push
 * socket, no invite/vouch auto-accept sweep, and no first-contact greeting —
 * see ROADMAP.md for what that trades away for the PoC.
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

import { type ConnectHandle, resolveMcpSettings, runConnect } from "./connect.js";
import { dispatchWorkItemTurn } from "./inbound-dispatch.js";
import { type InviteSweeperHandle, startInviteSweeper } from "./invite-sweep.js";
import { type DispatchOutcome, type PollWorkItem, runPollLoop } from "./poll-work.js";
import { loadIdentity } from "./token-store.js";

export const FILAMENT_CHANNEL_ID = "filament";

// Loose structural view of the plugin API surface the channel touches. The
// concrete OpenClaw SDK types only resolve inside the gateway, so we keep
// this minimal and let the runtime provide the real objects.
export interface FilamentChannelApi {
  config: unknown;
  pluginConfig?: unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  registerChannel: (registration: { plugin: ChannelPlugin }) => void;
}

/** True when a publish result looks like a genuine success (has an event_id, no error). */
function publishSucceeded(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.event_id === "string" && d.event_id.length > 0 && d.error === undefined;
}

/**
 * Register the Filament channel. `onConnectionChange` surfaces the live
 * ConnectHandle (kept for parity with the previous conformance surface, and
 * for tests); called with the handle when an account connects and null when
 * it stops.
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

  const plugin: ChannelPlugin = {
    id: FILAMENT_CHANNEL_ID,
    meta: {
      id: FILAMENT_CHANNEL_ID,
      label: "Filament",
      selectionLabel: "Filament",
      docsPath: "/channels/filament",
      blurb: "Connects the agent to Filament via the poll_work MCP transport",
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
        let connection: ConnectHandle | null = null;
        const abortSignal: AbortSignal = ctx.abortSignal;

        // Dispatch one work item: run the turn, publish at most once via
        // reply_with, and classify the outcome for the poll loop.
        const dispatchItem = async (item: PollWorkItem): Promise<DispatchOutcome> => {
          const replyWith = item.reply_with;
          if (!replyWith) {
            // Defense in depth: the poll loop already filters these out.
            return { kind: "ambiguous" };
          }
          if (!connection) {
            return { kind: "error", diagnostic: "item arrived before connect finished" };
          }
          if (!ctx.channelRuntime) {
            return {
              kind: "error",
              diagnostic: "ctx.channelRuntime unavailable; cannot wake a turn",
            };
          }
          const identity = loadIdentity();
          let result;
          try {
            result = await dispatchWorkItemTurn({
              cfg: ctx.cfg,
              channelRuntime: ctx.channelRuntime,
              channel: FILAMENT_CHANNEL_ID,
              channelLabel: "Filament",
              accountId: ctx.accountId ?? "default",
              peerKind: item.is_backchannel ? "direct" : "group",
              channelId: item.channel_id,
              threadId: item.thread_id,
              messages: item.messages,
              recipientAddress: identity?.mxid ?? `${FILAMENT_CHANNEL_ID}:agent`,
              conversationLabel: item.channel_id,
              // Filament (not OpenClaw) decides who can reach the agent; this
              // only ever authorizes the backchannel/control-plane item, never
              // an arbitrary conversation (see the plan's item 5).
              commandAuthorized: item.is_backchannel === true,
              log,
            });
          } catch (error) {
            return { kind: "error", diagnostic: `dispatch threw: ${String(error)}` };
          }

          if (result.sawError) {
            return {
              kind: "error",
              diagnostic: result.errorDetail ?? "dispatch reported an error",
            };
          }
          if (result.sawFinal) {
            if (abortSignal.aborted) {
              return { kind: "error", diagnostic: "aborted before publish" };
            }
            const publishRes = await connection.client.replyWith(replyWith, result.finalText, {
              signal: abortSignal,
            });
            if (!publishRes.ok || !publishSucceeded(publishRes.data)) {
              return {
                kind: "error",
                diagnostic: `publish failed/ambiguous (${publishRes.kind ?? "?"}: ${publishRes.error?.message ?? "no event_id"})`,
              };
            }
            log(`filament: reply published to ${item.channel_id} via ${replyWith.tool}`);
            return { kind: "published" };
          }
          if (result.sawSkip) {
            return { kind: "silent" };
          }
          log(
            `filament: turn produced no text and no explicit skip signal for ${item.channel_id}; leaving unacknowledged`,
          );
          return { kind: "ambiguous" };
        };

        // Resolve the connect token: a raw string, a `${ENV}` shorthand, or a
        // SecretRef pointing at an env/file/exec provider.
        let token = "";
        if (mcp.tokenInput !== undefined) {
          const resolved = await resolveConfiguredSecretInputString({
            // oxlint-disable-next-line typescript/no-explicit-any
            config: api.config as any,
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
              abortSignal,
            });
            onConnectionChange(connection);
          } catch (error) {
            log(`filament: connect failed: ${String(error)}`);
            connection = null;
          }
        } else {
          log("filament: no connect token configured; channel idle (set config.connectToken)");
        }

        let inviteSweeper: InviteSweeperHandle | null = null;
        if (connection && mcp.autoAcceptInvites) {
          log(`filament-invites: auto-accept enabled, sweeping every ${mcp.inviteSweepSeconds}s`);
          inviteSweeper = startInviteSweeper({
            client: connection.client,
            log,
            abortSignal,
            intervalSeconds: mcp.inviteSweepSeconds,
          });
        }

        if (connection) {
          const { fatal } = await runPollLoop({
            client: connection.client,
            abortSignal,
            log,
            dispatchItem,
            waitSeconds: mcp.pollWaitSeconds,
          });
          inviteSweeper?.stop();
          if (fatal) {
            // Surface a diagnostic and stop: returning normally here (rather
            // than throwing) is a deliberate choice — see the module header
            // in poll-work.ts and ROADMAP.md's "lifecycle on fatal" note on
            // why we don't want the gateway's exit-triggers-restart behavior
            // to silently re-run a poll loop that just told us to stop.
            log(`filament: account entering a fatal/paused state: ${fatal}`);
            ctx.setStatus?.({
              accountId: ctx.accountId ?? "default",
              connected: false,
              statusState: "error",
              restartPending: false,
            });
          }
        }

        // Hold the account open until the gateway aborts it (covers both the
        // "no token configured" idle case and the post-poll-loop wind-down),
        // so the channel stays "running" instead of exit-triggering a restart.
        if (!abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) return resolve();
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }

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
