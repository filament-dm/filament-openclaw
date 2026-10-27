import { openTable } from "./store.js";
const cursors = openTable("poll-cursors");
function loadPollCursor(accountId, mxid) {
  const row = cursors.get(accountId);
  return row?.mxid === mxid ? row.cursor : void 0;
}
function savePollCursor(accountId, mxid, cursor) {
  cursors.set(accountId, { mxid, cursor });
}
export {
  loadPollCursor,
  savePollCursor
};
