import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/agent-media-payload";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  listConfiguredAccountIds,
  PLUGIN_ID,
  pluginConfigFrom,
  retiredAccountKind
} from "./accounts.js";
import { otherCommandBody, parseBackchannelCommand } from "./commands.js";
import { writeGatewayConfig } from "./config-write.js";
import { retryConnect, runConnect } from "./connect.js";
import { turnInstructions } from "./onboarding-core.js";
import {
  beginFilamentTurn,
  checkFilamentToolDrift,
  endFilamentTurn,
  getFilamentClient,
  registerFilamentToolsFromSnapshot,
  setFilamentClient
} from "./filament-tools.js";
import { connectTokenConfigPath, resolveAccountSettings } from "./settings.js";
import { helloDue, sayFirstHello } from "./hello.js";
import { finishPendingSignIn, parsePendingSignIn } from "./sign-in.js";
import { loadIdentity } from "./state/identities.js";
import {
  loadUpdateState,
  markUpdateRequested,
  saveUpdateState,
  takeUpdateRequest
} from "./state/updates.js";
import { helloSentAs, markHelloSent } from "./state/hello.js";
import { clearSignInEnd, saveSignInEnd } from "./state/sign-in.js";
import { runFcmTransport } from "./transports/fcm/index.js";
import { runPollTransport } from "./transports/poll/index.js";
import { dispatchWorkItemTurn } from "./turn.js";
import {
  runUpdateChecks,
  startPluginUpdate,
  updatedBody,
  updateFailureMessage
} from "./update-check.js";
import { PLUGIN_VERSION } from "./version.js";
const TRANSPORTS = {
  fcm: runFcmTransport,
  poll: runPollTransport
};
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
        const holdOpen = async () => {
          if (abortSignal.aborted) return;
          await new Promise((resolve) => {
            if (abortSignal.aborted) return resolve();
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        };
        const retired = retiredAccountKind(pluginConfig, accountId);
        if (retired) {
          accountLog(
            `filament: ${retired === "control" ? "gateway control" : "agent-choice"} accounts are gone; this one stays idle. Remove accounts.${accountId} and connect the agent with \`openclaw filament login\``
          );
          await holdOpen();
          return;
        }
        accountLog(`filament: transport ${mcp.transport}`);
        let updateInFlight = false;
        const runUpdate = async () => {
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
              sayToPrincipal(`Couldn't update the plugin: ${message}`).catch(() => {
              });
            }
          });
        };
        const sayToPrincipal = async (markdownBody) => {
          if (!connection) return false;
          const res = await connection.client.callTool(
            "message_principal",
            { markdown_body: markdownBody },
            { signal: abortSignal }
          );
          if (!res.ok)
            accountLog(`filament: message to the principal failed (${res.error?.message ?? "?"})`);
          return res.ok;
        };
        const handleCommand = async (item) => {
          if (!connection) return;
          const last = item.messages[item.messages.length - 1];
          const command = last ? parseBackchannelCommand(last.body) : null;
          if (!last || !command) return;
          await connection.client.callTool(
            "mark_read",
            { channel: item.channel_id, up_to: last.event_id },
            { signal: abortSignal }
          ).catch(
            (error) => accountLog(`filament: could not mark the command read: ${String(error)}`)
          );
          if (command.kind === "update") {
            accountLog("filament-update: update requested by the principal");
            await runUpdate();
          } else {
            await sayToPrincipal(otherCommandBody(command.verb));
          }
        };
        const runTurn = async (item, media) => {
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
              media,
              systemPrompt: turnInstructions(connection?.client.instructions),
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
          return {
            ...result,
            repliedTo,
            mediaLocalRoots: getAgentScopedMediaLocalRoots(ctx.cfg, result.agentId)
          };
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
        const pendingSignIn = token ? void 0 : parsePendingSignIn(
          asRecord(asRecord(asRecord(pluginConfig).accounts)[accountId]).pendingSignIn
        );
        const previousMxid = token ? loadIdentity(accountId)?.mxid : void 0;
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
        } else if (pendingSignIn) {
          const outcome = await finishPendingSignIn({
            accountId,
            pending: pendingSignIn,
            abortSignal,
            log: accountLog,
            writeConfig: writeGatewayConfig,
            saveEnd: saveSignInEnd,
            clearEnd: clearSignInEnd
          });
          if (outcome === "signed-in") {
            accountLog("filament: sign-in saved; the gateway reloads this account to connect it");
          }
        } else {
          accountLog(
            "filament: no connect token configured; channel idle (set config.accounts.<id>.connectToken)"
          );
        }
        if (connection) {
          const { mxid } = connection.identity;
          if (helloDue({
            instructions: connection.client.instructions,
            mxid,
            previousMxid,
            helloSentAs: helloSentAs(accountId)
          })) {
            setFilamentClient(connection.client, accountId);
            const hello = await sayFirstHello({
              identity: connection.identity,
              runTurn: (item) => runTurn(item),
              say: sayToPrincipal,
              log: accountLog
            }).catch((error) => {
              accountLog(`filament-hello: ${String(error)}`);
              return "failed";
            });
            if (hello !== "failed" && hello !== "skipped") markHelloSent(accountId, mxid);
          }
          const updateRequest = takeUpdateRequest(accountId);
          if (updateRequest) {
            accountLog(
              `filament-update: back on v${PLUGIN_VERSION} (was v${updateRequest.fromVersion})`
            );
            if (!await sayToPrincipal(updatedBody(updateRequest.fromVersion, PLUGIN_VERSION))) {
              accountLog("filament-update: could not report the update; will retry on connect");
              markUpdateRequested(accountId, updateRequest.fromVersion);
            }
          }
          void runUpdateChecks(
            { load: loadUpdateState, save: saveUpdateState, say: sayToPrincipal, log: accountLog },
            abortSignal
          ).catch((error) => {
            accountLog(`filament-update: checks stopped: ${String(error)}`);
          });
          setFilamentClient(connection.client, accountId);
          void checkFilamentToolDrift(connection.client, accountLog).catch((error) => {
            accountLog(`filament: tool drift check failed: ${String(error)}`);
          });
          const { fatal } = await TRANSPORTS[mcp.transport]({
            accountId,
            client: connection.client,
            identity: connection.identity,
            settings: mcp,
            abortSignal,
            log: accountLog,
            runTurn,
            handleCommand
          });
          if (fatal) {
            accountLog(`filament: account entering a fatal/paused state: ${fatal}`);
            connection.stop();
            ctx.setStatus?.({
              accountId,
              connected: false,
              statusState: "error",
              restartPending: false
            });
          }
          setFilamentClient(null, accountId);
        }
        await holdOpen();
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
