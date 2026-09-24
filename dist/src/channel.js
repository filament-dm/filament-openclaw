import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  listConfiguredAccountIds,
  PLUGIN_ID,
  pluginConfigFrom
} from "./accounts.js";
import {
  connectTokenConfigPath,
  resolveAccountSettings,
  runConnect
} from "./connect.js";
import {
  beginFilamentTurn,
  checkFilamentToolDrift,
  endFilamentTurn,
  getFilamentClient,
  registerFilamentToolsFromSnapshot,
  setFilamentClient
} from "./filament-tools.js";
import { dispatchWorkItemTurn } from "./inbound-dispatch.js";
import { runPollLoop } from "./poll-work.js";
import { loadIdentity } from "./token-store.js";
function publishSucceeded(data) {
  if (!data || typeof data !== "object") return false;
  const d = data;
  return typeof d.event_id === "string" && d.event_id.length > 0 && d.error === void 0;
}
const ALREADY_ANSWERED_PREFIX = "You have already answered this message";
function isAlreadyAnsweredError(data) {
  if (!data || typeof data !== "object") return false;
  const err = data.error;
  return typeof err === "string" && err.startsWith(ALREADY_ANSWERED_PREFIX);
}
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
      blurb: "Connects the agent to Filament via the poll_work MCP transport"
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
        const dispatchItem = async (item) => {
          const replyWith = item.reply_with;
          if (!replyWith) {
            return { kind: "ambiguous" };
          }
          if (!connection) {
            return { kind: "error", diagnostic: "item arrived before connect finished" };
          }
          if (!ctx.channelRuntime) {
            return {
              kind: "error",
              diagnostic: "ctx.channelRuntime unavailable; cannot wake a turn"
            };
          }
          const identity = loadIdentity(accountId);
          let result;
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
              log: accountLog
            });
          } catch (error) {
            return { kind: "error", diagnostic: `dispatch threw: ${String(error)}` };
          } finally {
            endFilamentTurn(accountId);
          }
          if (result.sawError) {
            return {
              kind: "error",
              diagnostic: result.errorDetail ?? "dispatch reported an error"
            };
          }
          if (result.sawFinal) {
            if (abortSignal.aborted) {
              return { kind: "error", diagnostic: "aborted before publish" };
            }
            const publishRes = await connection.client.replyWith(replyWith, result.finalText, {
              signal: abortSignal
            });
            if (publishRes.ok && isAlreadyAnsweredError(publishRes.data)) {
              accountLog("filament: item already answered by a tool call; skipping publish");
              return { kind: "published" };
            }
            if (!publishRes.ok || !publishSucceeded(publishRes.data)) {
              return {
                kind: "error",
                diagnostic: `publish failed/ambiguous (${publishRes.kind ?? "?"}: ${publishRes.error?.message ?? "no event_id"})`
              };
            }
            accountLog(`filament: reply published to ${item.channel_id} via ${replyWith.tool}`);
            return { kind: "published" };
          }
          if (result.sawSkip) {
            return { kind: "silent" };
          }
          accountLog(
            `filament: turn produced no text and no explicit skip signal for ${item.channel_id}; leaving unacknowledged`
          );
          return { kind: "ambiguous" };
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
              abortSignal
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
        if (connection) {
          setFilamentClient(connection.client, accountId);
          void checkFilamentToolDrift(connection.client, accountLog).catch((error) => {
            accountLog(`filament: tool drift check failed: ${String(error)}`);
          });
          const { fatal } = await runPollLoop({
            client: connection.client,
            abortSignal,
            log: accountLog,
            dispatchItem,
            waitSeconds: mcp.pollWaitSeconds
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
