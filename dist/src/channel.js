import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/agent-media-payload";
import { resolveAgentAvatar, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
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
import { ensureGroupSilenceAllowedOnce } from "./silent-reply-policy.js";
import { BearerRejectedError, retryConnect, runConnect } from "./connect.js";
import { uploadOutboundMedia } from "./media.js";
import { sendToFilament, waitForClient } from "./outbound.js";
import { interruptedIn, releaseInterruptedIn } from "./state/in-flight.js";
import { signedMediaOffered, turnInstructions } from "./onboarding-core.js";
import {
  beginFilamentTurn,
  checkFilamentToolDrift,
  endFilamentTurn,
  getFilamentClient,
  registerFilamentToolsFromSnapshot,
  setFilamentClient
} from "./filament-tools.js";
import { connectTokenConfigPath, resolveAccountSettings } from "./settings.js";
import { listGatewayAgents } from "./gateway.js";
import { createRoomLabels } from "./room-labels.js";
import { HELLO_SIDE_SESSION, helloDue, sayFirstHello } from "./hello.js";
import {
  parseIdentityMarkdown,
  seedName,
  seedProfile
} from "./profile-seed.js";
import { finishPendingSignIn, parsePendingSignIn } from "./sign-in.js";
import { loadIdentity } from "./state/identities.js";
import {
  loadUpdateState,
  markUpdateRequested,
  saveUpdateState,
  takeUpdateRequest
} from "./state/updates.js";
import { helloSentAs, markHelloSent } from "./state/hello.js";
import { clearRevoked, clearSignInEnd, markRevoked, saveSignInEnd } from "./state/sign-in.js";
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
import { turnPeerKind, turnWasMentioned } from "./work-item.js";
const RECOVERY_RELEASE_GRACE_MS = 5e3;
const TRANSPORTS = {
  fcm: runFcmTransport,
  poll: runPollTransport
};
function boundAgentOf(gatewayConfig, accountId) {
  const agents = listGatewayAgents(gatewayConfig);
  return agents.find((agent) => agent.boundAccount === accountId)?.id ?? agents.find((agent) => agent.id === accountId)?.id;
}
function registerFilamentChannel(api, onConnectionChange = () => {
}) {
  const log = (message) => {
    if (api.logger?.info) api.logger.info(message);
    else console.log(message);
  };
  const pluginConfigOf = (cfg) => pluginConfigFrom(cfg) ?? api.pluginConfig;
  const liveConfig = () => api.runtime?.config?.current?.() ?? api.config;
  const seedFromOpenClaw = async (client, accountId, accountLog, signal) => {
    const cfg = liveConfig();
    const agentId = boundAgentOf(cfg, accountId);
    if (!agentId) return null;
    const sdkConfig = cfg;
    let identityFile;
    try {
      const workspace = resolveAgentWorkspaceDir(sdkConfig, agentId);
      identityFile = parseIdentityMarkdown(readFileSync(join(workspace, "IDENTITY.md"), "utf8"));
    } catch {
      identityFile = void 0;
    }
    let avatar = { kind: "none" };
    try {
      avatar = resolveAgentAvatar(sdkConfig, agentId);
    } catch (error) {
      accountLog(`filament-profile: could not resolve the agent's avatar: ${String(error)}`);
    }
    return seedProfile({
      client,
      name: seedName(cfg, agentId, identityFile),
      avatar,
      readFile: async (path) => readFile(path),
      log: accountLog,
      signal
    });
  };
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const deliverOutbound = async (ctx, mediaUrl) => {
    const accountId = ctx?.accountId ?? DEFAULT_ACCOUNT_ID;
    const client = await waitForClient(() => getFilamentClient(accountId));
    let attachments = [];
    if (mediaUrl && "uploadMedia" in client) {
      attachments = await uploadOutboundMedia(
        client,
        [mediaUrl],
        { mediaLocalRoots: ctx?.mediaLocalRoots ?? [], log: (m) => log(`[${accountId}] ${m}`) }
      );
    }
    const text = typeof ctx?.text === "string" ? ctx.text : "";
    if (!text.trim() && attachments.length === 0) {
      throw new Error("filament: nothing to send (no text, and the media could not be uploaded)");
    }
    const to = String(ctx?.to ?? "");
    const interrupted = interruptedIn(accountId, to).at(-1)?.eventId;
    const sent = await sendToFilament(client, {
      to,
      text,
      replyToId: ctx?.replyToId ?? interrupted,
      threadId: ctx?.threadId,
      attachments
    });
    log(`[${accountId}] filament: sent an out-of-turn message to ${sent.roomId}`);
    if (interrupted) releaseInterruptedIn(accountId, to, Date.now() + RECOVERY_RELEASE_GRACE_MS);
    return {
      channel: FILAMENT_CHANNEL_ID,
      messageId: sent.messageId,
      roomId: sent.roomId,
      chatId: sent.roomId
    };
  };
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
        void ensureGroupSilenceAllowedOnce(log);
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
        let roomLabels;
        const runTurn = async (item, media, opts) => {
          if (!ctx.channelRuntime) {
            throw new Error("ctx.channelRuntime unavailable; cannot wake a turn");
          }
          const identity = loadIdentity(accountId);
          const room = connection ? await (roomLabels ??= createRoomLabels(
            connection.client,
            connection.identity,
            accountLog
          ))(item.channel_id, abortSignal, item) : { label: item.channel_id };
          beginFilamentTurn(item.is_backchannel === true, accountId);
          let toolOutcome = { repliedTo: /* @__PURE__ */ new Set(), reacted: false };
          let result;
          try {
            result = await dispatchWorkItemTurn({
              cfg: ctx.cfg,
              channelRuntime: ctx.channelRuntime,
              channel: FILAMENT_CHANNEL_ID,
              channelLabel: "Filament",
              accountId,
              peerKind: turnPeerKind(item),
              wasMentioned: turnWasMentioned(item),
              sideSession: opts?.sideSession,
              channelId: item.channel_id,
              threadId: item.thread_id,
              messages: item.messages,
              media,
              systemPrompt: turnInstructions(connection?.client.instructions, {
                signedMedia: signedMediaOffered(connection?.client.toolNames)
              }),
              recipientAddress: identity?.mxid ?? `${FILAMENT_CHANNEL_ID}:agent`,
              conversationLabel: room.label,
              groupSubject: room.subject,
              senderNames: item.sender_names,
              channelName: item.channel_name,
              loopName: item.loop_name,
              // Filament, not OpenClaw, decides who can reach the agent; only the
              // backchannel may run OpenClaw commands.
              commandAuthorized: item.is_backchannel === true,
              log: accountLog
            });
          } finally {
            toolOutcome = endFilamentTurn(accountId);
          }
          return {
            ...result,
            ...toolOutcome,
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
            clearRevoked(accountId);
          } catch (error) {
            accountLog(`filament: connect failed: ${String(error)}`);
            if (error instanceof BearerRejectedError) markRevoked(accountId, token);
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
            const seeded = await seedFromOpenClaw(
              connection.client,
              accountId,
              accountLog,
              abortSignal
            );
            setFilamentClient(connection.client, accountId);
            const hello = await sayFirstHello({
              identity: connection.identity,
              runTurn: (item) => runTurn(item, void 0, { sideSession: HELLO_SIDE_SESSION }),
              say: sayToPrincipal,
              log: accountLog,
              filamentName: seeded?.name
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
            if (fatal.startsWith("auth:")) markRevoked(accountId, token);
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
    },
    outbound: {
      deliveryMode: "direct",
      // oxlint-disable-next-line typescript/no-explicit-any
      sendText: async (ctx) => deliverOutbound(ctx),
      // oxlint-disable-next-line typescript/no-explicit-any
      sendMedia: async (ctx) => deliverOutbound(ctx, ctx?.mediaUrl)
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
  RECOVERY_RELEASE_GRACE_MS,
  registerFilamentChannel
};
