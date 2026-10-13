import { createHash } from "node:crypto";

import { openTable } from "./store.js";

/**
 * How an account's last pending sign-in ended without a token, for `openclaw filament status`:
 * the gateway drops the pending sign-in from the config when it ends, so the config cannot say.
 */
export interface SignInEnd {
  reason: "expired" | "denied" | "failed";
  at: number;
}

const ends = openTable<SignInEnd>("sign-in-ends");

export function loadSignInEnd(accountId: string): SignInEnd | undefined {
  return ends.get(accountId);
}

export function saveSignInEnd(accountId: string, end: SignInEnd): void {
  ends.set(accountId, end);
}

export function clearSignInEnd(accountId: string): void {
  ends.delete(accountId);
}

/**
 * An account whose bearer Filament rejected (the agent was deleted or its token revoked), by a
 * fingerprint of the connect token it had: a new login's token is not the one rejected.
 */
export interface RevokedBearer {
  fingerprint: string;
  at: number;
}

const revoked = openTable<RevokedBearer>("revoked-bearers");

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function loadRevoked(accountId: string): RevokedBearer | undefined {
  return revoked.get(accountId);
}

export function markRevoked(accountId: string, token: string, at = Date.now()): void {
  revoked.set(accountId, { fingerprint: tokenFingerprint(token), at });
}

export function clearRevoked(accountId: string): void {
  revoked.delete(accountId);
}
