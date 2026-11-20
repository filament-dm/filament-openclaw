import { openTable } from "./store.js";

/** Principals the plugin has added to `commands.ownerAllowFrom`, with when. */
const owners = openTable<number>("recorded-owners");

export function ownerRecordedAt(principal: string): number | undefined {
  return owners.get(principal);
}

export function markOwnerRecorded(principal: string, at: number = Date.now()): void {
  owners.set(principal, at);
}
