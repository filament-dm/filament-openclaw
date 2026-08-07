import { runPreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { normalizeOutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
async function dispatchInboundGroupTurn(params) {
  const runtime = params.channelRuntime;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: { kind: "group", id: params.roomId },
    runtime,
    sessionStore: params.cfg.session?.store
  });
  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody
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
    OriginatingTo: params.roomId
  });
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId
  });
  await runPreparedInboundReply({
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.session.recordInboundSession,
    record: { onRecordError: (error) => params.log(`record error (continuing): ${String(error)}`) },
    runDispatch: async () => await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: params.cfg,
      dispatcherOptions: {
        ...replyPipeline,
        deliver: async (payload) => {
          const normalized = payload && typeof payload === "object" ? normalizeOutboundReplyPayload(payload) : {};
          return await params.deliver(normalized);
        },
        // oxlint-disable-next-line typescript/no-explicit-any
        onError: (error, info) => params.log(`dispatch error (${info?.kind ?? "?"}): ${String(error)}`)
      },
      replyOptions: { onModelSelected }
    })
  });
  return route.sessionKey;
}
export {
  dispatchInboundGroupTurn
};
//# sourceMappingURL=inbound-dispatch.js.map
