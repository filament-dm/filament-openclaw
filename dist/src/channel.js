import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  isControlAccount,
  listConfiguredAccountIds,
  PLUGIN_ID,
  pluginConfigFrom
} from "./accounts.js";
import { runConnect } from "./connect.js";
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
import { loadIdentity } from "./token-store.js";
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
      // One account per Filament agent: `config.accounts.<id>`, plus the
      // legacy top-level token as `default` (src/accounts.ts).
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
            log: accountLog
          });
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
              // Filament (not OpenClaw) decides who can reach the agent; this
              // only ever authorizes the backchannel/control-plane item, never
              // an arbitrary conversation (see the plan's item 5).
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
            connection = await runConnect({
              mcpUrl: mcp.mcpUrl,
              token,
              accountId,
              log: accountLog,
              abortSignal,
              // Poll needs an ENG-893 server anyway; FCM must work without one.
              credential: mcp.transport === "poll" ? "exchange" : "direct"
            });
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
        if (connection) {
          if (!control) setFilamentClient(connection.client, accountId);
          refreshOtherwise();
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
            handleControl
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
//# sourceMappingURL=channel.js.map
