import { openTable } from "./store.js";

/** The Filament agent (mxid) each account last said its first hello as. */
const hellos = openTable<string>("first-hellos");

export function helloSentAs(accountId: string): string | undefined {
  return hellos.get(accountId);
}

export function markHelloSent(accountId: string, mxid: string): void {
  hellos.set(accountId, mxid);
}
