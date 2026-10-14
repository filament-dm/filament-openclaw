import { createInboundEnvelopeBuilder } from "openclaw/plugin-sdk/inbound-envelope";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import {
  buildChannelInboundMediaPayload,
  runPreparedInboundReply,
  toInboundMediaFacts
} from "openclaw/plugin-sdk/channel-inbound";
import {
  normalizeOutboundReplyPayload,
  resolveOutboundMediaUrls
} from "openclaw/plugin-sdk/reply-payload";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
function inboundMediaFields(media) {
  if (!media?.length) return {};
  const facts = toInboundMediaFacts(media);
  return { media: facts, ...buildChannelInboundMediaPayload(facts) };
}
function inboundMessageFields(messages) {
  const current = messages[messages.length - 1];
  return {
    body: current?.body ?? "",
    current,
    history: messages.slice(0, -1).map((m) => ({
      sender: m.sender,
      body: m.body,
      timestamp: m.ts,
      messageId: m.event_id
    }))
  };
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
  const childKey = params.sideSession ?? params.threadId;
  const sessionKey = childKey ? resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    threadId: childKey,
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
  const { body: rawBody, current: lastMessage, history } = inboundMessageFields(params.messages);
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
    ...params.groupSubject && params.peerKind === "group" ? { GroupSubject: params.groupSubject } : {},
    SenderId: lastMessage?.sender ?? "unknown",
    ...lastMessage ? { Timestamp: lastMessage.ts } : {},
    ...history.length > 0 ? { InboundHistory: history } : {},
    Provider: params.channel,
    Surface: params.channel,
    MessageSid: lastMessage?.event_id ?? params.channelId,
    MessageSidFull: lastMessage?.event_id ?? params.channelId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.channelId,
    CommandAuthorized: params.commandAuthorized,
    // The gateway, not the principal, wrote a side session's prompt.
    ...params.sideSession ? {
      InputProvenance: {
        kind: "internal_system",
        sourceTool: `filament:${params.sideSession}`
      }
    } : {},
    // Despite the name, the gateway adds this to the system prompt of direct turns too.
    ...params.systemPrompt ? { GroupSystemPrompt: params.systemPrompt } : {},
    ...inboundMediaFields(params.media)
  });
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: effectiveRoute.agentId,
    channel: params.channel,
    accountId
  });
  const finals = [];
  const mediaUrls = [];
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
        // Only "final" text is collected; "tool" and "block" callbacks are intermediate.
        deliver: async (payload, info) => {
          if (info?.kind !== "final") return;
          const normalized = payload && typeof payload === "object" ? normalizeOutboundReplyPayload(payload) : {};
          const text = normalized.text;
          if (typeof text === "string" && text.trim()) finals.push(text);
          mediaUrls.push(...resolveOutboundMediaUrls(normalized));
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
    mediaUrls,
    agentId: effectiveRoute.agentId,
    sawFinal: finals.length > 0 || mediaUrls.length > 0,
    sawSkip,
    sawError,
    errorDetail
  };
}
export {
  dispatchWorkItemTurn,
  inboundMessageFields
};
