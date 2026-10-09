import {
  POLL_TIMEOUT_MARGIN_MS
} from "../../mcp-client.js";
import { nextBackoffMs, sleepAbortable } from "../../util.js";
import {
  ATTACHMENT_ONLY_BODY
} from "../../work-item.js";
function replyWithFrom(rw) {
  if (!rw || typeof rw !== "object") return null;
  const r = rw;
  if (typeof r.tool !== "string") return null;
  const args = r.args && typeof r.args === "object" ? r.args : {};
  return { tool: r.tool, args };
}
function withMedia(raw) {
  if (!Array.isArray(raw)) return {};
  const media = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const r = d;
    if (typeof r.mxc_url !== "string" || !r.mxc_url.startsWith("mxc://")) continue;
    media.push({
      mxc_url: r.mxc_url,
      ...typeof r.mimetype === "string" ? { mimetype: r.mimetype } : {},
      ...typeof r.filename === "string" ? { filename: r.filename } : {},
      ...typeof r.size === "number" ? { size: r.size } : {}
    });
  }
  return media.length ? { media } : {};
}
function parsePollWorkResponse(data) {
  if (!data || typeof data !== "object") return null;
  const d = data;
  const busy = d.busy === true;
  if (!busy && (!Array.isArray(d.work) || typeof d.cursor !== "string")) return null;
  const work = [];
  const offers = [];
  for (const raw of Array.isArray(d.work) ? d.work : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw;
    if (r.kind === "invite" || r.kind === "vouch") {
      const replyWith2 = replyWithFrom(r.reply_with);
      if (typeof r.loop_id === "string" && replyWith2) {
        offers.push({ kind: r.kind, loop_id: r.loop_id, reply_with: replyWith2 });
      }
      continue;
    }
    if (typeof r.channel_id !== "string" || !Array.isArray(r.messages)) continue;
    const messages = r.messages.filter(
      (m) => !!m && typeof m === "object" && typeof m.event_id === "string"
    ).map((m) => ({
      ...withMedia(m.media),
      event_id: String(m.event_id),
      sender: typeof m.sender === "string" ? m.sender : "unknown",
      body: typeof m.body === "string" && m.body ? m.body : Array.isArray(m.media) && m.media.length > 0 ? ATTACHMENT_ONLY_BODY : "",
      ts: typeof m.timestamp === "number" ? m.timestamp : 0,
      is_mention: m.is_mention === true,
      sender_is_agent: m.is_from_agent === true,
      ...typeof m.is_implicitly_mentioned === "boolean" ? { is_implicitly_mentioned: m.is_implicitly_mentioned } : {},
      ...typeof m.reply_expected === "boolean" ? { reply_expected: m.reply_expected } : {}
    }));
    const replyWith = replyWithFrom(r.reply_with);
    work.push({
      channel_id: r.channel_id,
      thread_id: typeof r.thread_id === "string" ? r.thread_id : null,
      is_backchannel: r.is_backchannel === true,
      is_direct: r.is_direct === true,
      messages,
      reply_with: replyWith
    });
  }
  return {
    work,
    cursor: typeof d.cursor === "string" ? d.cursor : "",
    next_poll_ms: typeof d.next_poll_ms === "number" ? d.next_poll_ms : 0,
    truncated: d.truncated === true,
    acknowledged: typeof d.acknowledged === "number" ? d.acknowledged : 0,
    offers,
    busy
  };
}
const PENDING_SWEEP_INTERVAL_MS = 10 * 6e4;
const MAX_REPLY_ATTEMPTS = 3;
const BUSY_DEFAULT_WAIT_MS = 1e3;
const DEFAULT_WAIT_SECONDS = 30;
function itemKey(item) {
  const ids = item.messages.map((m) => m.event_id).sort();
  return `${item.channel_id}\0${item.thread_id ?? ""}\0${ids.join(",")}`;
}
const DEFAULT_MAX_ITEMS = 1;
async function runPollLoop(opts) {
  const { client, abortSignal, log, dispatchItem, sweepPending, acceptOffer } = opts;
  const waitSeconds = opts.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const backoffMs = opts.backoffMs ?? nextBackoffMs;
  const now = opts.now ?? Date.now;
  let cursor;
  let pendingAck = [];
  let failureStreak = 0;
  const ambiguousSeen = /* @__PURE__ */ new Set();
  const replyAttempts = /* @__PURE__ */ new Map();
  let lastSweep = 0;
  const sweep = async () => {
    lastSweep = now();
    await sweepPending?.();
  };
  await sweep();
  while (!abortSignal.aborted) {
    if (now() - lastSweep >= PENDING_SWEEP_INTERVAL_MS) await sweep();
    if (abortSignal.aborted) break;
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
    } catch (error) {
      if (abortSignal.aborted) break;
      failureStreak += 1;
      const backoff = backoffMs(failureStreak);
      log(`filament-poll: poll_work threw (${String(error)}); backing off ${backoff}ms`);
      await sleepAbortable(backoff, abortSignal);
      continue;
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
    if (parsed.busy) {
      const wait = parsed.next_poll_ms > 0 ? parsed.next_poll_ms : BUSY_DEFAULT_WAIT_MS;
      log(`filament-poll: server busy; polling again in ${wait}ms`);
      await sleepAbortable(wait, abortSignal);
      continue;
    }
    pendingAck = [];
    cursor = parsed.cursor;
    for (const offer of parsed.offers) {
      if (abortSignal.aborted) return {};
      await acceptOffer?.(offer);
    }
    for (const item of parsed.work) {
      if (abortSignal.aborted) return {};
      if (!item.reply_with) {
        log(`filament-poll: ${item.channel_id} item has no reply_with; server already consumed it`);
        continue;
      }
      const outcome = await dispatchItem(item);
      const key = itemKey(item);
      const ack = () => pendingAck.push(...item.messages.map((m) => m.event_id));
      if (outcome.kind !== "retry") replyAttempts.delete(key);
      if (outcome.kind === "fatal") {
        log(`filament-poll: item in ${item.channel_id}: ${outcome.diagnostic}; stopping`);
        return { fatal: outcome.diagnostic };
      }
      if (outcome.kind === "silent") ack();
      if (outcome.kind === "dropped") {
        log(`filament-poll: dropping the item in ${item.channel_id}: ${outcome.diagnostic}`);
        ack();
      }
      if (outcome.kind === "retry") {
        const attempts = (replyAttempts.get(key) ?? 0) + 1;
        if (attempts >= MAX_REPLY_ATTEMPTS) {
          replyAttempts.delete(key);
          log(
            `filament-poll: reply in ${item.channel_id} failed ${attempts} times (${outcome.diagnostic}); acknowledging without a reply`
          );
          ack();
        } else {
          replyAttempts.set(key, attempts);
          const backoff = backoffMs(attempts);
          log(
            `filament-poll: reply in ${item.channel_id} failed (${outcome.diagnostic}); retrying on the next offer in ${backoff}ms`
          );
          await sleepAbortable(backoff, abortSignal);
        }
      }
      if (outcome.kind === "ambiguous") {
        if (ambiguousSeen.has(key)) {
          ambiguousSeen.delete(key);
          log(
            `filament-poll: ${item.channel_id} produced no output twice; acknowledging without a reply`
          );
          ack();
        } else {
          ambiguousSeen.add(key);
        }
      }
    }
  }
  return {};
}
export {
  MAX_REPLY_ATTEMPTS,
  PENDING_SWEEP_INTERVAL_MS,
  parsePollWorkResponse,
  runPollLoop
};
