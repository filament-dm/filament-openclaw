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
  /**
   * `"direct"` follows `session.dmScope` (by default the agent's main session); `"group"` gets a
   * per-channel session. Only the principal's backchannel is direct (`turnPeerKind`).
   */
  peerKind: "direct" | "group";
  /** A group turn that must end in an answer (`turnWasMentioned`); others may end in silence. */
  wasMentioned?: boolean;
  /**
   * A side session of the channel's own, for a turn the gateway starts rather than a person:
   * its prompt stays out of the conversation the owner sees, in OpenClaw's chat too.
   */
  sideSession?: string;
  channelId: string;
  threadId: string | null;
  messages: WorkMessage[];
  /** Filament's standing instructions for the agent, added to the turn's system prompt. */
  systemPrompt?: string;
  /** Attachments already saved for the turn (poll_work only). */
  media?: InboundMedia[];
  recipientAddress: string;
  /** The session's title in OpenClaw ("Filament · …"); see room-labels.ts. */
  conversationLabel: string;
  /** A group session's subject: the room's name, or its people. */
  groupSubject?: string;
  /** Display names by user id, and the room's and its loop's names, when the item carries them. */
  senderNames?: Readonly<Record<string, string>>;
  channelName?: string;
  loopName?: string;
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
  /** OpenClaw's own failure text, when it delivered one in place of the agent's reply. */
  errorReplyText?: string;
}

/**
 * OpenClaw delivers some of its own messages as reply payloads: a failure (`isError`, e.g. "the AI
 * service returned an empty reply") or a status notice. They are the host talking, not the agent,
 * and normalizing a payload drops these flags, so they are read off the payload as delivered.
 */
export function hostReplyKind(payload: unknown): "error" | "notice" | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.isError === true) return "error";
  if (p.isStatusNotice === true || p.isFallbackNotice === true || p.isCompactionNotice === true) {
    return "notice";
  }
  return null;
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

/** A sender as the model reads them: "Name (@id)" when the name is known, so the id stays to mention. */
export function senderLabel(sender: string, names?: Readonly<Record<string, string>>): string {
  const name = names?.[sender];
  return name ? `${name} (${sender})` : sender;
}

/** OpenClaw's history entry: rendered to the model as `#<message_id> <sender>: <body>`. */
export interface InboundHistoryEntry {
  sender: string;
  body: string;
  timestamp: number;
  messageId: string;
}

/**
 * The item as OpenClaw's inbound context wants it: the last message is the turn's own (its
 * text the visible body; its event id and sender the `Conversation info` block's `message_id`
 * and `sender`), and the ones before it are `InboundHistory`, each with its own id and sender.
 * Ids and senders reach the model as OpenClaw-built context blocks, which its chat views strip,
 * so the conversation shows plain text and the agent can still react, quote and reply by id.
 */
export function inboundMessageFields(
  messages: readonly WorkMessage[],
  senderNames?: Readonly<Record<string, string>>,
): {
  body: string;
  current: WorkMessage | undefined;
  history: InboundHistoryEntry[];
} {
  const current = messages[messages.length - 1];
  return {
    body: current?.body ?? "",
    current,
    history: messages.slice(0, -1).map((m) => ({
      sender: senderLabel(m.sender, senderNames),
      body: m.body,
      timestamp: m.ts,
      messageId: m.event_id,
    })),
  };
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
  const childKey = params.sideSession ?? params.threadId;
  const sessionKey = childKey
    ? resolveThreadSessionKeys({
        baseSessionKey: route.sessionKey,
        threadId: childKey,
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

  const {
    body: rawBody,
    current: lastMessage,
    history,
  } = inboundMessageFields(params.messages, params.senderNames);
  const senderName = lastMessage ? params.senderNames?.[lastMessage.sender] : undefined;
  const isGroup = params.peerKind === "group";
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
    ...(params.groupSubject && isGroup ? { GroupSubject: params.groupSubject } : {}),
    ...(params.channelName && isGroup ? { GroupChannel: params.channelName } : {}),
    ...(params.loopName && isGroup ? { GroupSpace: params.loopName } : {}),
    ...(isGroup && params.wasMentioned !== undefined ? { WasMentioned: params.wasMentioned } : {}),
    SenderId: lastMessage?.sender ?? "unknown",
    ...(senderName ? { SenderName: senderName } : {}),
    ...(lastMessage ? { Timestamp: lastMessage.ts } : {}),
    ...(history.length > 0 ? { InboundHistory: history } : {}),
    Provider: params.channel,
    Surface: params.channel,
    MessageSid: lastMessage?.event_id ?? params.channelId,
    MessageSidFull: lastMessage?.event_id ?? params.channelId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.channelId,
    CommandAuthorized: params.commandAuthorized,
    // The gateway, not the principal, wrote a side session's prompt.
    ...(params.sideSession
      ? {
          InputProvenance: {
            kind: "internal_system",
            sourceTool: `filament:${params.sideSession}`,
          },
        }
      : {}),
    // Despite the name, the gateway adds this to the system prompt of direct turns too.
    ...(params.systemPrompt ? { GroupSystemPrompt: params.systemPrompt } : {}),
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
  let errorReplyText: string | undefined;

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
            const host = hostReplyKind(payload);
            if (host) {
              const text = (payload as { text?: unknown }).text;
              const said = typeof text === "string" ? text.trim() : "";
              if (host === "error") {
                sawError = true;
                errorReplyText = said || undefined;
                errorDetail = `OpenClaw error reply: ${said || "(no text)"}`;
              }
              params.log(`OpenClaw ${host} reply kept out of the answer: ${said || "(no text)"}`);
              return;
            }
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
    ...(errorReplyText ? { errorReplyText } : {}),
  };
}
