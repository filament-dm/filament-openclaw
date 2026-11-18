import { openTable } from "./store.js";

/** The Filament agent (mxid) each account last said its first hello as. */
const hellos = openTable<string>("first-hellos");

export function helloSentAs(accountId: string): string | undefined {
  return hellos.get(accountId);
}

export function markHelloSent(accountId: string, mxid: string): void {
  hellos.set(accountId, mxid);
}

/**
 * The Filament agent (mxid) each account still owes its one look around: left when a new agent's
 * first hello lands, taken as the look starts, so no restart repeats it.
 */
const lookAroundsDue = openTable<string>("look-arounds-due");

export function markLookAroundDue(accountId: string, mxid: string): void {
  lookAroundsDue.set(accountId, mxid);
}

export function lookAroundDueFor(accountId: string): string | undefined {
  return lookAroundsDue.get(accountId);
}

export function takeLookAroundDue(accountId: string): string | undefined {
  return lookAroundsDue.take(accountId);
}
