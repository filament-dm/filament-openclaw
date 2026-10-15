import { randomUUID } from "node:crypto";
import { acceptPending } from "../../accept-pending.js";
import { fetchInboundMedia, uploadOutboundMedia } from "../../media.js";
import {
  loadPendingReplies,
  removePendingReply,
  savePendingReply
} from "../../state/pending-replies.js";
import { clearInFlight, loadInFlight, markInFlight } from "../../state/in-flight.js";
import { loadPollCursor, savePollCursor } from "../../state/poll-cursors.js";
import { decideWakeBeforeAddressing } from "../../wake-rules.js";
import { isBackchannelCommandItem } from "../../commands.js";
import { runPollLoop } from "./poll-work.js";
function publishSucceeded(data) {
  if (!data || typeof data !== "object") return false;
  const d = data;
  return typeof d.event_id === "string" && d.event_id.length > 0 && d.error === void 0;
}
const ALREADY_ANSWERED_PREFIX = "You have already answered this message";
function isAlreadyAnsweredError(data) {
  if (!data || typeof data !== "object") return false;
  const err = data.error;
  return typeof err === "string" && err.startsWith(ALREADY_ANSWERED_PREFIX);
}
function skipReason(item, selfMxid) {
  const reasons = /* @__PURE__ */ new Set();
  for (const m of item.messages) {
    const decision = decideWakeBeforeAddressing(
      {
        senderId: m.sender,
        isBackchannel: item.is_backchannel,
        isDirect: item.is_direct === true,
        isMention: m.is_mention === true,
        text: m.body,
        senderIsAgent: m.sender_is_agent === true,
        addressedWithReply: typeof m.is_implicitly_mentioned === "boolean" ? m.is_implicitly_mentioned && m.reply_expected === true : void 0
      },
      selfMxid
    );
    if (!decision || decision.wake) return null;
    reasons.add(decision.reason);
  }
  return reasons.size ? [...reasons].join(", ") : null;
}
function classifyPublish(res) {
  if (res.ok) {
    if (publishSucceeded(res.data)) return { kind: "published" };
    const err = res.data?.error;
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
const SHUTDOWN_PUBLISH_TIMEOUT_MS = 5e3;
const RECOVERY_HOLD_MS = 2 * 6e4;
async function runPollTransport(ctx, deps = {}) {
  const { client, abortSignal, log } = ctx;
  const fetchMedia = deps.fetchInboundMedia ?? fetchInboundMedia;
  const uploadMedia = deps.uploadOutboundMedia ?? uploadOutboundMedia;
  const now = deps.now ?? Date.now;
  const { accountId } = ctx;
  const { mxid } = ctx.identity;
  const startedAt = now();
  const run = randomUUID();
  const publish = async (replyWith, text, mediaUrls, mediaLocalRoots, signal, channelId) => {
    const attachments = await uploadMedia(client, mediaUrls, { mediaLocalRoots, log, signal });
    if (!text.trim() && attachments.length === 0) {
      return {
        kind: "dropped",
        diagnostic: "the reply was media only and none of it could be sent"
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
  const publishPending = async (pending, signal) => {
    const outcome = await publish(
      pending.replyWith,
      pending.text,
      pending.mediaUrls,
      pending.mediaLocalRoots,
      signal,
      String(pending.replyWith.args.channel ?? "its room")
    );
    if (outcome.kind !== "retry")
      removePendingReply(accountId, mxid, pending.eventIds.at(-1) ?? "");
    return outcome;
  };
  for (const pending of loadPendingReplies(accountId, mxid, now())) {
    if (abortSignal.aborted) break;
    const outcome = await publishPending(pending, abortSignal);
    log(`filament: a reply kept from before the restart: ${outcome.kind}`);
  }
  const dispatchItem = async (item) => {
    const replyWith = item.reply_with;
    if (!replyWith) {
      return { kind: "ambiguous" };
    }
    if (ctx.handleCommand && isBackchannelCommandItem(item, ctx.identity.principal, ctx.identity.ccRoomId)) {
      await ctx.handleCommand(item);
      return { kind: "silent" };
    }
    const interrupted = loadInFlight(accountId, mxid, now()).filter((t) => t.run !== run);
    if (interrupted.length) {
      if (now() - startedAt < RECOVERY_HOLD_MS) {
        return {
          kind: "held",
          diagnostic: `OpenClaw is recovering ${interrupted.length} turn(s) a restart cut short`
        };
      }
      log("filament: no recovered answer arrived after the restart; dispatching as usual");
      clearInFlight(accountId, mxid, { notRun: run });
    }
    const lastId = item.messages.at(-1)?.event_id;
    const kept = lastId ? loadPendingReplies(accountId, mxid, now()).find((r) => r.eventIds.at(-1) === lastId) : void 0;
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
        `filament-poll: turn for ${item.messages.length} message(s) in ${item.channel_id}` + (item.messages.some((m) => m.media?.length) ? " (with attachments)" : "")
      );
      const media = await fetchMedia(client, item.messages, { log, signal: abortSignal });
      if (lastId) markInFlight(accountId, mxid, { eventId: lastId, startedAt: now(), run });
      result = await ctx.runTurn(item, media);
    } catch (error) {
      if (lastId) clearInFlight(accountId, mxid, { eventId: lastId });
      return { kind: "dropped", diagnostic: `the turn threw: ${String(error)}` };
    }
    const producedNothing = !result.sawFinal && !result.sawSkip && !result.sawError;
    if (lastId && !producedNothing) clearInFlight(accountId, mxid, { eventId: lastId });
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
          item.channel_id
        );
      }
      const pending = {
        eventIds: item.messages.map((m) => m.event_id),
        replyWith,
        text: result.finalText,
        mediaUrls: [...result.mediaUrls],
        mediaLocalRoots: [...result.mediaLocalRoots],
        savedAt: now()
      };
      savePendingReply(accountId, mxid, pending);
      const outcome = await publishPending(
        pending,
        AbortSignal.timeout(SHUTDOWN_PUBLISH_TIMEOUT_MS)
      );
      if (outcome.kind === "retry") {
        return {
          kind: "retry",
          diagnostic: "aborted before publish; the reply is kept for the next start"
        };
      }
      return outcome;
    }
    if (result.sawSkip) {
      return { kind: "silent" };
    }
    log(
      `filament: turn produced no text and no explicit skip signal for ${item.channel_id}; leaving unacknowledged`
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
    now,
    ...deps.holdPollMs !== void 0 ? { holdPollMs: deps.holdPollMs } : {},
    onCursorSent: (cursor) => savePollCursor(ctx.accountId, ctx.identity.mxid, cursor),
    // Acked is finished: a marker left by a turn that produced nothing has nothing to wait for.
    onAcked: (item) => {
      const last = item.messages.at(-1)?.event_id;
      if (last) clearInFlight(accountId, mxid, { eventId: last });
    }
  });
}
export {
  RECOVERY_HOLD_MS,
  SHUTDOWN_PUBLISH_TIMEOUT_MS,
  classifyPublish,
  runPollTransport,
  skipReason
};
