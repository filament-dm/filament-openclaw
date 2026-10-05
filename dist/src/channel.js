import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  isControlAccount,
  isPendingAccount,
  listConfiguredAccountIds,
  PLUGIN_ID,
  pluginConfigFrom
} from "./accounts.js";
import {
  applyPendingChoice,
  automaticChoice,
  choiceOptions,
  freeOptions,
  greetingBody,
  handlePendingItem,
  notAppliedBody,
  nothingFreeBody,
  questionBody
} from "./choose-agent.js";
import { awaitConfigApplied, writeGatewayConfig } from "./config-write.js";
import { retryConnect, runConnect } from "./connect.js";
import {
  beginFilamentTurn,
  checkFilamentToolDrift,
  endFilamentTurn,
  getFilamentClient,
  registerFilamentToolsFromSnapshot,
  setFilamentClient
} from "./filament-tools.js";
import {
  handleGatewayItem,
  inventoryEntries,
  listGatewayAgents,
  MAX_REPORTED_STATUSES
} from "./gateway.js";
import { connectTokenConfigPath, resolveAccountSettings } from "./settings.js";
import {
  choiceAsked,
  leaveGreeting,
  loadIdentity,
  markChoiceAsked,
  takeGreeting
} from "./token-store.js";
import { runFcmTransport } from "./transports/fcm/index.js";
import { runPollTransport } from "./transports/poll/index.js";
import { dispatchWorkItemTurn } from "./turn.js";
const TRANSPORTS = {
  fcm: runFcmTransport,
  poll: runPollTransport
};
let refreshGatewayInventory = null;
function registerFilamentChannel(api, onConnectionChange = () => {
}) {
  const log = (message) => {
    if (api.logger?.info) api.logger.info(message);
    else console.log(message);
  };
  const pluginConfigOf = (cfg) => pluginConfigFrom(cfg) ?? api.pluginConfig;
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const plugin = {
    id: FILAMENT_CHANNEL_ID,
    meta: {
      id: FILAMENT_CHANNEL_ID,
      label: "Filament",
      selectionLabel: "Filament",
      docsPath: "/channels/filament",
      blurb: "Connects the agent to Filament via FCM push (or poll_work) + MCP"
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      // oxlint-disable-next-line typescript/no-explicit-any
      listAccountIds: (cfg) => listConfiguredAccountIds(pluginConfigOf(cfg)),
      // oxlint-disable-next-line typescript/no-explicit-any
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? DEFAULT_ACCOUNT_ID
      })
    },
    gateway: {
      // oxlint-disable-next-line typescript/no-explicit-any
      startAccount: async (ctx) => {
        let connection = null;
        const abortSignal = ctx.abortSignal;
        const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
        const pluginConfig = pluginConfigOf(ctx.cfg);
        const mcp = resolveAccountSettings(pluginConfig, accountId);
        const accountLog = (message) => log(`[${accountId}] ${message}`);
        accountLog(`filament: transport ${mcp.transport}`);
        const control = isControlAccount(pluginConfig, accountId);
        const pending = !control && isPendingAccount(pluginConfig, accountId);
        const handlesOwnWork = control || pending;
        const liveGatewayConfig = () => api.runtime?.config?.current?.() ?? ctx.cfg;
        const statuses = [];
        const reportInventory = async () => {
          if (!connection) return;
          const agents = listGatewayAgents(
            liveGatewayConfig(),
            (id) => getFilamentClient(id) ? loadIdentity(id)?.mxid : void 0
          );
          const status = await connection.client.reportTools(inventoryEntries(agents, statuses), {
            signal: abortSignal
          });
          accountLog(`filament-gateway: reported ${agents.length} agent(s) (HTTP ${status})`);
        };
        const mutateConfig = async (mutate) => {
          await writeGatewayConfig(mutate);
        };
        const handleControl = async (item) => {
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
                { signal: abortSignal }
              );
            },
            mutateConfig,
            report: async (entries) => {
              statuses.unshift(...[...entries].reverse());
              statuses.splice(MAX_REPORTED_STATUSES);
              await reportInventory();
            },
            log: accountLog
          });
        };
        const pendingOptions = () => choiceOptions(listGatewayAgents(liveGatewayConfig()));
        const bindPending = async (agentId, label) => {
          let bound = false;
          leaveGreeting(agentId, greetingBody(label));
          try {
            await mutateConfig((draft) => {
              bound = applyPendingChoice(draft, accountId, agentId, token);
            });
          } finally {
            if (!bound) takeGreeting(agentId);
          }
          if (!bound) return "taken";
          const wait = await awaitConfigApplied({
            applied: () => !isPendingAccount(pluginConfigOf(liveGatewayConfig()), accountId),
            abortSignal
          });
          return wait === "timeout" ? "written" : "applied";
        };
        const sayToPrincipal = async (markdownBody) => {
          if (!connection) return false;
          const res = await connection.client.callTool(
            "message_principal",
            { markdown_body: markdownBody },
            { signal: abortSignal }
          );
          if (!res.ok) accountLog(`filament-choose: message failed (${res.error?.message ?? "?"})`);
          return res.ok;
        };
        const handleCommand = async (item) => {
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
                { signal: abortSignal }
              );
            },
            mutateConfig,
            report: async (entries) => {
              const lines = entries.map(
                (status) => status.state === "applied" ? status.command === "connect" && status.agentId === void 0 ? "Connecting a new Filament agent to this gateway. It will ask in its own chat which OpenClaw agent should answer as it." : `Applied: ${status.command}${status.agentId ? ` ${status.agentId}` : ""}.` : `Couldn't ${status.command}: ${status.message ?? status.state}`
              );
              if (lines.length > 0) await sayToPrincipal(lines.join("\n"));
            },
            log: accountLog
          });
        };
        const handlePending = async (item) => {
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
                { signal: abortSignal }
              );
            },
            say: async (body) => {
              await sayToPrincipal(body);
            },
            bind: bindPending,
            refreshOptions: pendingOptions,
            log: accountLog
          });
        };
        const startPending = async () => {
          const options = pendingOptions();
          const chosen = automaticChoice(options);
          if (chosen) {
            accountLog(`filament-choose: the gateway's only agent is '${chosen}'; binding it`);
            const label = options.find((option) => option.agentId === chosen).label;
            if (await bindPending(chosen, label) === "written") {
              accountLog("filament-choose: the gateway did not reload after the bind");
              await sayToPrincipal(notAppliedBody(label));
            }
          } else if (choiceAsked(accountId)) {
            return;
          } else if (freeOptions(options).length === 0) {
            accountLog("filament-choose: this gateway has no free agent to bind");
            if (await sayToPrincipal(nothingFreeBody(options))) markChoiceAsked(accountId);
          } else if (await sayToPrincipal(questionBody(options))) {
            markChoiceAsked(accountId);
          }
        };
        const runTurn = async (item) => {
          if (!ctx.channelRuntime) {
            throw new Error("ctx.channelRuntime unavailable; cannot wake a turn");
          }
          const identity = loadIdentity(accountId);
          beginFilamentTurn(item.is_backchannel === true, accountId);
          let repliedTo = /* @__PURE__ */ new Set();
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
              log: accountLog
            });
          } finally {
            repliedTo = endFilamentTurn(accountId);
          }
          return { ...result, repliedTo };
        };
        let token = "";
        if (mcp.tokenInput !== void 0) {
          const resolved = await resolveConfiguredSecretInputString({
            // oxlint-disable-next-line typescript/no-explicit-any
            config: api.config,
            env: process.env,
            value: mcp.tokenInput,
            path: connectTokenConfigPath(PLUGIN_ID, accountId, pluginConfig)
          });
          token = resolved.value ?? "";
          if (!token) {
            accountLog(
              `filament: connect token did not resolve${resolved.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : ""}`
            );
          }
        }
        if (token) {
          try {
            connection = await retryConnect(
              () => runConnect({
                mcpUrl: mcp.mcpUrl,
                token,
                accountId,
                log: accountLog,
                abortSignal
              }),
              { log: accountLog, abortSignal }
            );
            onConnectionChange(connection);
          } catch (error) {
            accountLog(`filament: connect failed: ${String(error)}`);
            connection = null;
          }
        } else {
          accountLog(
            "filament: no connect token configured; channel idle (set config.accounts.<id>.connectToken)"
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
          const greeting = takeGreeting(accountId);
          if (greeting && !await sayToPrincipal(greeting)) {
            accountLog("filament-choose: could not greet as the bound agent");
          }
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
            ...handlesOwnWork ? {} : { handleCommand }
          });
          if (fatal) {
            accountLog(`filament: account entering a fatal/paused state: ${fatal}`);
            ctx.setStatus?.({
              accountId,
              connected: false,
              statusState: "error",
              restartPending: false
            });
          }
          setFilamentClient(null, accountId);
        }
        if (!abortSignal.aborted) {
          await new Promise((resolve) => {
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
      stopAccount: async (ctx) => {
        setFilamentClient(null, ctx?.accountId ?? DEFAULT_ACCOUNT_ID);
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
