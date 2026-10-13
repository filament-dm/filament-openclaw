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
