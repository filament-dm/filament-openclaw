/**
 * The `poll_work` transport (opt-in; needs a server that supports `poll_work`). The server decides
 * what wakes the agent and where the reply goes (`reply_with`), and replying acknowledges the item.
 * An item made only of messages that would never wake the agent (src/wake-rules.ts) is acked
 * without a turn.
 */
import { randomUUID } from "node:crypto";

import { acceptPending } from "../../accept-pending.js";
import { notifyPrincipalOfFailure } from "../../failure-note.js";
import type { ToolCallResult } from "../../mcp-client.js";
import { fetchInboundMedia, uploadOutboundMedia } from "../../media.js";
import {
  loadPendingReplies,
  type PendingReply,
  removePendingReply,
  savePendingReply,
} from "../../state/pending-replies.js";
import { clearInFlight, loadInFlight, markInFlight, setLiveRun } from "../../state/in-flight.js";
import { loadPollCursor, savePollCursor } from "../../state/poll-cursors.js";
import { decideWakeBeforeAddressing } from "../../wake-rules.js";
import { isBackchannelCommandItem } from "../../commands.js";
import type { DispatchOutcome } from "../../work-item.js";
import type { TransportContext, TransportResult } from "../types.js";
import { type PollOffer, type PollWorkItem, runPollLoop } from "./poll-work.js";

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
  /** Passed to the poll loop (tests set 0). */
  holdPollMs?: number;
}

/** Calls the accept tool an invite or vouch item names, with exactly its arguments. Never throws. */
async function acceptOffer(
  client: TransportContext["client"],
  offer: PollOffer,
  log: (message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    const res = await client.callTool(offer.reply_with.tool, offer.reply_with.args, { signal });
    log(
      `filament: accept ${offer.kind} ${offer.loop_id} ${res.ok ? "ok" : `failed (${res.error?.code ?? "?"})`}`,
    );
  } catch (error) {
    log(`filament: accept ${offer.kind} ${offer.loop_id} threw: ${String(error)}`);
  }
}

/** How long a reply that was ready at shutdown gets to land before the gateway goes. */
export const SHUTDOWN_PUBLISH_TIMEOUT_MS = 5_000;
/**
 * After a restart that cut a turn short, how long nothing is dispatched while OpenClaw's own
 * restart recovery runs that turn again and posts its answer (outbound.ts). Dispatching meanwhile
 * races the recovery (see state/in-flight.ts). The SDK has no hook for "recovery done", so this is
 * a bounded wait that ends early once the recovered answer names the interrupted message.
 */
export const RECOVERY_HOLD_MS = 2 * 60_000;

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
  const startedAt = now();
  const run = randomUUID();
  setLiveRun(accountId, run);

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

    // A turn the last gateway had running: OpenClaw is recovering it. Hold everything until its
    // answer lands (which clears the marker) or the wait runs out; then dispatch as usual.
    const t0 = now();
    const left = loadInFlight(accountId, mxid, t0).filter((t) => t.run !== run);
    // Released: OpenClaw's recovery has posted, so its claim is adopted.
    const interrupted = left.filter((t) => !(t.releaseAt !== undefined && t0 >= t.releaseAt));
    if (left.length && !interrupted.length) clearInFlight(accountId, mxid, { notRun: run });
    if (interrupted.length) {
      if (now() - startedAt < RECOVERY_HOLD_MS) {
        return {
          kind: "held",
          diagnostic: `OpenClaw is recovering ${interrupted.length} turn(s) a restart cut short`,
        };
      }
      log("filament: no recovered answer arrived after the restart; dispatching as usual");
      clearInFlight(accountId, mxid, { notRun: run });
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
      if (lastId) {
        markInFlight(accountId, mxid, {
          eventId: lastId,
          room: item.channel_id,
          startedAt: now(),
          run,
        });
      }
      result = await ctx.runTurn(item, media);
    } catch (error) {
      if (lastId) clearInFlight(accountId, mxid, { eventId: lastId });
      return { kind: "dropped", diagnostic: `the turn threw: ${String(error)}` };
    }
    // A turn that produced nothing may have been cut short: its marker stays for the next start.
    const producedNothing = !result.sawFinal && !result.sawSkip && !result.sawError;
    if (lastId && !producedNothing) clearInFlight(accountId, mxid, { eventId: lastId });

    if (result.sawError) {
      // Never into the room: the principal hears about it in the backchannel instead.
      if (!abortSignal.aborted) {
        await notifyPrincipalOfFailure(client, item, result, { signal: abortSignal, log });
      }
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
    acceptOffer: (offer) => acceptOffer(client, offer, log, abortSignal),
    initialCursor: loadPollCursor(ctx.accountId, ctx.identity.mxid),
    now,
    ...(deps.holdPollMs !== undefined ? { holdPollMs: deps.holdPollMs } : {}),
    onCursorSent: (cursor) => savePollCursor(ctx.accountId, ctx.identity.mxid, cursor),
    // Acked is finished: a marker left by a turn that produced nothing has nothing to wait for.
    onAcked: (item) => {
      const last = item.messages.at(-1)?.event_id;
      if (last) clearInFlight(accountId, mxid, { eventId: last });
    },
  });
}
