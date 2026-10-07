import { acceptPending } from "../../accept-pending.js";
import { decideWakeBeforeAddressing } from "../../wake-rules.js";
import { isGatewayCommandItem } from "../../gateway.js";
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
async function runPollTransport(ctx) {
  const { client, abortSignal, log } = ctx;
  const dispatchItem = async (item) => {
    const replyWith = item.reply_with;
    if (!replyWith) {
      return { kind: "ambiguous" };
    }
    if (ctx.control) {
      await ctx.handleControl(item);
      return { kind: "silent" };
    }
    if (ctx.handleCommand && isGatewayCommandItem(item, ctx.identity.principal, ctx.identity.ccRoomId)) {
      await ctx.handleCommand(item);
      return { kind: "silent" };
    }
    const skip = skipReason(item, ctx.identity.mxid);
    if (skip) {
      log(`filament-poll: not waking for ${item.channel_id} (${skip}); acknowledging`);
      return { kind: "silent" };
    }
    let result;
    try {
      result = await ctx.runTurn(item);
    } catch (error) {
      return { kind: "dropped", diagnostic: `the turn threw: ${String(error)}` };
    }
    if (result.sawError) {
      return { kind: "dropped", diagnostic: `the turn failed: ${result.errorDetail ?? "?"}` };
    }
    if (result.sawFinal) {
      if (abortSignal.aborted) return { kind: "retry", diagnostic: "aborted before publish" };
      let publishRes;
      try {
        publishRes = await client.replyWith(replyWith, result.finalText, {
          signal: abortSignal
        });
      } catch (error) {
        return { kind: "retry", diagnostic: `publish threw: ${String(error)}` };
      }
      if (publishRes.ok && isAlreadyAnsweredError(publishRes.data)) {
        log("filament: item already answered by a tool call; skipping publish");
        return { kind: "published" };
      }
      const outcome = classifyPublish(publishRes);
      if (outcome.kind === "published") {
        log(`filament: reply published to ${item.channel_id} via ${replyWith.tool}`);
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
    sweepPending: ctx.control ? void 0 : () => acceptPending(client, log, abortSignal)
  });
}
export {
  classifyPublish,
  runPollTransport,
  skipReason
};
