import { openTable } from "./store.js";

/**
 * Per Filament account: the OpenClaw name the plugin last followed, and the Filament name it gave
 * the agent for it (null when it gave none, e.g. the owner had named the agent in Filament).
 */
export interface FollowedName {
  openclaw: string;
  filament: string | null;
}

const names = openTable<FollowedName>("followed-names");

export function followedName(accountId: string): FollowedName | undefined {
  return names.get(accountId);
}

export function recordFollowedName(accountId: string, followed: FollowedName): void {
  names.set(accountId, followed);
}
