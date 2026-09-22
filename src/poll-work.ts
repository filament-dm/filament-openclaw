/**
 * The `poll_work` long-poll loop: the transport this plugin now uses instead
 * of FCM. Runs inside the channel's `startAccount` (see src/channel.ts),
 * sequential and cancelable via the gateway's `ctx.abortSignal`.
 *
 *   poll_work({cursor, ack, wait_seconds, max_items: 1})
 *     → for each item: dispatch one agent turn → publish once → (loop)
 *
 * No timer: the next call is issued immediately after the previous one
 * resolves (`wait_seconds` provides the blocking wait server-side). Backoff
 * only applies on a failed poll_work call itself (network/5xx/429/protocol),
 * never on ordinary empty results.
 *
 * The cursor is kept in memory only (not persisted) — see token-store.ts's
 * header for why that's an acceptable PoC tradeoff: a restart re-scans from
 * scratch, and already-answered items are skipped server-side regardless.
 */
import { type CallOptions, type FilamentMcpClient, POLL_TIMEOUT_MARGIN_MS } from "./mcp-client.js";
import { nextBackoffMs, sleepAbortable } from "./util.js";

export interface PollWorkMessage {
  event_id: string;
  sender: string;
  body: string;
  ts: number;
}

export interface ReplyWithSpec {
  tool: string;
  args: Record<string, unknown>;
}

export interface PollWorkItem {
  channel_id: string;
  thread_id: string | null;
  is_backchannel: boolean;
  messages: PollWorkMessage[];
  reply_with: ReplyWithSpec | null;
}

interface ParsedPollWorkResponse {
  work: PollWorkItem[];
  cursor: string;
  next_poll_ms: number;
  truncated: boolean;
  acknowledged: number;
}

/** Defensively validate the poll_work response shape before trusting it. */
export function parsePollWorkResponse(data: unknown): ParsedPollWorkResponse | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.work) || typeof d.cursor !== "string") return null;
  const work: PollWorkItem[] = [];
  for (const raw of d.work) {
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
        body: typeof m.body === "string" ? m.body : "",
        ts: typeof m.ts === "number" ? m.ts : 0,
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
      messages,
      reply_with: replyWith,
    });
  }
  return {
    work,
    cursor: d.cursor,
    next_poll_ms: typeof d.next_poll_ms === "number" ? d.next_poll_ms : 0,
    truncated: d.truncated === true,
    acknowledged: typeof d.acknowledged === "number" ? d.acknowledged : 0,
  };
}

/** What happened when an item was dispatched. */
export type DispatchOutcome =
  | { kind: "published" }
  | { kind: "silent" } // deliberate silence, evidenced by the SDK: ack it.
  | { kind: "ambiguous" } // no finals, no explicit skip signal, no error: leave it be (no ack, no pause).
  | { kind: "error"; diagnostic: string }; // no ack, no publish; the account pauses.

/** Minimal client surface the loop needs (matches FilamentMcpClient). */
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
  /** Overridable for tests (defaults to exponential backoff with jitter). */
  backoffMs?: (attempt: number) => number;
}

export interface PollLoopResult {
  /** Present when the loop stopped for a reason the account should surface
   * (auth rejected, or a dispatch/publish failure). Absent on a clean abort. */
  fatal?: string;
}

const DEFAULT_WAIT_SECONDS = 60;

function itemKey(item: PollWorkItem): string {
  const ids = item.messages.map((m) => m.event_id).sort();
  return `${item.channel_id}\u0000${item.thread_id ?? ""}\u0000${ids.join(",")}`;
}
const DEFAULT_MAX_ITEMS = 1;

export async function runPollLoop(opts: PollLoopOptions): Promise<PollLoopResult> {
  const { client, abortSignal, log, dispatchItem } = opts;
  const waitSeconds = opts.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const backoffMs = opts.backoffMs ?? nextBackoffMs;

  let cursor: string | undefined;
  let pendingAck: string[] = [];
  let failureStreak = 0;
  // Items that came back "ambiguous" once, keyed by place + event_ids. The
  // server re-offers an unanswered, un-ack'd item on the very next poll (its
  // cursor never advances past delivered work), so without this a turn that
  // keeps producing nothing would re-run the model on every poll.
  const ambiguousSeen = new Set<string>();

  while (!abortSignal.aborted) {
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
    } catch {
      // Caller-initiated abort (see mcp-client.ts's post()): exit quietly.
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
    pendingAck = [];
    cursor = parsed.cursor;

    for (const item of parsed.work) {
      if (abortSignal.aborted) return {};
      if (!item.reply_with) {
        // The server already marked this read (_consume_unanswerable) —
        // nothing the agent could do would consume it.
        log(`filament-poll: ${item.channel_id} item has no reply_with; server already consumed it`);
        continue;
      }
      const outcome = await dispatchItem(item);
      if (outcome.kind === "error") {
        log(
          `filament-poll: item dispatch failed (${item.channel_id}): ${outcome.diagnostic}; pausing`,
        );
        return { fatal: `dispatch: ${outcome.diagnostic}` };
      }
      if (outcome.kind === "silent") {
        pendingAck.push(...item.messages.map((m) => m.event_id));
      }
      if (outcome.kind === "ambiguous") {
        // First time: leave it unacknowledged so it is re-offered once more
        // rather than silently counted as done. Second time for the same
        // messages: ack it and say so, instead of re-running the model on
        // every poll for an item that keeps yielding nothing.
        const key = itemKey(item);
        if (ambiguousSeen.has(key)) {
          ambiguousSeen.delete(key);
          log(
            `filament-poll: ${item.channel_id} produced no output twice; acknowledging without a reply`,
          );
          pendingAck.push(...item.messages.map((m) => m.event_id));
        } else {
          ambiguousSeen.add(key);
        }
      }
      // "published": the write tool already marked it answered — no ack.
    }
  }
  return {};
}
