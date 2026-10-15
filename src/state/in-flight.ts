import { openTable } from "./store.js";

/**
 * The turns a gateway had running, per account and agent: written before a turn starts, cleared
 * when it ends with an answer or a decision. One that is still here after a restart was cut short,
 * and OpenClaw's own restart recovery runs it again and delivers its answer through the channel's
 * outbound send. Dispatching the redelivered message meanwhile races that recovery: OpenClaw skips
 * it as a duplicate, and can leave the session's recovery claim stale, after which every message to
 * the session fails ("restart recovery claim changed before agent adoption").
 */
export interface InFlightTurn {
  /** The item's last message: what its answer names. */
  eventId: string;
  /** The room it came from. */
  room: string;
  startedAt: number;
  /** The transport run that started it: one from another run survived a restart. */
  run: string;
  /** Set once OpenClaw's recovery has posted to the room: the hold ends at this time. */
  releaseAt?: number;
}

interface Row {
  mxid: string;
  turns: InFlightTurn[];
}

/** Older than this, a marker is history: whatever recovery there was is long over. */
export const IN_FLIGHT_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_PER_ACCOUNT = 8;

const rows = openTable<Row>("in-flight-turns");

export function loadInFlight(accountId: string, mxid: string, now = Date.now()): InFlightTurn[] {
  const row = rows.get(accountId);
  if (!row || row.mxid !== mxid) return [];
  return row.turns.filter((t) => now - t.startedAt < IN_FLIGHT_MAX_AGE_MS);
}

export function markInFlight(accountId: string, mxid: string, turn: InFlightTurn): void {
  const kept = loadInFlight(accountId, mxid, turn.startedAt).filter(
    (t) => t.eventId !== turn.eventId,
  );
  rows.set(accountId, { mxid, turns: [...kept, turn].slice(-MAX_PER_ACCOUNT) });
}

/** Clears one turn's marker, or every marker other runs left (`notRun`). */
export function clearInFlight(
  accountId: string,
  mxid: string,
  match: { eventId: string } | { notRun: string },
): void {
  const kept = loadInFlight(accountId, mxid).filter((t) =>
    "eventId" in match ? t.eventId !== match.eventId : t.run === match.notRun,
  );
  if (kept.length) rows.set(accountId, { mxid, turns: kept });
  else rows.delete(accountId);
}

// The transport run now live per account: markers from any other run survived a restart.
const liveRuns = new Map<string, string>();

export function setLiveRun(accountId: string, run: string | null): void {
  if (run) liveRuns.set(accountId, run);
  else liveRuns.delete(accountId);
}

/** Markers a restart left in a room (the outbound send and the recovery hook know no mxid). */
export function interruptedIn(accountId: string, room: string, now = Date.now()): InFlightTurn[] {
  const row = rows.get(accountId);
  const live = liveRuns.get(accountId);
  if (!row) return [];
  return row.turns.filter(
    (t) => t.room === room && t.run !== live && now - t.startedAt < IN_FLIGHT_MAX_AGE_MS,
  );
}

/**
 * OpenClaw's recovery has posted to a room: it is under way, so its claim is adopted, and the
 * room's interrupted turns stop holding new work a short grace later. (The plugin can't see the
 * recovery run end: the agent_end hook needs conversation access a non-bundled plugin doesn't get.)
 */
export function releaseInterruptedIn(accountId: string, room: string, at: number): void {
  const row = rows.get(accountId);
  const live = liveRuns.get(accountId);
  if (!row) return;
  let changed = false;
  const turns = row.turns.map((t) => {
    if (t.room !== room || t.run === live || t.releaseAt !== undefined) return t;
    changed = true;
    return { ...t, releaseAt: at };
  });
  if (changed) rows.set(accountId, { mxid: row.mxid, turns });
}

/** OpenClaw's recovery for a room is over: its interrupted turns wait no longer. */
export function clearInterruptedIn(accountId: string, room: string): void {
  const row = rows.get(accountId);
  const live = liveRuns.get(accountId);
  if (!row) return;
  const kept = row.turns.filter((t) => t.room !== room || t.run === live);
  if (kept.length === row.turns.length) return;
  if (kept.length) rows.set(accountId, { mxid: row.mxid, turns: kept });
  else rows.delete(accountId);
}
