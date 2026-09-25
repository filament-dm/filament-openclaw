/**
 * Work-item → agent-turn dispatch for the Filament channel, shared by both
 * transports.
 *
 * A work item (src/work-item.ts) is grouped by `(channel_id, thread_id)` and
 * carries the unread `messages[]` for that spot — poll_work delivers it that
 * way, and the FCM transport builds one per push. There is no bundled
 * per-kind facade for this shape, so this module composes the same
 * SDK primitives OpenClaw's own group-channel path uses — route → envelope →
 * context → buffered-block dispatch — for BOTH direct/backchannel and
 * group/channel items, distinguished only by `peerKind`.
 *
 * This intentionally does NOT use `dispatchInboundDirectDmWithRuntime`
 * (the SDK's one-call direct-DM facade): its `deliver` callback forwards
 * every dispatcher callback (tool/block/final) with no `kind` info, so a
 * caller can't tell a "final" from an intermediate block — which is exactly
 * what a single-publish-per-item design needs to get right. Composing the
 * lower-level primitives ourselves (as done here) exposes `info.kind` on
 * every `deliver` call, so only `"final"` text is collected.
 *
 * All primitives below are exported from `openclaw/plugin-sdk/*`.
 */
import { createInboundEnvelopeBuilder } from "openclaw/plugin-sdk/inbound-envelope";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { runPreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { normalizeOutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";

import type { WorkMessage } from "./work-item.js";

export interface DispatchWorkItemParams {
  // The channelRuntime surface + gateway config from the channel's startAccount ctx.
  // oxlint-disable-next-line typescript/no-explicit-any
  cfg: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  channelRuntime: any;
  channel: string;
  channelLabel: string;
  accountId: string;
  /** `"direct"` collapses to the agent's main session (backchannel/true-DM);
   * `"group"` gets a per-channel session. The caller decides from the item. */
  peerKind: "direct" | "group";
  /** The room the item belongs to (`item.channel_id`). */
  channelId: string;
  /** `item.thread_id`; when present the session is further scoped per-thread. */
  threadId: string | null;
  messages: WorkMessage[];
  recipientAddress: string;
  conversationLabel: string;
  /** Item-level authorization — true only for `is_backchannel` items. */
  commandAuthorized: boolean;
  log: (message: string) => void;
}

export interface DispatchTurnResult {
  /** Finalized reply text (joined `final` callbacks, in order); "" if none. */
  finalText: string;
  sawFinal: boolean;
  /** The dispatcher explicitly skipped a reply (evidence of deliberate silence). */
  sawSkip: boolean;
  /** The dispatcher reported a terminal error for this turn. */
  sawError: boolean;
  errorDetail?: string;
}

/** Render one item's messages, sender + event_id preserved, in order. */
function renderMessages(messages: WorkMessage[]): string {
  return messages.map((m) => `[${m.sender} ${m.event_id}] ${m.body}`).join("\n");
}

/**
 * Route, envelope, and run one work item's agent turn, collecting only
 * `final` text callbacks (never publishing here — the transport publishes
 * at most once after this resolves; see src/transports/).
 */
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
  });

  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: effectiveRoute.agentId,
    channel: params.channel,
    accountId,
  });

  const finals: string[] = [];
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
          // `info.kind` is "tool" | "block" | "final" — only "final" text is
          // ever collected. Never publish here; just buffer.
          deliver: async (payload: unknown, info: { kind: string }) => {
            if (info?.kind !== "final") return;
            const normalized =
              payload && typeof payload === "object"
                ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
                : {};
            const text = (normalized as { text?: unknown }).text;
            if (typeof text === "string" && text.trim()) finals.push(text);
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
    sawFinal: finals.length > 0,
    sawSkip,
    sawError,
    errorDetail,
  };
}
