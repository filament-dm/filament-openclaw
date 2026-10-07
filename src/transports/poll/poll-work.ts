/**
 * The `poll_work` long-poll loop. The next call goes out as soon as the previous one resolves
 * (`wait_seconds` blocks server-side); it waits only after a failure, a reply that may not have
 * landed, or a `busy` answer. The cursor is in memory only: a restart re-scans unread work.
 *
 * Pending invites and vouches are swept at start, on an `invites` hint, and every
 * `PENDING_SWEEP_INTERVAL_MS`: a vouch never shows up in `invites`.
 */
import {
  type CallOptions,
  type FilamentMcpClient,
  POLL_TIMEOUT_MARGIN_MS,
} from "../../mcp-client.js";
import { nextBackoffMs, sleepAbortable } from "../../util.js";
import {
  ATTACHMENT_ONLY_BODY,
  type DispatchOutcome,
  type WorkItem,
  type WorkMessage,
} from "../../work-item.js";

export type { DispatchOutcome };

export interface PollWorkMessage extends WorkMessage {
  is_mention?: boolean;
  sender_is_agent?: boolean;
  is_implicitly_mentioned?: boolean;
  reply_expected?: boolean;
}

export interface ReplyWithSpec {
  tool: string;
  args: Record<string, unknown>;
}

export interface PollWorkItem extends WorkItem {
  messages: PollWorkMessage[];
  reply_with: ReplyWithSpec | null;
}

/** A pending invite the server saw while scanning: a hint to sweep, not work. */
export interface PollInvite {
  room_id: string;
}

interface ParsedPollWorkResponse {
  work: PollWorkItem[];
  cursor: string;
  next_poll_ms: number;
  truncated: boolean;
  acknowledged: number;
  invites: PollInvite[];
  busy: boolean;
}

export function parsePollWorkResponse(data: unknown): ParsedPollWorkResponse | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const busy = d.busy === true;
  if (!busy && (!Array.isArray(d.work) || typeof d.cursor !== "string")) return null;
  const work: PollWorkItem[] = [];
  for (const raw of Array.isArray(d.work) ? d.work : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.channel_id !== "string" || !Array.isArray(r.messages)) continue;
    const messages: PollWorkMessage[] = r.messages
      .filter(
        (m): m is Record<string, unknown> =>
          !!m &&
          typeof m === "object" &&
          typeof (m as Record<string, unknown>).event_id === "string",
      )
      .map((m) => ({
        event_id: String(m.event_id),
        sender: typeof m.sender === "string" ? m.sender : "unknown",
        body:
          typeof m.body === "string" && m.body
            ? m.body
            : m.has_media === true
              ? ATTACHMENT_ONLY_BODY
              : "",
        ts: typeof m.ts === "number" ? m.ts : 0,
        is_mention: m.is_mention === true,
        sender_is_agent: m.sender_is_agent === true,
        ...(typeof m.is_implicitly_mentioned === "boolean"
          ? { is_implicitly_mentioned: m.is_implicitly_mentioned }
          : {}),
        ...(typeof m.reply_expected === "boolean" ? { reply_expected: m.reply_expected } : {}),
      }));
    const rw = r.reply_with;
    const replyWith: ReplyWithSpec | null =
      rw && typeof rw === "object" && typeof (rw as Record<string, unknown>).tool === "string"
        ? {
            tool: String((rw as Record<string, unknown>).tool),
            args:
              ((rw as Record<string, unknown>).args as Record<string, unknown> | undefined) ?? {},
          }
        : null;
    work.push({
      channel_id: r.channel_id,
      thread_id: typeof r.thread_id === "string" ? r.thread_id : null,
      is_backchannel: r.is_backchannel === true,
      is_direct: r.is_direct === true,
      messages,
      reply_with: replyWith,
    });
  }
  const invites: PollInvite[] = (Array.isArray(d.invites) ? d.invites : [])
    .filter(
      (i): i is Record<string, unknown> =>
        !!i && typeof i === "object" && typeof (i as Record<string, unknown>).room_id === "string",
    )
    .map((i) => ({ room_id: String(i.room_id) }));
  return {
    work,
    cursor: typeof d.cursor === "string" ? d.cursor : "",
    next_poll_ms: typeof d.next_poll_ms === "number" ? d.next_poll_ms : 0,
    truncated: d.truncated === true,
    acknowledged: typeof d.acknowledged === "number" ? d.acknowledged : 0,
    invites,
    busy,
  };
}

export interface PollClient {
  pollWork(
    args: { cursor?: string | null; ack?: string[]; wait_seconds: number; max_items: number },
    opts?: CallOptions,
  ): ReturnType<FilamentMcpClient["pollWork"]>;
}

export interface PollLoopOptions {
  client: PollClient;
  abortSignal: AbortSignal;
  log: (message: string) => void;
  dispatchItem: (item: PollWorkItem) => Promise<DispatchOutcome>;
  waitSeconds?: number;
  maxItems?: number;
  /** Never throws. Absent: no sweeps. */
  sweepPending?: () => Promise<void>;
  backoffMs?: (attempt: number) => number;
  now?: () => number;
}

export interface PollLoopResult {
  fatal?: string;
}

export const PENDING_SWEEP_INTERVAL_MS = 10 * 60_000;
export const MAX_REPLY_ATTEMPTS = 3;
const BUSY_DEFAULT_WAIT_MS = 1_000;

// The server's default. Waits near 60s can lose the race against an intermediary proxy's timeout.
const DEFAULT_WAIT_SECONDS = 30;

function itemKey(item: PollWorkItem): string {
  const ids = item.messages.map((m) => m.event_id).sort();
  return `${item.channel_id}\u0000${item.thread_id ?? ""}\u0000${ids.join(",")}`;
}
const DEFAULT_MAX_ITEMS = 1;

export async function runPollLoop(opts: PollLoopOptions): Promise<PollLoopResult> {
  const { client, abortSignal, log, dispatchItem, sweepPending } = opts;
  const waitSeconds = opts.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const backoffMs = opts.backoffMs ?? nextBackoffMs;
  const now = opts.now ?? Date.now;

  let cursor: string | undefined;
  let pendingAck: string[] = [];
  let failureStreak = 0;
  // The server re-offers an unanswered, unacked item on the next poll, so without these a turn that
  // keeps producing nothing, or a reply that keeps failing, would re-run the model on every poll.
  const ambiguousSeen = new Set<string>();
  const replyAttempts = new Map<string, number>();

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
          ack: pendingAck.length ? pendingAck : undefined,
          wait_seconds: waitSeconds,
          max_items: maxItems,
        },
        { signal: abortSignal, timeoutMs: waitSeconds * 1000 + POLL_TIMEOUT_MARGIN_MS },
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
        `filament-poll: poll_work failed (${result.kind ?? "unknown"}): ${result.error?.message ?? "?"}; backing off ${backoff}ms`,
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
      // Too many polls in flight for this agent. Keep the cursor and the
      // pending acks: nothing says the server looked at either.
      const wait = parsed.next_poll_ms > 0 ? parsed.next_poll_ms : BUSY_DEFAULT_WAIT_MS;
      log(`filament-poll: server busy; polling again in ${wait}ms`);
      await sleepAbortable(wait, abortSignal);
      continue;
    }
    pendingAck = [];
    cursor = parsed.cursor;
    if (parsed.invites.length > 0) await sweep();

    for (const item of parsed.work) {
      if (abortSignal.aborted) return {};
      if (!item.reply_with) {
        // The server already marked this read: nothing the agent could do would consume it.
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
            `filament-poll: reply in ${item.channel_id} failed ${attempts} times (${outcome.diagnostic}); acknowledging without a reply`,
          );
          ack();
        } else {
          replyAttempts.set(key, attempts);
          const backoff = backoffMs(attempts);
          log(
            `filament-poll: reply in ${item.channel_id} failed (${outcome.diagnostic}); retrying on the next offer in ${backoff}ms`,
          );
          await sleepAbortable(backoff, abortSignal);
        }
      }
      if (outcome.kind === "ambiguous") {
        // Re-offered once more, then acked: no silent success, and no model run on every poll.
        if (ambiguousSeen.has(key)) {
          ambiguousSeen.delete(key);
          log(
            `filament-poll: ${item.channel_id} produced no output twice; acknowledging without a reply`,
          );
          ack();
        } else {
          ambiguousSeen.add(key);
        }
      }
      // "published": replying already acknowledged it.
    }
  }
  return {};
}
