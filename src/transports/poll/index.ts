/**
 * The `poll_work` transport (opt-in; needs a server that supports `poll_work`). The server decides
 * what wakes the agent and where the reply goes (`reply_with`), and replying acknowledges the item.
 * An item made only of messages that would never wake the agent (src/wake-rules.ts) is acked
 * without a turn.
 */
import { acceptPending } from "../../accept-pending.js";
import type { ToolCallResult } from "../../mcp-client.js";
import { fetchInboundMedia, uploadOutboundMedia } from "../../media.js";
import {
  loadPendingReplies,
  type PendingReply,
  removePendingReply,
  savePendingReply,
} from "../../state/pending-replies.js";
import { loadPollCursor, savePollCursor } from "../../state/poll-cursors.js";
import { decideWakeBeforeAddressing } from "../../wake-rules.js";
import { isBackchannelCommandItem } from "../../commands.js";
import type { DispatchOutcome } from "../../work-item.js";
import type { TransportContext, TransportResult } from "../types.js";
import { type PollWorkItem, runPollLoop } from "./poll-work.js";

function publishSucceeded(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.event_id === "string" && d.event_id.length > 0 && d.error === undefined;
}

// The server rejects a second reply to an answered item with this error (HTTP 200, no `isError`),
// e.g. when a tool call replied before our `reply_with` publish. The item got its reply: success.
const ALREADY_ANSWERED_PREFIX = "You have already answered this message";

function isAlreadyAnsweredError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const err = (data as Record<string, unknown>).error;
  return typeof err === "string" && err.startsWith(ALREADY_ANSWERED_PREFIX);
}

/** Why no message in the item would wake the agent, or null when one would. */
export function skipReason(item: PollWorkItem, selfMxid: string): string | null {
  const reasons = new Set<string>();
  for (const m of item.messages) {
    const decision = decideWakeBeforeAddressing(
      {
        senderId: m.sender,
        isBackchannel: item.is_backchannel,
        isDirect: item.is_direct === true,
        isMention: m.is_mention === true,
        text: m.body,
        senderIsAgent: m.sender_is_agent === true,
        addressedWithReply:
          typeof m.is_implicitly_mentioned === "boolean"
            ? m.is_implicitly_mentioned && m.reply_expected === true
            : undefined,
      },
      selfMxid,
    );
    if (!decision || decision.wake) return null;
    reasons.add(decision.reason);
  }
  return reasons.size ? [...reasons].join(", ") : null;
}

export function classifyPublish(res: ToolCallResult): DispatchOutcome {
  if (res.ok) {
    if (publishSucceeded(res.data)) return { kind: "published" };
    const err = (res.data as Record<string, unknown> | undefined)?.error;
    if (typeof err === "string") {
      return { kind: "dropped", diagnostic: `the server refused the reply: ${err}` };
    }
    return { kind: "retry", diagnostic: "publish returned no event_id" };
  }
  const message = res.error?.message ?? "?";
  if (res.kind === "auth") return { kind: "fatal", diagnostic: `auth: ${message}` };
  if (res.kind === "tool") {
    return { kind: "dropped", diagnostic: `the server refused the reply (${message})` };
  }
  return { kind: "retry", diagnostic: `publish failed (${res.kind ?? "?"}: ${message})` };
}

export interface PollTransportDeps {
  fetchInboundMedia?: typeof fetchInboundMedia;
  uploadOutboundMedia?: typeof uploadOutboundMedia;
  now?: () => number;
}

/** How long a reply that was ready at shutdown gets to land before the gateway goes. */
export const SHUTDOWN_PUBLISH_TIMEOUT_MS = 5_000;

export async function runPollTransport(
  ctx: TransportContext,
  deps: PollTransportDeps = {},
): Promise<TransportResult> {
  const { client, abortSignal, log } = ctx;
  const fetchMedia = deps.fetchInboundMedia ?? fetchInboundMedia;
  const uploadMedia = deps.uploadOutboundMedia ?? uploadOutboundMedia;
  const now = deps.now ?? Date.now;
  const { accountId } = ctx;
  const { mxid } = ctx.identity;

  /** Uploads the reply's media and posts it where `reply_with` says. */
  const publish = async (
    replyWith: PendingReply["replyWith"],
    text: string,
    mediaUrls: readonly string[],
    mediaLocalRoots: readonly string[],
    signal: AbortSignal,
    channelId: string,
  ): Promise<DispatchOutcome> => {
    const attachments = await uploadMedia(client, mediaUrls, { mediaLocalRoots, log, signal });
    if (!text.trim() && attachments.length === 0) {
      return {
        kind: "dropped",
        diagnostic: "the reply was media only and none of it could be sent",
      };
    }
    let publishRes;
    try {
      publishRes = await client.replyWith(replyWith, text, { signal }, attachments);
    } catch (error) {
      return { kind: "retry", diagnostic: `publish threw: ${String(error)}` };
    }
    if (publishRes.ok && isAlreadyAnsweredError(publishRes.data)) {
      log("filament: item already answered by a tool call; skipping publish");
      return { kind: "published" };
    }
    const outcome = classifyPublish(publishRes);
    if (outcome.kind === "published") {
      log(`filament: reply published to ${channelId} via ${replyWith.tool}`);
    }
    return outcome;
  };

  /** A kept reply, posted; it is forgotten once it lands or the server refuses it for good. */
  const publishPending = async (pending: PendingReply, signal: AbortSignal) => {
    const outcome = await publish(
      pending.replyWith,
      pending.text,
      pending.mediaUrls,
      pending.mediaLocalRoots,
      signal,
      String(pending.replyWith.args.channel ?? "its room"),
    );
    if (outcome.kind !== "retry")
      removePendingReply(accountId, mxid, pending.eventIds.at(-1) ?? "");
    return outcome;
  };

  // Answers a restart cut off before they were posted.
  for (const pending of loadPendingReplies(accountId, mxid, now())) {
    if (abortSignal.aborted) break;
    const outcome = await publishPending(pending, abortSignal);
    log(`filament: a reply kept from before the restart: ${outcome.kind}`);
  }

  const dispatchItem = async (item: PollWorkItem): Promise<DispatchOutcome> => {
    const replyWith = item.reply_with;
    if (!replyWith) {
      // The poll loop already filters these out.
      return { kind: "ambiguous" };
    }
    if (
      ctx.handleCommand &&
      isBackchannelCommandItem(item, ctx.identity.principal, ctx.identity.ccRoomId)
    ) {
      await ctx.handleCommand(item);
      return { kind: "silent" };
    }

    // Its answer was ready before a restart: post that rather than run the turn again.
    const lastId = item.messages.at(-1)?.event_id;
    const kept = lastId
      ? loadPendingReplies(accountId, mxid, now()).find((r) => r.eventIds.at(-1) === lastId)
      : undefined;
    if (kept) {
      log(`filament: posting the reply kept for ${item.channel_id} from before the restart`);
      return await publishPending(kept, abortSignal);
    }

    const skip = skipReason(item, ctx.identity.mxid);
    if (skip) {
      log(`filament-poll: not waking for ${item.channel_id} (${skip}); acknowledging`);
      return { kind: "silent" };
    }

    let result;
    try {
      log(
        `filament-poll: turn for ${item.messages.length} message(s) in ${item.channel_id}` +
          (item.messages.some((m) => m.media?.length) ? " (with attachments)" : ""),
      );
      const media = await fetchMedia(client, item.messages, { log, signal: abortSignal });
      result = await ctx.runTurn(item, media);
    } catch (error) {
      return { kind: "dropped", diagnostic: `the turn threw: ${String(error)}` };
    }

    if (result.sawError) {
      return { kind: "dropped", diagnostic: `the turn failed: ${result.errorDetail ?? "?"}` };
    }
    if (result.sawFinal) {
      if (!abortSignal.aborted) {
        return await publish(
          replyWith,
          result.finalText,
          result.mediaUrls,
          result.mediaLocalRoots,
          abortSignal,
          item.channel_id,
        );
      }
      // The gateway is shutting down with the answer in hand: keep it for the next start, and
      // try to post it now on a short clock of its own.
      const pending: PendingReply = {
        eventIds: item.messages.map((m) => m.event_id),
        replyWith,
        text: result.finalText,
        mediaUrls: [...result.mediaUrls],
        mediaLocalRoots: [...result.mediaLocalRoots],
        savedAt: now(),
      };
      savePendingReply(accountId, mxid, pending);
      const outcome = await publishPending(
        pending,
        AbortSignal.timeout(SHUTDOWN_PUBLISH_TIMEOUT_MS),
      );
      if (outcome.kind === "retry") {
        return {
          kind: "retry",
          diagnostic: "aborted before publish; the reply is kept for the next start",
        };
      }
      return outcome;
    }
    if (result.sawSkip) {
      return { kind: "silent" };
    }
    log(
      `filament: turn produced no text and no explicit skip signal for ${item.channel_id}; leaving unacknowledged`,
    );
    return { kind: "ambiguous" };
  };

  return runPollLoop({
    client,
    abortSignal,
    log,
    dispatchItem,
    waitSeconds: ctx.settings.pollWaitSeconds,
    sweepPending: () => acceptPending(client, log, abortSignal),
    initialCursor: loadPollCursor(ctx.accountId, ctx.identity.mxid),
    onCursorSent: (cursor) => savePollCursor(ctx.accountId, ctx.identity.mxid, cursor),
  });
}
