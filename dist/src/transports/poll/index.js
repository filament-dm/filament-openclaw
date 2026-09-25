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
    let result;
    try {
      result = await ctx.runTurn(item);
    } catch (error) {
      return { kind: "error", diagnostic: `dispatch threw: ${String(error)}` };
    }
    if (result.sawError) {
      return { kind: "error", diagnostic: result.errorDetail ?? "dispatch reported an error" };
    }
    if (result.sawFinal) {
      if (abortSignal.aborted) {
        return { kind: "error", diagnostic: "aborted before publish" };
      }
      const publishRes = await client.replyWith(replyWith, result.finalText, {
        signal: abortSignal
      });
      if (publishRes.ok && isAlreadyAnsweredError(publishRes.data)) {
        log("filament: item already answered by a tool call; skipping publish");
        return { kind: "published" };
      }
      if (!publishRes.ok || !publishSucceeded(publishRes.data)) {
        return {
          kind: "error",
          diagnostic: `publish failed/ambiguous (${publishRes.kind ?? "?"}: ${publishRes.error?.message ?? "no event_id"})`
        };
      }
      log(`filament: reply published to ${item.channel_id} via ${replyWith.tool}`);
      return { kind: "published" };
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
    waitSeconds: ctx.settings.pollWaitSeconds
  });
}
export {
  runPollTransport
};
//# sourceMappingURL=index.js.map
