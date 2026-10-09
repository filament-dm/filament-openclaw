/**
 * Work item to agent turn, shared by both transports. Composes the SDK's route, envelope, context
 * and buffered-dispatch primitives for direct and group items alike, rather than
 * `dispatchInboundDirectDmWithRuntime`: that facade's `deliver` drops `info.kind`, so a final
 * reply can't be told apart from an intermediate block.
 */
import { createInboundEnvelopeBuilder } from "openclaw/plugin-sdk/inbound-envelope";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import {
  buildChannelInboundMediaPayload,
  runPreparedInboundReply,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  normalizeOutboundReplyPayload,
  resolveOutboundMediaUrls,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";

import type { InboundMedia } from "./media.js";
import type { WorkMessage } from "./work-item.js";

export interface DispatchWorkItemParams {
  // oxlint-disable-next-line typescript/no-explicit-any
  cfg: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  channelRuntime: any;
  channel: string;
  channelLabel: string;
  accountId: string;
  /** `"direct"` collapses to the agent's main session; `"group"` gets a per-channel session. */
  peerKind: "direct" | "group";
  channelId: string;
  threadId: string | null;
  messages: WorkMessage[];
  /** Attachments already saved for the turn (poll_work only). */
  media?: InboundMedia[];
  recipientAddress: string;
  conversationLabel: string;
  commandAuthorized: boolean;
  log: (message: string) => void;
}

export interface DispatchTurnResult {
  finalText: string;
  /** Media the final reply names: local paths or URLs, still to be loaded and uploaded. */
  mediaUrls: string[];
  /** The OpenClaw agent that ran the turn; scopes which local files its reply may send. */
  agentId: string;
  sawFinal: boolean;
  /** Deliberate silence, as opposed to a turn that produced nothing. */
  sawSkip: boolean;
  sawError: boolean;
  errorDetail?: string;
}

/**
 * Attachments for the inbound context, in both shapes: `media` is what current gateways read, and
 * the legacy `Media*` fields are all a gateway before 2026.9 reads (the plugin supports >=2026.7).
 */
function inboundMediaFields(media: InboundMedia[] | undefined): Record<string, unknown> {
  if (!media?.length) return {};
  const facts = toInboundMediaFacts(media);
  return { media: facts, ...buildChannelInboundMediaPayload(facts) };
}

function renderMessages(messages: WorkMessage[]): string {
  return messages.map((m) => `[${m.sender} ${m.event_id}] ${m.body}`).join("\n");
}

/** Never publishes: the transport publishes at most once after this resolves. */
export async function dispatchWorkItemTurn(
  params: DispatchWorkItemParams,
): Promise<DispatchTurnResult> {
  const runtime = params.channelRuntime;
  const peer = { kind: params.peerKind, id: params.channelId };

  // oxlint-disable-next-line typescript/no-explicit-any
  const route = runtime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer,
  }) as { agentId: string; sessionKey: string; accountId?: string };

  // Thread isolation: two threads in the same channel must not share a
  // session. `normalizeThreadId` is the identity function so a Matrix thread
  // (event) id keeps its case — the helper's default normalizer lowercases.
  const sessionKey = params.threadId
    ? resolveThreadSessionKeys({
        baseSessionKey: route.sessionKey,
        threadId: params.threadId,
        normalizeThreadId: (id: string) => id,
      }).sessionKey
    : route.sessionKey;
  const effectiveRoute = { ...route, sessionKey };
  const accountId = effectiveRoute.accountId ?? params.accountId;

  const buildEnvelope = createInboundEnvelopeBuilder({
    cfg: params.cfg,
    route: effectiveRoute,
    sessionStore: params.cfg.session?.store,
    resolveStorePath: runtime.session.resolveStorePath,
    readSessionUpdatedAt: runtime.session.readSessionUpdatedAt,
    resolveEnvelopeFormatOptions: runtime.reply.resolveEnvelopeFormatOptions,
    formatAgentEnvelope: runtime.reply.formatAgentEnvelope,
  });

  const rawBody = renderMessages(params.messages);
  const lastMessage = params.messages[params.messages.length - 1];
  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: rawBody,
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
    CommandAuthorized: params.commandAuthorized,
    ...inboundMediaFields(params.media),
  });

  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: effectiveRoute.agentId,
    channel: params.channel,
    accountId,
  });

  const finals: string[] = [];
  const mediaUrls: string[] = [];
  let sawSkip = false;
  let sawError = false;
  let errorDetail: string | undefined;

  await runPreparedInboundReply({
    channel: params.channel,
    accountId,
    routeSessionKey: effectiveRoute.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.session.recordInboundSession,
    record: {
      onRecordError: (error: unknown) => params.log(`record error (continuing): ${String(error)}`),
    },
    runDispatch: async () =>
      await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: params.cfg,
        dispatcherOptions: {
          ...replyPipeline,
          // Only "final" text is collected; "tool" and "block" callbacks are intermediate.
          deliver: async (payload: unknown, info: { kind: string }) => {
            if (info?.kind !== "final") return;
            const normalized =
              payload && typeof payload === "object"
                ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
                : {};
            const text = (normalized as { text?: unknown }).text;
            if (typeof text === "string" && text.trim()) finals.push(text);
            mediaUrls.push(...resolveOutboundMediaUrls(normalized));
          },
          onSkip: () => {
            sawSkip = true;
          },
          // oxlint-disable-next-line typescript/no-explicit-any
          onError: (error: unknown, info: any) => {
            sawError = true;
            errorDetail = `${info?.kind ?? "?"}: ${String(error)}`;
            params.log(`dispatch error (${info?.kind ?? "?"}): ${String(error)}`);
          },
        },
        replyOptions: { onModelSelected },
      }),
  });

  return {
    finalText: finals.join("\n\n"),
    mediaUrls,
    agentId: effectiveRoute.agentId,
    sawFinal: finals.length > 0 || mediaUrls.length > 0,
    sawSkip,
    sawError,
    errorDetail,
  };
}
