import { openTable } from "./store.js";

/** eneris `Credentials`, persisted opaquely so a restart keeps the push token. */
export interface FcmCredentials {
  fcm?: { token?: string };
  [key: string]: unknown;
}

// Tagged with its Firebase project: after a project change the old token can never be delivered
// to, so the account must re-register.
interface StoredFcm {
  project: string;
  credentials: FcmCredentials;
}

const registrations = openTable<StoredFcm>("fcm-registrations");
// Processed push ids, so Google does not redeliver them. Bounded because the list is also sent in
// the MCS login payload.
const received = openTable<string[]>("fcm-received");
const RECEIVED_IDS_MAX = 1_000;

export function loadFcmCredentials(
  accountId: string,
  projectId: string,
): FcmCredentials | undefined {
  const stored = registrations.get(accountId);
  return stored && stored.project === projectId ? stored.credentials : undefined;
}

export function hasFcmCredentialsForOtherProject(accountId: string, projectId: string): boolean {
  const stored = registrations.get(accountId);
  return stored !== undefined && stored.project !== projectId;
}

export function saveFcmCredentials(
  accountId: string,
  credentials: FcmCredentials,
  projectId: string,
): void {
  registrations.set(accountId, { project: projectId, credentials });
}

export function loadReceivedIds(accountId: string): string[] {
  return received.get(accountId) ?? [];
}

/** False when the id was already recorded (a redelivery). */
export function recordReceivedId(accountId: string, id: string): boolean {
  if (!id) return false;
  const current = loadReceivedIds(accountId);
  if (current.includes(id)) return false;
  const next = [...current, id];
  if (next.length > RECEIVED_IDS_MAX) next.splice(0, next.length - RECEIVED_IDS_MAX);
  received.set(accountId, next);
  return true;
}
