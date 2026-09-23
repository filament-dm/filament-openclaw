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
import {
  beginFilamentTurn,
  endFilamentTurn,
  fetchAndRegisterFilamentTools,
  type FilamentToolsApi,
} from "./filament-tools.js";
import { dispatchWorkItemTurn } from "./inbound-dispatch.js";
import { type DispatchOutcome, type PollWorkItem, runPollLoop } from "./poll-work.js";
import { loadIdentity } from "./token-store.js";

export const FILAMENT_CHANNEL_ID = "filament";

// Loose structural view of the plugin API surface the channel touches. The
// concrete OpenClaw SDK types only resolve inside the gateway, so we keep
// this minimal and let the runtime provide the real objects.
export interface FilamentChannelApi extends FilamentToolsApi {
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
 * The exact prefix of synapse's `_ALREADY_ANSWERED` message
 * (`tools_write.py`), returned as `{"error": "..."}` (HTTP 200, no
 * `isError`) when a reply targets a work-ledger item a tool call already
 * answered this turn (e.g. the model called `filament_post_message` itself
 * before the poll loop's own `reply_with` publish ran). This is a success
 * from the ledger's point of view — the item got exactly one reply — so it
 * must not be treated as a publish failure.
 */
const ALREADY_ANSWERED_PREFIX = "You have already answered this message";

function isAlreadyAnsweredError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const err = (data as Record<string, unknown>).error;
  return typeof err === "string" && err.startsWith(ALREADY_ANSWERED_PREFIX);
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
          // Marks this turn as Filament-originated (and whether it came from
          // the backchannel) for src/filament-tools.ts's authorization gate —
          // see that module's docstring for why this is a module-level flag
          // rather than something read off `ctx` inside a tool's execute().
          beginFilamentTurn(item.is_backchannel === true);
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
          } finally {
            endFilamentTurn();
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
            if (publishRes.ok && isAlreadyAnsweredError(publishRes.data)) {
              // The model already answered this item with a tool call
              // (filament_post_message/filament_reply_in_thread/
              // filament_message_principal) during the turn; the ledger
              // rejected our own reply_with publish as a duplicate. The item
              // got its one reply, so this is success, not a publish failure.
              log("filament: item already answered by a tool call; skipping publish");
              return { kind: "published" };
            }
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

        if (connection) {
          // Register the agent-facing tool surface from the live server's
          // tools/list, before any turn can be dispatched (see
          // src/filament-tools.ts's module docstring for why this happens
          // here — after connect, before the poll loop — rather than
          // synchronously in register(api)). getClient reads `connection`
          // fresh on every tool call, so a tool degrades cleanly if the
          // connection is later torn down without needing to be unregistered.
          await fetchAndRegisterFilamentTools(
            api,
            connection.client,
            () => connection?.client ?? null,
            log,
          );
          const { fatal } = await runPollLoop({
            client: connection.client,
            abortSignal,
            log,
            dispatchItem,
            waitSeconds: mcp.pollWaitSeconds,
          });
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
