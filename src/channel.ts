/**
 * The Filament channel. Per account: connect, run the transport the settings pick (`fcm` by
 * default, or `poll`) until it stops, then hold the account open until the gateway aborts it.
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

import {
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  isControlAccount,
  isPendingAccount,
  listConfiguredAccountIds,
  PLUGIN_ID,
  pluginConfigFrom,
} from "./accounts.js";
import {
  applyPendingChoice,
  automaticChoice,
  choiceOptions,
  freeOptions,
  handlePendingItem,
  nothingFreeBody,
  questionBody,
} from "./choose-agent.js";
import { type ConnectHandle, retryConnect, runConnect } from "./connect.js";
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
import { loadIdentity, markChoiceAsked } from "./token-store.js";
import { runFcmTransport } from "./transports/fcm/index.js";
import { runPollTransport } from "./transports/poll/index.js";
import type { RunTransport, TurnResult } from "./transports/types.js";
import { dispatchWorkItemTurn } from "./turn.js";
import type { WorkItem } from "./work-item.js";

export { FILAMENT_CHANNEL_ID };

const TRANSPORTS: Record<Transport, RunTransport> = {
  fcm: runFcmTransport,
  poll: runPollTransport,
};

// Set while a control account runs, so a data account starting or stopping refreshes its inventory.
let refreshGatewayInventory: (() => void) | null = null;

// Structural: the concrete OpenClaw SDK types only resolve inside the gateway.
export interface FilamentChannelApi extends FilamentToolsApi {
  config: unknown;
  pluginConfig?: unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  registerChannel: (registration: { plugin: ChannelPlugin }) => void;
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

  // Before any connection exists: a session can resolve its toolset before connect finishes.
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
        accountLog(`filament: transport ${mcp.transport}`);
        const control = isControlAccount(pluginConfig, accountId);
        const pending = !control && isPendingAccount(pluginConfig, accountId);
        // Neither kind runs agent turns: their work goes to a handler instead.
        const handlesOwnWork = control || pending;
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

        const mutateConfig = async (
          mutate: (draft: Record<string, unknown>) => void,
        ): Promise<void> => {
          const write = api.runtime?.config?.mutateConfigFile;
          if (!write) throw new Error("this OpenClaw has no api.runtime.config.mutateConfigFile");
          await write({ afterWrite: { mode: "auto" }, mutate });
        };

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
            mutateConfig,
            report: async (entries) => {
              statuses.unshift(...[...entries].reverse());
              statuses.splice(MAX_REPORTED_STATUSES);
              await reportInventory();
            },
            log: accountLog,
          });
        };

        // A pending account's only job: find out which OpenClaw agent it is, then bind it.
        const pendingOptions = () => choiceOptions(listGatewayAgents(liveGatewayConfig()));
        const bindPending = (agentId: string) =>
          mutateConfig((draft) => applyPendingChoice(draft, accountId, agentId, token));
        const sayToPrincipal = async (markdownBody: string): Promise<void> => {
          if (!connection) return;
          const res = await connection.client.callTool(
            "message_principal",
            { markdown_body: markdownBody },
            { signal: abortSignal },
          );
          if (!res.ok) accountLog(`filament-choose: message failed (${res.error?.message ?? "?"})`);
        };
        // A connected agent takes `/filament connect <token>` from its principal: the app sends
        // it here so a second Filament agent joins this gateway with no terminal step. Outcomes
        // are said in the chat; this account's tool inventory stays its own.
        const handleCommand = async (item: WorkItem): Promise<void> => {
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
            mutateConfig,
            report: async (entries) => {
              const lines = entries.map((status) =>
                status.state === "applied"
                  ? status.command === "connect" && status.agentId === undefined
                    ? "Connecting a new Filament agent to this gateway. It will ask in its own chat which OpenClaw agent should answer as it."
                    : `Applied: ${status.command}${status.agentId ? ` ${status.agentId}` : ""}.`
                  : `Couldn't ${status.command}: ${status.message ?? status.state}`,
              );
              if (lines.length > 0) await sayToPrincipal(lines.join("\n"));
            },
            log: accountLog,
          });
        };
        const handlePending = async (item: WorkItem): Promise<void> => {
          if (!connection) return;
          const client = connection.client;
          await handlePendingItem({
            item,
            principal: connection.identity.principal,
            ccRoomId: connection.identity.ccRoomId,
            options: pendingOptions(),
            consume: async (upToEventId) => {
              await client.callTool(
                "mark_read",
                { channel: item.channel_id, up_to: upToEventId },
                { signal: abortSignal },
              );
            },
            say: sayToPrincipal,
            bind: bindPending,
            log: accountLog,
          });
        };
        const startPending = async (): Promise<void> => {
          const options = pendingOptions();
          const chosen = automaticChoice(options);
          if (chosen) {
            accountLog(`filament-choose: the gateway's only agent is '${chosen}'; binding it`);
            await bindPending(chosen);
          } else if (freeOptions(options).length === 0) {
            accountLog("filament-choose: this gateway has no free agent to bind");
            if (markChoiceAsked(accountId)) await sayToPrincipal(nothingFreeBody(options));
          } else if (markChoiceAsked(accountId)) {
            await sayToPrincipal(questionBody(options));
          }
        };

        const runTurn = async (item: WorkItem): Promise<TurnResult> => {
          if (!ctx.channelRuntime) {
            throw new Error("ctx.channelRuntime unavailable; cannot wake a turn");
          }
          const identity = loadIdentity(accountId);
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
              // Filament, not OpenClaw, decides who can reach the agent; only the
              // backchannel may run OpenClaw commands.
              commandAuthorized: item.is_backchannel === true,
              log: accountLog,
            });
          } finally {
            repliedTo = endFilamentTurn(accountId);
          }
          return { ...result, repliedTo };
        };

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
            connection = await retryConnect(
              () =>
                runConnect({
                  mcpUrl: mcp.mcpUrl,
                  token,
                  accountId,
                  log: accountLog,
                  abortSignal,
                }),
              { log: accountLog, abortSignal },
            );
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

        if (connection && pending) {
          await startPending().catch((error) => {
            accountLog(`filament-choose: could not start the choice: ${String(error)}`);
          });
        }

        if (connection) {
          if (!handlesOwnWork) setFilamentClient(connection.client, accountId);
          refreshOtherwise();
          if (!handlesOwnWork) {
            void checkFilamentToolDrift(connection.client, accountLog).catch((error) => {
              accountLog(`filament: tool drift check failed: ${String(error)}`);
            });
          }
          const { fatal } = await TRANSPORTS[mcp.transport]({
            accountId,
            client: connection.client,
            identity: connection.identity,
            settings: mcp,
            control: handlesOwnWork,
            abortSignal,
            log: accountLog,
            runTurn,
            handleControl: pending ? handlePending : handleControl,
            ...(handlesOwnWork ? {} : { handleCommand }),
          });
          if (fatal) {
            // Report and hold open rather than throw: the gateway restarts an account that
            // exits, which would re-run a transport that just asked to stop.
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

        // Hold open until abort, idle or wound down, so the gateway does not restart the account.
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
