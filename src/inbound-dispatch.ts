/**
 * Group/channel inbound-turn dispatch for the Filament channel.
 *
 * OpenClaw's plugin SDK ships a one-call facade only for DIRECT messages
 * (`dispatchInboundDirectDmWithRuntime`, used for the backchannel). Group/channel
 * messages have no such facade, so this mirrors that facade's composition —
 * route → envelope → context → reply pipeline → prepared reply → buffered
 * dispatcher — but with `ChatType: "group"` and a `kind: "group"` peer, so a
 * Filament channel message routes to a *per-channel* session
 * (`agent:…:filament:group:<roomId>`) instead of being forced through the DM
 * path (which, under the default dmScope, collapses every room to the single
 * `agent:main:main` session and bleeds context across channels).
 *
 * All primitives below are exported from `openclaw/plugin-sdk/*`; this is kept
 * faithful to the SDK's own `src/channels/direct-dm.ts` at the pinned version.
 */
import { runPreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { normalizeOutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";

export interface DispatchInboundGroupParams {
  // The channelRuntime surface + gateway config from the channel's startAccount ctx.
  // oxlint-disable-next-line typescript/no-explicit-any
  cfg: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  channelRuntime: any;
  channel: string;
  channelLabel: string;
  accountId: string;
  /** The group/room id — becomes the per-channel session peer. */
  roomId: string;
  senderId: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  /** Receives the agent's normalized reply payload (`{ text, … }`). */
  deliver: (payload: Record<string, unknown>) => Promise<void>;
  log: (message: string) => void;
}

/** Route + wake a turn for a group/channel message; returns the session key. */
export async function dispatchInboundGroupTurn(
  params: DispatchInboundGroupParams,
): Promise<string | undefined> {
  const runtime = params.channelRuntime;

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: { kind: "group", id: params.roomId },
    runtime,
    sessionStore: params.cfg.session?.store,
  });

  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
  });

  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.rawBody,
    From: params.senderId,
    To: params.recipientAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.accountId,
    ChatType: "group",
    ConversationLabel: params.conversationLabel,
    SenderId: params.senderId,
    Provider: params.channel,
    Surface: params.channel,
    MessageSid: params.messageId,
    MessageSidFull: params.messageId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.roomId,
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
  });

  await runPreparedInboundReply({
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.session.recordInboundSession,
    record: { onRecordError: (error: unknown) => params.log(`record error (continuing): ${String(error)}`) },
    runDispatch: async () =>
      await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: params.cfg,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload: unknown) => {
            const normalized =
              payload && typeof payload === "object"
                ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
                : {};
            return await params.deliver(normalized as Record<string, unknown>);
          },
          // oxlint-disable-next-line typescript/no-explicit-any
          onError: (error: unknown, info: any) =>
            params.log(`dispatch error (${info?.kind ?? "?"}): ${String(error)}`),
        },
        replyOptions: { onModelSelected },
      }),
  });

  return route.sessionKey;
}
