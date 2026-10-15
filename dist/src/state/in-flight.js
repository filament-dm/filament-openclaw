import { openTable } from "./store.js";
const IN_FLIGHT_MAX_AGE_MS = 15 * 60 * 1e3;
const MAX_PER_ACCOUNT = 8;
const rows = openTable("in-flight-turns");
function loadInFlight(accountId, mxid, now = Date.now()) {
  const row = rows.get(accountId);
  if (!row || row.mxid !== mxid) return [];
  return row.turns.filter((t) => now - t.startedAt < IN_FLIGHT_MAX_AGE_MS);
}
function markInFlight(accountId, mxid, turn) {
  const kept = loadInFlight(accountId, mxid, turn.startedAt).filter(
    (t) => t.eventId !== turn.eventId
  );
  rows.set(accountId, { mxid, turns: [...kept, turn].slice(-MAX_PER_ACCOUNT) });
}
function clearInFlight(accountId, mxid, match) {
  const kept = loadInFlight(accountId, mxid).filter(
    (t) => "eventId" in match ? t.eventId !== match.eventId : t.run === match.notRun
  );
  if (kept.length) rows.set(accountId, { mxid, turns: kept });
  else rows.delete(accountId);
}
const liveRuns = /* @__PURE__ */ new Map();
function setLiveRun(accountId, run) {
  if (run) liveRuns.set(accountId, run);
  else liveRuns.delete(accountId);
}
function interruptedIn(accountId, room, now = Date.now()) {
  const row = rows.get(accountId);
  const live = liveRuns.get(accountId);
  if (!row) return [];
  return row.turns.filter(
    (t) => t.room === room && t.run !== live && now - t.startedAt < IN_FLIGHT_MAX_AGE_MS
  );
}
function releaseInterruptedIn(accountId, room, at) {
  const row = rows.get(accountId);
  const live = liveRuns.get(accountId);
  if (!row) return;
  let changed = false;
  const turns = row.turns.map((t) => {
    if (t.room !== room || t.run === live || t.releaseAt !== void 0) return t;
    changed = true;
    return { ...t, releaseAt: at };
  });
  if (changed) rows.set(accountId, { mxid: row.mxid, turns });
}
function clearInterruptedIn(accountId, room) {
  const row = rows.get(accountId);
  const live = liveRuns.get(accountId);
  if (!row) return;
  const kept = row.turns.filter((t) => t.room !== room || t.run === live);
  if (kept.length === row.turns.length) return;
  if (kept.length) rows.set(accountId, { mxid: row.mxid, turns: kept });
  else rows.delete(accountId);
}
export {
  IN_FLIGHT_MAX_AGE_MS,
  clearInFlight,
  clearInterruptedIn,
  interruptedIn,
  loadInFlight,
  markInFlight,
  releaseInterruptedIn,
  setLiveRun
};
