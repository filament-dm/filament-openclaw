import { openTable } from "./store.js";

/**
 * A turn's answer that was ready when the gateway began shutting down and could not be posted.
 * It is kept here, per account and agent, and posted on the next start (or when its item is
 * offered again), so a restart doesn't throw away an answer the model already gave.
 */
export interface PendingReply {
  /** The item's messages; the last one is what the reply answers. */
  eventIds: string[];
  replyWith: { tool: string; args: Record<string, unknown> };
  text: string;
  mediaUrls: string[];
  mediaLocalRoots: string[];
  savedAt: number;
}

interface Row {
  mxid: string;
  replies: PendingReply[];
}

/** Older than this, an answer is stale: the owner has moved on. */
export const PENDING_REPLY_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_PER_ACCOUNT = 8;

const rows = openTable<Row>("pending-replies");

export function loadPendingReplies(
  accountId: string,
  mxid: string,
  now = Date.now(),
): PendingReply[] {
  const row = rows.get(accountId);
  if (!row || row.mxid !== mxid) return [];
  return row.replies.filter((r) => now - r.savedAt < PENDING_REPLY_MAX_AGE_MS);
}

export function savePendingReply(accountId: string, mxid: string, reply: PendingReply): void {
  const kept = loadPendingReplies(accountId, mxid, reply.savedAt).filter(
    (r) => r.eventIds.at(-1) !== reply.eventIds.at(-1),
  );
  rows.set(accountId, { mxid, replies: [...kept, reply].slice(-MAX_PER_ACCOUNT) });
}

export function removePendingReply(accountId: string, mxid: string, lastEventId: string): void {
  const kept = loadPendingReplies(accountId, mxid).filter((r) => r.eventIds.at(-1) !== lastEventId);
  if (kept.length) rows.set(accountId, { mxid, replies: kept });
  else rows.delete(accountId);
}
