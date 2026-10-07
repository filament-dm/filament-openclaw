import { openTable } from "./store.js";

/** One record per gateway, shared by every account: one version check and one notice a day. */
export interface UpdateCheckState {
  lastCheckedAt?: number;
  notifiedVersion?: string;
}

/** Left by the account that ran the update, read back by the same account after the reload. */
interface UpdateRequest {
  fromVersion: string;
}

const checks = openTable<UpdateCheckState>("update-state", 4);
const requests = openTable<UpdateRequest>("update-requests");
const GATEWAY = "gateway";

export function loadUpdateState(): UpdateCheckState {
  return checks.get(GATEWAY) ?? {};
}

export function saveUpdateState(state: UpdateCheckState): void {
  checks.set(GATEWAY, state);
}

export function markUpdateRequested(accountId: string, fromVersion: string): void {
  requests.set(accountId, { fromVersion });
}

export function takeUpdateRequest(accountId: string): UpdateRequest | undefined {
  return requests.take(accountId);
}
