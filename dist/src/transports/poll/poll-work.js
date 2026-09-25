import {
  POLL_TIMEOUT_MARGIN_MS
} from "../../mcp-client.js";
import { nextBackoffMs, sleepAbortable } from "../../util.js";
function parsePollWorkResponse(data) {
  if (!data || typeof data !== "object") return null;
  const d = data;
  if (!Array.isArray(d.work) || typeof d.cursor !== "string") return null;
  const work = [];
  for (const raw of d.work) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw;
    if (typeof r.channel_id !== "string" || !Array.isArray(r.messages)) continue;
    const messages = r.messages.filter(
      (m) => !!m && typeof m === "object" && typeof m.event_id === "string"
    ).map((m) => ({
      event_id: String(m.event_id),
      sender: typeof m.sender === "string" ? m.sender : "unknown",
      body: typeof m.body === "string" ? m.body : "",
      ts: typeof m.ts === "number" ? m.ts : 0
    }));
    const rw = r.reply_with;
    const replyWith = rw && typeof rw === "object" && typeof rw.tool === "string" ? {
      tool: String(rw.tool),
      args: rw.args ?? {}
    } : null;
    work.push({
      channel_id: r.channel_id,
      thread_id: typeof r.thread_id === "string" ? r.thread_id : null,
      is_backchannel: r.is_backchannel === true,
      messages,
      reply_with: replyWith
    });
  }
  return {
    work,
    cursor: d.cursor,
    next_poll_ms: typeof d.next_poll_ms === "number" ? d.next_poll_ms : 0,
    truncated: d.truncated === true,
    acknowledged: typeof d.acknowledged === "number" ? d.acknowledged : 0
  };
}
const DEFAULT_WAIT_SECONDS = 30;
function itemKey(item) {
  const ids = item.messages.map((m) => m.event_id).sort();
  return `${item.channel_id}\0${item.thread_id ?? ""}\0${ids.join(",")}`;
}
const DEFAULT_MAX_ITEMS = 1;
async function runPollLoop(opts) {
  const { client, abortSignal, log, dispatchItem } = opts;
  const waitSeconds = opts.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const backoffMs = opts.backoffMs ?? nextBackoffMs;
  let cursor;
  let pendingAck = [];
  let failureStreak = 0;
  const ambiguousSeen = /* @__PURE__ */ new Set();
  while (!abortSignal.aborted) {
    let result;
    try {
      result = await client.pollWork(
        {
          cursor,
          ack: pendingAck.length ? pendingAck : void 0,
          wait_seconds: waitSeconds,
          max_items: maxItems
        },
        { signal: abortSignal, timeoutMs: waitSeconds * 1e3 + POLL_TIMEOUT_MARGIN_MS }
      );
    } catch {
      break;
    }
    if (abortSignal.aborted) break;
    if (!result.ok) {
      if (result.kind === "auth") {
        log(`filament-poll: auth error (${result.error?.message ?? "unauthorized"}); stopping`);
        return { fatal: `auth: ${result.error?.message ?? "unauthorized"}` };
      }
      failureStreak += 1;
      const backoff = backoffMs(failureStreak);
      log(
        `filament-poll: poll_work failed (${result.kind ?? "unknown"}): ${result.error?.message ?? "?"}; backing off ${backoff}ms`
      );
      await sleepAbortable(backoff, abortSignal);
      continue;
    }
    const parsed = parsePollWorkResponse(result.data);
    if (!parsed) {
      failureStreak += 1;
      const backoff = backoffMs(failureStreak);
      log(`filament-poll: poll_work returned an unparseable response; backing off ${backoff}ms`);
      await sleepAbortable(backoff, abortSignal);
      continue;
    }
    failureStreak = 0;
    pendingAck = [];
    cursor = parsed.cursor;
    for (const item of parsed.work) {
      if (abortSignal.aborted) return {};
      if (!item.reply_with) {
        log(`filament-poll: ${item.channel_id} item has no reply_with; server already consumed it`);
        continue;
      }
      const outcome = await dispatchItem(item);
      if (outcome.kind === "error") {
        log(
          `filament-poll: item dispatch failed (${item.channel_id}): ${outcome.diagnostic}; pausing`
        );
        return { fatal: `dispatch: ${outcome.diagnostic}` };
      }
      if (outcome.kind === "silent") {
        pendingAck.push(...item.messages.map((m) => m.event_id));
      }
      if (outcome.kind === "ambiguous") {
        const key = itemKey(item);
        if (ambiguousSeen.has(key)) {
          ambiguousSeen.delete(key);
          log(
            `filament-poll: ${item.channel_id} produced no output twice; acknowledging without a reply`
          );
          pendingAck.push(...item.messages.map((m) => m.event_id));
        } else {
          ambiguousSeen.add(key);
        }
      }
    }
  }
  return {};
}
export {
  parsePollWorkResponse,
  runPollLoop
};
//# sourceMappingURL=poll-work.js.map
