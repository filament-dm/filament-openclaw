/**
 * The Filament channel. Per account: connect, run the transport the settings pick (`fcm` by
 * default, or `poll`) until it stops, then hold the account open until the gateway aborts it.
 */
// `media-local-roots` is the newer home of this helper, but the SDK this builds against predates it.
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/agent-media-payload";
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
  type BindOutcome,
  choiceOptions,
  freeOptions,
  greetingBody,
  handlePendingItem,
  notAppliedBody,
  nothingFreeBody,
  questionBody,
} from "./choose-agent.js";
import { awaitConfigApplied, writeGatewayConfig } from "./config-write.js";
import { type ConnectHandle, retryConnect, runConnect } from "./connect.js";
import type { InboundMedia } from "./media.js";
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
import { loadIdentity } from "./state/identities.js";
import {
  choiceAsked,
  dropGreeting,
  leaveGreeting,
  markChoiceAsked,
  takeGreeting,
} from "./state/agent-choice.js";
import {
  loadUpdateState,
  markUpdateRequested,
  saveUpdateState,
  takeUpdateRequest,
} from "./state/updates.js";
import { runFcmTransport } from "./transports/fcm/index.js";
import { runPollTransport } from "./transports/poll/index.js";
import type { RunTransport, TurnResult } from "./transports/types.js";
import { dispatchWorkItemTurn } from "./turn.js";
import {
  runUpdateChecks,
  startPluginUpdate,
  updatedBody,
  updateFailureMessage,
} from "./update-check.js";
import { PLUGIN_VERSION } from "./version.js";
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

        // Through the CLI, never api.runtime.config.mutateConfigFile: see config-write.ts.
        const mutateConfig = async (
          mutate: (draft: Record<string, unknown>) => void,
        ): Promise<void> => {
          await writeGatewayConfig(mutate);
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
        const bindPending = async (agentId: string, label: string): Promise<BindOutcome> => {
          let bound = false;
          let written = false;
          // Left before the write: the reload that applies it ends this account.
          leaveGreeting(agentId, accountId, greetingBody(label));
          try {
            await mutateConfig((draft) => {
              bound = applyPendingChoice(draft, accountId, agentId, token);
            });
            written = true;
          } finally {
            if (!written || !bound) dropGreeting(agentId, accountId);
          }
          if (!bound) return "taken";
          const wait = await awaitConfigApplied({
            applied: () => !isPendingAccount(pluginConfigOf(liveGatewayConfig()), accountId),
            abortSignal,
          });
          return wait === "timeout" ? "written" : "applied";
        };
        // Started, not awaited: the update reloads the plugin, and the reload needs this account
        // to stop. The marker outlives the account; the one that comes back reads it and says
        // what happened. Only a failure, which leaves this account alive, is reported from here.
        let updateInFlight = false;
        const runUpdate = async (): Promise<void> => {
          if (updateInFlight) return;
          updateInFlight = true;
          markUpdateRequested(accountId, PLUGIN_VERSION);
          const finished = startPluginUpdate();
          void finished.then((result) => {
            if (result.code === 0) return;
            updateInFlight = false;
            takeUpdateRequest(accountId);
            const message = updateFailureMessage(result);
            accountLog(`filament-update: ${message}`);
            if (!abortSignal.aborted) {
              sayToPrincipal(`Couldn't update the plugin: ${message}`).catch(() => {});
            }
          });
        };
        /** Resolves true only when the message landed. */
        const sayToPrincipal = async (markdownBody: string): Promise<boolean> => {
          if (!connection) return false;
          const res = await connection.client.callTool(
            "message_principal",
            { markdown_body: markdownBody },
            { signal: abortSignal },
          );
          if (!res.ok) accountLog(`filament-choose: message failed (${res.error?.message ?? "?"})`);
          return res.ok;
        };
        // A connected agent takes `/filament connect <token>` from its principal: the app sends
        // it here so a second Filament agent joins this gateway with no terminal step. Outcomes
        // are said in the chat; this account's tool inventory stays its own.
        const handleCommand = async (item: WorkItem): Promise<void> => {
          if (!connection) return;
          const client = connection.client;
          await handleGatewayItem({
            item,
            scope: "connect",
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
            update: runUpdate,
            // Success is silent here: the new agent asks in its own chat, and an
            // updated plugin says so on reconnect. Only a refusal has nowhere else to show.
            report: async (entries) => {
              const lines = entries
                .filter((status) => status.state !== "applied")
                .map((status) => `Couldn't ${status.command}: ${status.message ?? status.state}`);
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
            say: async (body) => {
              await sayToPrincipal(body);
            },
            bind: bindPending,
            refreshOptions: pendingOptions,
            log: accountLog,
          });
        };
        const startPending = async (): Promise<void> => {
          let options = pendingOptions();
          const chosen = automaticChoice(options);
          if (chosen) {
            accountLog(`filament-choose: the gateway's only agent is '${chosen}'; binding it`);
            const label = options.find((option) => option.agentId === chosen)!.label;
            const outcome = await bindPending(chosen, label);
            if (outcome === "written") {
              accountLog("filament-choose: the gateway did not reload after the bind");
              await sayToPrincipal(notAppliedBody(label));
            }
            if (outcome !== "taken") return;
            // Lost the race for the lone agent: ask with whatever is free now.
            accountLog(`filament-choose: '${chosen}' was taken before the write`);
            options = pendingOptions();
          }
          if (choiceAsked(accountId)) {
            return;
          } else if (freeOptions(options).length === 0) {
            accountLog("filament-choose: this gateway has no free agent to bind");
            // Marked only once said: a failed send must not silence every later start.
            if (await sayToPrincipal(nothingFreeBody(options))) markChoiceAsked(accountId);
          } else if (await sayToPrincipal(questionBody(options))) {
            markChoiceAsked(accountId);
          }
        };

        const runTurn = async (item: WorkItem, media?: InboundMedia[]): Promise<TurnResult> => {
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
              media,
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
          return {
            ...result,
            repliedTo,
            mediaLocalRoots: getAgentScopedMediaLocalRoots(ctx.cfg, result.agentId),
          };
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

        if (connection && !handlesOwnWork) {
          // Markers are taken before the send; a send that fails puts them back for the next connect.
          const greeting = takeGreeting(accountId);
          if (greeting && !(await sayToPrincipal(greeting))) {
            accountLog(
              "filament-choose: could not greet as the bound agent; will retry on connect",
            );
            leaveGreeting(accountId, accountId, greeting);
          }
          const updateRequest = takeUpdateRequest(accountId);
          if (updateRequest) {
            accountLog(
              `filament-update: back on v${PLUGIN_VERSION} (was v${updateRequest.fromVersion})`,
            );
            if (!(await sayToPrincipal(updatedBody(updateRequest.fromVersion, PLUGIN_VERSION)))) {
              accountLog("filament-update: could not report the update; will retry on connect");
              markUpdateRequested(accountId, updateRequest.fromVersion);
            }
          }
          void runUpdateChecks(
            { load: loadUpdateState, save: saveUpdateState, say: sayToPrincipal, log: accountLog },
            abortSignal,
          ).catch((error) => {
            accountLog(`filament-update: checks stopped: ${String(error)}`);
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
