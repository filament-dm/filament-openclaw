/**
 * The Filament channel. Per account: connect, run the transport the settings pick (`fcm` by
 * default, or `poll`) until it stops, then hold the account open until the gateway aborts it.
 */
// `media-local-roots` is the newer home of this helper, but the SDK this builds against predates it.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/agent-media-payload";
import { resolveAgentAvatar, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  listConfiguredAccountIds,
  PLUGIN_ID,
  pluginConfigFrom,
  retiredAccountKind,
} from "./accounts.js";
import { otherCommandBody, parseBackchannelCommand } from "./commands.js";
import { writeGatewayConfig } from "./config-write.js";
import { BearerRejectedError, type ConnectHandle, retryConnect, runConnect } from "./connect.js";
import { type InboundMedia, type OutboundAttachment, uploadOutboundMedia } from "./media.js";
import { sendToFilament, waitForClient } from "./outbound.js";
import { clearAllInterrupted, interruptedIn } from "./state/in-flight.js";
import { signedMediaOffered, turnInstructions } from "./onboarding-core.js";
import {
  beginFilamentTurn,
  checkFilamentToolDrift,
  endFilamentTurn,
  getFilamentClient,
  registerFilamentToolsFromSnapshot,
  setFilamentClient,
  type FilamentToolsApi,
} from "./filament-tools.js";
import { connectTokenConfigPath, resolveAccountSettings, type Transport } from "./settings.js";
import { listGatewayAgents } from "./gateway.js";
import { createRoomLabels } from "./room-labels.js";
import { HELLO_SIDE_SESSION, helloDue, sayFirstHello } from "./hello.js";
import {
  parseIdentityMarkdown,
  seedName,
  seedProfile,
  type AvatarSource,
  type SeedClient,
  type SeedResult,
} from "./profile-seed.js";
import { finishPendingSignIn, parsePendingSignIn } from "./sign-in.js";
import { loadIdentity } from "./state/identities.js";
import {
  loadUpdateState,
  markUpdateRequested,
  saveUpdateState,
  takeUpdateRequest,
} from "./state/updates.js";
import { helloSentAs, markHelloSent } from "./state/hello.js";
import { clearRevoked, clearSignInEnd, markRevoked, saveSignInEnd } from "./state/sign-in.js";
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
import { turnPeerKind, type WorkItem } from "./work-item.js";

export { FILAMENT_CHANNEL_ID };

const TRANSPORTS: Record<Transport, RunTransport> = {
  fcm: runFcmTransport,
  poll: runPollTransport,
};

// Structural: the concrete OpenClaw SDK types only resolve inside the gateway.
export interface FilamentChannelApi extends FilamentToolsApi {
  config: unknown;
  pluginConfig?: unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  registerChannel: (registration: { plugin: ChannelPlugin }) => void;
  /** Plugin hooks; absent from older gateways. */
  on?: (
    hookName: string,
    handler: (event: unknown, ctx: { channel?: string; messageProvider?: string }) => void,
  ) => void;
  runtime?: {
    config?: {
      current?: () => unknown;
    };
  };
}

/** The OpenClaw agent an account answers as: its binding, or the agent its id names. */
function boundAgentOf(gatewayConfig: unknown, accountId: string): string | undefined {
  const agents = listGatewayAgents(gatewayConfig);
  return (
    agents.find((agent) => agent.boundAccount === accountId)?.id ??
    agents.find((agent) => agent.id === accountId)?.id
  );
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

  const liveConfig = (): unknown => api.runtime?.config?.current?.() ?? api.config;

  const seedFromOpenClaw = async (
    client: SeedClient,
    accountId: string,
    accountLog: (message: string) => void,
    signal: AbortSignal,
  ): Promise<SeedResult | null> => {
    const cfg = liveConfig();
    const agentId = boundAgentOf(cfg, accountId);
    if (!agentId) return null;
    // oxlint-disable-next-line typescript/no-explicit-any
    const sdkConfig = cfg as any;
    let identityFile: { name?: string } | undefined;
    try {
      const workspace = resolveAgentWorkspaceDir(sdkConfig, agentId);
      identityFile = parseIdentityMarkdown(readFileSync(join(workspace, "IDENTITY.md"), "utf8"));
    } catch {
      identityFile = undefined;
    }
    let avatar: AvatarSource = { kind: "none" };
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
      signal,
    });
  };

  // A Filament run that ends while a restart's turns are held is OpenClaw's recovery: end the hold.
  try {
    api.on?.("agent_end", (_event, hookCtx) => {
      if (
        hookCtx?.channel === FILAMENT_CHANNEL_ID ||
        hookCtx?.messageProvider === FILAMENT_CHANNEL_ID
      ) {
        clearAllInterrupted();
      }
    });
  } catch (error) {
    log(`filament: could not watch for restart recovery: ${String(error)}`);
  }

  // Before any connection exists: a session can resolve its toolset before connect finishes.
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);

  // OpenClaw sending to Filament outside a dispatched turn, e.g. a restart-recovered answer.
  // oxlint-disable-next-line typescript/no-explicit-any
  const deliverOutbound = async (ctx: any, mediaUrl?: string) => {
    const accountId: string = ctx?.accountId ?? DEFAULT_ACCOUNT_ID;
    const client = await waitForClient(() => getFilamentClient(accountId));
    let attachments: OutboundAttachment[] = [];
    if (mediaUrl && "uploadMedia" in client) {
      attachments = await uploadOutboundMedia(
        client as unknown as Parameters<typeof uploadOutboundMedia>[0],
        [mediaUrl],
        { mediaLocalRoots: ctx?.mediaLocalRoots ?? [], log: (m) => log(`[${accountId}] ${m}`) },
      );
    }
    const text = typeof ctx?.text === "string" ? ctx.text : "";
    if (!text.trim() && attachments.length === 0) {
      throw new Error("filament: nothing to send (no text, and the media could not be uploaded)");
    }
    const to = String(ctx?.to ?? "");
    // OpenClaw's recovery names no message: answer the interrupted one, which finishes its item.
    const interrupted = interruptedIn(accountId, to).at(-1)?.eventId;
    const sent = await sendToFilament(client, {
      to,
      text,
      replyToId: ctx?.replyToId ?? interrupted,
      threadId: ctx?.threadId,
      attachments,
    });
    log(`[${accountId}] filament: sent an out-of-turn message to ${sent.roomId}`);

    return {
      channel: FILAMENT_CHANNEL_ID,
      messageId: sent.messageId,
      roomId: sent.roomId,
      chatId: sent.roomId,
    };
  };

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
        const holdOpen = async (): Promise<void> => {
          if (abortSignal.aborted) return;
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) return resolve();
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        };

        const retired = retiredAccountKind(pluginConfig, accountId);
        if (retired) {
          // Held open, not run: the gateway restarts an account that exits.
          accountLog(
            `filament: ${retired === "control" ? "gateway control" : "agent-choice"} accounts are gone; this one stays idle. Remove accounts.${accountId} and connect the agent with \`openclaw filament login\``,
          );
          await holdOpen();
          return;
        }
        accountLog(`filament: transport ${mcp.transport}`);

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
          if (!res.ok)
            accountLog(`filament: message to the principal failed (${res.error?.message ?? "?"})`);
          return res.ok;
        };
        // The principal's `/filament` lines are answered here, never by the agent (commands.ts).
        const handleCommand = async (item: WorkItem): Promise<void> => {
          if (!connection) return;
          const last = item.messages[item.messages.length - 1];
          const command = last ? parseBackchannelCommand(last.body) : null;
          if (!last || !command) return;
          // Consume first: an update reloads the plugin, and an unread command would come back.
          await connection.client
            .callTool(
              "mark_read",
              { channel: item.channel_id, up_to: last.event_id },
              { signal: abortSignal },
            )
            .catch((error) =>
              accountLog(`filament: could not mark the command read: ${String(error)}`),
            );
          if (command.kind === "update") {
            accountLog("filament-update: update requested by the principal");
            await runUpdate();
          } else {
            await sayToPrincipal(otherCommandBody(command.verb));
          }
        };

        let roomLabels: ReturnType<typeof createRoomLabels> | undefined;
        const runTurn = async (
          item: WorkItem,
          media?: InboundMedia[],
          opts?: { sideSession?: string },
        ): Promise<TurnResult> => {
          if (!ctx.channelRuntime) {
            throw new Error("ctx.channelRuntime unavailable; cannot wake a turn");
          }
          const identity = loadIdentity(accountId);
          const room = connection
            ? await (roomLabels ??= createRoomLabels(
                connection.client,
                connection.identity,
                accountLog,
              ))(item.channel_id, abortSignal, item)
            : { label: item.channel_id };
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
              peerKind: turnPeerKind(item),
              sideSession: opts?.sideSession,
              channelId: item.channel_id,
              threadId: item.thread_id,
              messages: item.messages,
              media,
              systemPrompt: turnInstructions(connection?.client.instructions, {
                signedMedia: signedMediaOffered(connection?.client.toolNames),
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

        const pendingSignIn = token
          ? undefined
          : parsePendingSignIn(
              asRecord(asRecord(asRecord(pluginConfig).accounts)[accountId]).pendingSignIn,
            );

        // Read before connecting, which overwrites it: a new Filament agent here says hello.
        const previousMxid = token ? loadIdentity(accountId)?.mxid : undefined;

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
            clearRevoked(accountId);
          } catch (error) {
            accountLog(`filament: connect failed: ${String(error)}`);
            // Kept for `openclaw filament status`: the agent was deleted or its token revoked.
            if (error instanceof BearerRejectedError) markRevoked(accountId, token);
            connection = null;
          }
        } else if (pendingSignIn) {
          // `openclaw filament login` left the sign-in to the gateway; saving the token reloads
          // this account, connected.
          const outcome = await finishPendingSignIn({
            accountId,
            pending: pendingSignIn,
            abortSignal,
            log: accountLog,
            writeConfig: writeGatewayConfig,
            saveEnd: saveSignInEnd,
            clearEnd: clearSignInEnd,
          });
          if (outcome === "signed-in") {
            accountLog("filament: sign-in saved; the gateway reloads this account to connect it");
          }
        } else {
          accountLog(
            "filament: no connect token configured; channel idle (set config.accounts.<id>.connectToken)",
          );
        }

        if (connection) {
          const { mxid } = connection.identity;
          if (
            helloDue({
              instructions: connection.client.instructions,
              mxid,
              previousMxid,
              helloSentAs: helloSentAs(accountId),
            })
          ) {
            // The new agent takes its OpenClaw agent's name and avatar before it says hello.
            const seeded = await seedFromOpenClaw(
              connection.client,
              accountId,
              accountLog,
              abortSignal,
            );
            // Before the transport starts: a turn's reply tracking is one per account.
            setFilamentClient(connection.client, accountId);
            const hello = await sayFirstHello({
              identity: connection.identity,
              runTurn: (item) => runTurn(item, undefined, { sideSession: HELLO_SIDE_SESSION }),
              say: sayToPrincipal,
              log: accountLog,
              filamentName: seeded?.name,
            }).catch((error) => {
              accountLog(`filament-hello: ${String(error)}`);
              return "failed" as const;
            });
            if (hello !== "failed" && hello !== "skipped") markHelloSent(accountId, mxid);
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
            handleCommand,
          });
          if (fatal) {
            // Report and hold open rather than throw: the gateway restarts an account that
            // exits, which would re-run a transport that just asked to stop.
            accountLog(`filament: account entering a fatal/paused state: ${fatal}`);
            if (fatal.startsWith("auth:")) markRevoked(accountId, token);
            // The account no longer receives work: stop the heartbeat so Filament shows it offline.
            connection.stop();
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
        await holdOpen();

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
    outbound: {
      deliveryMode: "direct",
      // oxlint-disable-next-line typescript/no-explicit-any
      sendText: async (ctx: any) => deliverOutbound(ctx),
      // oxlint-disable-next-line typescript/no-explicit-any
      sendMedia: async (ctx: any) => deliverOutbound(ctx, ctx?.mediaUrl),
    },
  };

  try {
    api.registerChannel({ plugin });
    log(`filament: registered channel '${FILAMENT_CHANNEL_ID}'`);
  } catch (error) {
    log(`filament: registerChannel threw → ${String(error)}`);
  }
}
