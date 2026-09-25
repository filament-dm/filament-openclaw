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

import {
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  isControlAccount,
  listConfiguredAccountIds,
  PLUGIN_ID,
  pluginConfigFrom,
} from "./accounts.js";
import {
  type ConnectHandle,
  connectTokenConfigPath,
  resolveAccountSettings,
  runConnect,
} from "./connect.js";
import {
  beginFilamentTurn,
  checkFilamentToolDrift,
  endFilamentTurn,
  getFilamentClient,
  registerFilamentToolsFromSnapshot,
  setFilamentClient,
  type FilamentToolsApi,
} from "./filament-tools.js";
import {
  type GatewayStatus,
  handleGatewayItem,
  inventoryEntries,
  listGatewayAgents,
  MAX_REPORTED_STATUSES,
} from "./gateway.js";
import { dispatchWorkItemTurn } from "./inbound-dispatch.js";
import { type DispatchOutcome, type PollWorkItem, runPollLoop } from "./poll-work.js";
import { loadIdentity } from "./token-store.js";

export { FILAMENT_CHANNEL_ID };

// Loose structural view of the plugin API surface the channel touches. The
// concrete OpenClaw SDK types only resolve inside the gateway, so we keep
// this minimal and let the runtime provide the real objects.
export interface FilamentChannelApi extends FilamentToolsApi {
  config: unknown;
  pluginConfig?: unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  registerChannel: (registration: { plugin: ChannelPlugin }) => void;
  /** `api.runtime.config` — the gateway control account reads and writes config through it. */
  runtime?: {
    config?: {
      current?: () => unknown;
      mutateConfigFile?: (params: {
        afterWrite: { mode: "auto" };
        mutate: (draft: Record<string, unknown>) => void;
      }) => Promise<unknown>;
    };
  };
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
  // The live gateway config wins over the load-time snapshot, so an account
  // added by `openclaw config set` is seen on the next reload.
  // oxlint-disable-next-line typescript/no-explicit-any
  const pluginConfigOf = (cfg: any): unknown => pluginConfigFrom(cfg) ?? api.pluginConfig;

  // Register the whole Filament tool surface now, synchronously, from the
  // schema snapshot — before any connection exists. See
  // src/filament-tools.ts's module docstring for why this replaced the old
  // post-connect, tools/list-fetching registration: a session can resolve
  // its toolset before that later write ever lands in the registry. Each
  // tool's execute() resolves the live connection lazily via
  // getFilamentClient(), which startAccount below populates once connected.
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);

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
      // One account per Filament agent: `config.accounts.<id>`, plus the
      // legacy top-level token as `default` (src/accounts.ts).
      // oxlint-disable-next-line typescript/no-explicit-any
      listAccountIds: (cfg: any) => listConfiguredAccountIds(pluginConfigOf(cfg)),
      // oxlint-disable-next-line typescript/no-explicit-any
      resolveAccount: (_cfg: any, accountId?: string | null) => ({
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      }),
    },
    gateway: {
      // oxlint-disable-next-line typescript/no-explicit-any
      startAccount: async (ctx: any) => {
        let connection: ConnectHandle | null = null;
        const abortSignal: AbortSignal = ctx.abortSignal;
        const accountId: string = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
        const pluginConfig = pluginConfigOf(ctx.cfg);
        const mcp = resolveAccountSettings(pluginConfig, accountId);
        const accountLog = (message: string) => log(`[${accountId}] ${message}`);
        // A gateway control account (src/gateway.ts): no agent turns, no tools.
        const control = isControlAccount(pluginConfig, accountId);
        const liveGatewayConfig = (): unknown => api.runtime?.config?.current?.() ?? ctx.cfg;
        // Recent command outcomes, re-sent with every inventory report. Lost on
        // a reload by design: a config write is what triggers one.
        const statuses: GatewayStatus[] = [];
        const reportInventory = async (): Promise<void> => {
          if (!connection) return;
          const agents = listGatewayAgents(liveGatewayConfig(), (id) => loadIdentity(id)?.mxid);
          const status = await connection.client.reportTools(inventoryEntries(agents, statuses), {
            signal: abortSignal,
          });
          accountLog(`filament-gateway: reported ${agents.length} agent(s) (HTTP ${status})`);
        };

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
          if (control) {
            const client = connection.client;
            const identity = connection.identity;
            return handleGatewayItem({
              item,
              principal: identity.principal,
              ccRoomId: identity.ccRoomId,
              gatewayConfig: liveGatewayConfig(),
              consume: async (upToEventId) => {
                await client.callTool(
                  "mark_read",
                  { channel: item.channel_id, up_to: upToEventId },
                  { signal: abortSignal },
                );
              },
              mutateConfig: async (mutate) => {
                const write = api.runtime?.config?.mutateConfigFile;
                if (!write)
                  throw new Error("this OpenClaw has no api.runtime.config.mutateConfigFile");
                await write({ afterWrite: { mode: "auto" }, mutate });
              },
              report: async (entries) => {
                statuses.unshift(...[...entries].reverse());
                statuses.splice(MAX_REPORTED_STATUSES);
                await reportInventory();
              },
              log: accountLog,
            });
          }
          if (!ctx.channelRuntime) {
            return {
              kind: "error",
              diagnostic: "ctx.channelRuntime unavailable; cannot wake a turn",
            };
          }
          const identity = loadIdentity(accountId);
          let result;
          // Marks this turn as Filament-originated (and whether it came from
          // the backchannel) for src/filament-tools.ts's authorization gate —
          // see that module's docstring for why this is a module-level flag
          // rather than something read off `ctx` inside a tool's execute().
          beginFilamentTurn(item.is_backchannel === true, accountId);
          try {
            result = await dispatchWorkItemTurn({
              cfg: ctx.cfg,
              channelRuntime: ctx.channelRuntime,
              channel: FILAMENT_CHANNEL_ID,
              channelLabel: "Filament",
              accountId,
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
              log: accountLog,
            });
          } catch (error) {
            return { kind: "error", diagnostic: `dispatch threw: ${String(error)}` };
          } finally {
            endFilamentTurn(accountId);
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
              accountLog("filament: item already answered by a tool call; skipping publish");
              return { kind: "published" };
            }
            if (!publishRes.ok || !publishSucceeded(publishRes.data)) {
              return {
                kind: "error",
                diagnostic: `publish failed/ambiguous (${publishRes.kind ?? "?"}: ${publishRes.error?.message ?? "no event_id"})`,
              };
            }
            accountLog(`filament: reply published to ${item.channel_id} via ${replyWith.tool}`);
            return { kind: "published" };
          }
          if (result.sawSkip) {
            return { kind: "silent" };
          }
          accountLog(
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
            path: connectTokenConfigPath(PLUGIN_ID, accountId, pluginConfig),
          });
          token = resolved.value ?? "";
          if (!token) {
            accountLog(
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
              accountId,
              log: accountLog,
              abortSignal,
            });
            onConnectionChange(connection);
          } catch (error) {
            accountLog(`filament: connect failed: ${String(error)}`);
            connection = null;
          }
        } else {
          accountLog(
            "filament: no connect token configured; channel idle (set config.accounts.<id>.connectToken)",
          );
        }

        if (connection && control) {
          await reportInventory().catch((error) => {
            accountLog(`filament-gateway: inventory report failed: ${String(error)}`);
          });
        }

        if (connection) {
          // The tool surface is already registered (see registerFilamentChannel
          // above); populate the connection holder so each tool's execute()
          // can reach the live client. Cleared below on the way out, whatever
          // the exit reason (normal wind-down or fatal). A control account
          // owns no tools, so it never gets one.
          if (!control) setFilamentClient(connection.client, accountId);
          // Best-effort diagnostic only — see src/filament-tools.ts's
          // checkFilamentToolDrift docstring. Never blocks/aborts connect.
          if (!control) {
            void checkFilamentToolDrift(connection.client, accountLog).catch((error) => {
              accountLog(`filament: tool drift check failed: ${String(error)}`);
            });
          }
          const { fatal } = await runPollLoop({
            client: connection.client,
            abortSignal,
            log: accountLog,
            dispatchItem,
            waitSeconds: mcp.pollWaitSeconds,
          });
          if (fatal) {
            // Surface a diagnostic and stop: returning normally here (rather
            // than throwing) is a deliberate choice — see the module header
            // in poll-work.ts and ROADMAP.md's "lifecycle on fatal" note on
            // why we don't want the gateway's exit-triggers-restart behavior
            // to silently re-run a poll loop that just told us to stop.
            accountLog(`filament: account entering a fatal/paused state: ${fatal}`);
            ctx.setStatus?.({
              accountId,
              connected: false,
              statusState: "error",
              restartPending: false,
            });
          }
          setFilamentClient(null, accountId);
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
        setFilamentClient(null, accountId);
        onConnectionChange(null);
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      stopAccount: async (ctx: any) => {
        setFilamentClient(null, ctx?.accountId ?? DEFAULT_ACCOUNT_ID);
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
