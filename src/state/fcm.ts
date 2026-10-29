import { openTable } from "./store.js";

/**
 * What the removed FCM transport kept per account: its push registration, keys included, and the
 * ids of pushes it had handled. Nothing reads them any more; an account drops its rows at start.
 * The server's copy of the push token is not ours to remove: no agent tool unregisters it.
 */
const registrations = openTable<unknown>("fcm-registrations");
const received = openTable<unknown>("fcm-received");

export function forgetFcmState(accountId: string): void {
  registrations.delete(accountId);
  received.delete(accountId);
}
