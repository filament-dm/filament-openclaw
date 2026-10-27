import { openTable } from "./store.js";
const PENDING_REPLY_MAX_AGE_MS = 60 * 60 * 1e3;
const MAX_PER_ACCOUNT = 8;
const rows = openTable("pending-replies");
function loadPendingReplies(accountId, mxid, now = Date.now()) {
  const row = rows.get(accountId);
  if (!row || row.mxid !== mxid) return [];
  return row.replies.filter((r) => now - r.savedAt < PENDING_REPLY_MAX_AGE_MS);
}
function savePendingReply(accountId, mxid, reply) {
  const kept = loadPendingReplies(accountId, mxid, reply.savedAt).filter(
    (r) => r.eventIds.at(-1) !== reply.eventIds.at(-1)
  );
  rows.set(accountId, { mxid, replies: [...kept, reply].slice(-MAX_PER_ACCOUNT) });
}
function removePendingReply(accountId, mxid, lastEventId) {
  const kept = loadPendingReplies(accountId, mxid).filter((r) => r.eventIds.at(-1) !== lastEventId);
  if (kept.length) rows.set(accountId, { mxid, replies: kept });
  else rows.delete(accountId);
}
export {
  PENDING_REPLY_MAX_AGE_MS,
  loadPendingReplies,
  removePendingReply,
  savePendingReply
};
