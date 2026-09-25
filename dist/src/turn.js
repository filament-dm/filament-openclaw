import { createInboundEnvelopeBuilder } from "openclaw/plugin-sdk/inbound-envelope";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { runPreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { normalizeOutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
function renderMessages(messages) {
  return messages.map((m) => `[${m.sender} ${m.event_id}] ${m.body}`).join("\n");
}
async function dispatchWorkItemTurn(params) {
  const runtime = params.channelRuntime;
  const peer = { kind: params.peerKind, id: params.channelId };
  const route = runtime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer
  });
  const sessionKey = params.threadId ? resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    threadId: params.threadId,
    normalizeThreadId: (id) => id
  }).sessionKey : route.sessionKey;
  const effectiveRoute = { ...route, sessionKey };
  const accountId = effectiveRoute.accountId ?? params.accountId;
  const buildEnvelope = createInboundEnvelopeBuilder({
    cfg: params.cfg,
    route: effectiveRoute,
    sessionStore: params.cfg.session?.store,
    resolveStorePath: runtime.session.resolveStorePath,
    readSessionUpdatedAt: runtime.session.readSessionUpdatedAt,
    resolveEnvelopeFormatOptions: runtime.reply.resolveEnvelopeFormatOptions,
    formatAgentEnvelope: runtime.reply.formatAgentEnvelope
  });
  const rawBody = renderMessages(params.messages);
  const lastMessage = params.messages[params.messages.length - 1];
  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: rawBody
  });
  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: lastMessage?.sender ?? "unknown",
    To: params.recipientAddress,
    SessionKey: effectiveRoute.sessionKey,
    AccountId: accountId,
    ChatType: params.peerKind === "direct" ? "direct" : "group",
    ConversationLabel: params.conversationLabel,
    SenderId: lastMessage?.sender ?? "unknown",
    Provider: params.channel,
    Surface: params.channel,
    MessageSid: lastMessage?.event_id ?? params.channelId,
    MessageSidFull: lastMessage?.event_id ?? params.channelId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.channelId,
    CommandAuthorized: params.commandAuthorized
  });
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: effectiveRoute.agentId,
    channel: params.channel,
    accountId
  });
  const finals = [];
  let sawSkip = false;
  let sawError = false;
  let errorDetail;
  await runPreparedInboundReply({
    channel: params.channel,
    accountId,
    routeSessionKey: effectiveRoute.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.session.recordInboundSession,
    record: {
      onRecordError: (error) => params.log(`record error (continuing): ${String(error)}`)
    },
    runDispatch: async () => await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: params.cfg,
      dispatcherOptions: {
        ...replyPipeline,
        // `info.kind` is "tool" | "block" | "final" — only "final" text is
        // ever collected. Never publish here; just buffer.
        deliver: async (payload, info) => {
          if (info?.kind !== "final") return;
          const normalized = payload && typeof payload === "object" ? normalizeOutboundReplyPayload(payload) : {};
          const text = normalized.text;
          if (typeof text === "string" && text.trim()) finals.push(text);
        },
        onSkip: () => {
          sawSkip = true;
        },
        // oxlint-disable-next-line typescript/no-explicit-any
        onError: (error, info) => {
          sawError = true;
          errorDetail = `${info?.kind ?? "?"}: ${String(error)}`;
          params.log(`dispatch error (${info?.kind ?? "?"}): ${String(error)}`);
        }
      },
      replyOptions: { onModelSelected }
    })
  });
  return {
    finalText: finals.join("\n\n"),
    sawFinal: finals.length > 0,
    sawSkip,
    sawError,
    errorDetail
  };
}
export {
  dispatchWorkItemTurn
};
//# sourceMappingURL=turn.js.map
