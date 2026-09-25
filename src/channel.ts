/**
 * The Filament OpenClaw **channel**.
 *
 * A channel is a first-class messaging transport the gateway drives: it gets
 * a per-account `startAccount`/`stopAccount` lifecycle and a `channelRuntime`
 * surface that can wake agent turns and route replies. The whole Filament
 * integration lives inside the channel account:
 *
 *   startAccount → resolve settings + token → runConnect (bearer, get_self,
 *   heartbeat) → run the account's transport until it stops → hold open
 *   until abort.
 *
 * This module owns what both transports share — connecting, running an agent
 * turn, the tool connection, the gateway control account — and hands it to
 * the transport the account's settings pick (src/transports/):
 *
 *   - `fcm` (default): pushes over Firebase Cloud Messaging, replies over MCP.
 *   - `poll` (opt-in): the `poll_work` long-poll with `reply_with`.
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
import { type ConnectHandle, runConnect } from "./connect.js";
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
import { connectTokenConfigPath, resolveAccountSettings, type Transport } from "./settings.js";
import { loadIdentity } from "./token-store.js";
import { runPollTransport } from "./transports/poll/index.js";
import type { RunTransport, TurnResult } from "./transports/types.js";
import { dispatchWorkItemTurn } from "./turn.js";
import type { WorkItem } from "./work-item.js";

export { FILAMENT_CHANNEL_ID };

const TRANSPORTS: Record<Transport, RunTransport> = {
  fcm: runPollTransport,
  poll: runPollTransport,
};

// The gateway control account's inventory report, when one is running, so a
// data account coming up or going down refreshes what the Filament app shows.
let refreshGatewayInventory: (() => void) | null = null;

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
      blurb: "Connects the agent to Filament via FCM push (or poll_work) + MCP",
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
          // Only a live account counts as connected: a bound account whose
          // bearer was revoked shows as free, and connecting it replaces it.
          const agents = listGatewayAgents(liveGatewayConfig(), (id) =>
            getFilamentClient(id) ? loadIdentity(id)?.mxid : undefined,
          );
          const status = await connection.client.reportTools(inventoryEntries(agents, statuses), {
            signal: abortSignal,
          });
          accountLog(`filament-gateway: reported ${agents.length} agent(s) (HTTP ${status})`);
        };

        // Apply one control-account item: gateway commands, never a turn.
        const handleControl = async (item: WorkItem): Promise<void> => {
          if (!connection) return;
          const client = connection.client;
          await handleGatewayItem({
            item,
            principal: connection.identity.principal,
            ccRoomId: connection.identity.ccRoomId,
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
        };

        // Run one agent turn for an item; the transport publishes the reply.
        const runTurn = async (item: WorkItem): Promise<TurnResult> => {
          if (!ctx.channelRuntime) {
            throw new Error("ctx.channelRuntime unavailable; cannot wake a turn");
          }
          const identity = loadIdentity(accountId);
          // Marks this turn as Filament-originated (and whether it came from
          // the backchannel) for src/filament-tools.ts's authorization gate —
          // see that module's docstring for why this is a module-level flag
          // rather than something read off `ctx` inside a tool's execute().
          beginFilamentTurn(item.is_backchannel === true, accountId);
          let repliedTo: ReadonlySet<string> = new Set();
          let result;
          try {
            result = await dispatchWorkItemTurn({
              cfg: ctx.cfg,
              channelRuntime: ctx.channelRuntime,
              channel: FILAMENT_CHANNEL_ID,
              channelLabel: "Filament",
              accountId,
              peerKind: item.is_backchannel || item.is_direct ? "direct" : "group",
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
          } finally {
            repliedTo = endFilamentTurn(accountId);
          }
          return { ...result, repliedTo };
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
              credential: "exchange",
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

        const refreshOtherwise = () => {
          if (!control) refreshGatewayInventory?.();
        };
        if (connection && control) {
          refreshGatewayInventory = () => {
            reportInventory().catch((error) => {
              accountLog(`filament-gateway: inventory report failed: ${String(error)}`);
            });
          };
          refreshGatewayInventory();
        }

        if (connection) {
          // The tool surface is already registered (see registerFilamentChannel
          // above); populate the connection holder so each tool's execute()
          // can reach the live client. Cleared below on the way out, whatever
          // the exit reason (normal wind-down or fatal). A control account
          // owns no tools, so it never gets one.
          if (!control) setFilamentClient(connection.client, accountId);
          refreshOtherwise();
          // Best-effort diagnostic only — see src/filament-tools.ts's
          // checkFilamentToolDrift docstring. Never blocks/aborts connect.
          if (!control) {
            void checkFilamentToolDrift(connection.client, accountLog).catch((error) => {
              accountLog(`filament: tool drift check failed: ${String(error)}`);
            });
          }
          const { fatal } = await TRANSPORTS[mcp.transport]({
            accountId,
            client: connection.client,
            identity: connection.identity,
            settings: mcp,
            control,
            abortSignal,
            log: accountLog,
            runTurn,
            handleControl,
          });
          if (fatal) {
            // Surface a diagnostic and stop: returning normally here (rather
            // than throwing) is a deliberate choice — see ROADMAP.md's
            // "lifecycle on fatal" note on why we don't want the gateway's
            // exit-triggers-restart behavior to silently re-run a transport
            // that just told us to stop.
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
        // "no token configured" idle case and the post-transport wind-down),
        // so the channel stays "running" instead of exit-triggering a restart.
        if (!abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) return resolve();
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }

        connection?.stop();
        setFilamentClient(null, accountId);
        if (control) refreshGatewayInventory = null;
        else refreshOtherwise();
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
