import { openTable } from "./store.js";

/**
 * The last poll_work cursor each account sent, and the agent (mxid) it belongs to. A restart sends
 * it again instead of none: the server would otherwise start from its own saved position, which a
 * poll still waiting when the gateway stopped can move past work that never reached the gateway.
 */
const cursors = openTable<{ mxid: string; cursor: string }>("poll-cursors");

export function loadPollCursor(accountId: string, mxid: string): string | undefined {
  const row = cursors.get(accountId);
  return row?.mxid === mxid ? row.cursor : undefined;
}

export function savePollCursor(accountId: string, mxid: string, cursor: string): void {
  cursors.set(accountId, { mxid, cursor });
}
