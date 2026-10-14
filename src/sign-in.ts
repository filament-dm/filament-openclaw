/**
 * A device sign-in the gateway finishes. `openclaw filament login` asks Filament for a device
 * code, prints the link and code, saves the code as the account's `pendingSignIn` and exits: an
 * agent's shell may not outlive the call that ran it. The account, started with no token, polls
 * Filament until the owner approves, then saves the token in place of the pending sign-in, and
 * the reload that write causes connects it as usual. The device code is a credential until
 * redeemed, so it is never logged.
 */
import { asRecord, FILAMENT_CHANNEL_ID, PLUGIN_ID } from "./accounts.js";
import {
  LoginError,
  pollDeviceToken,
  type DeviceAuthorization,
  type PollOptions,
} from "./oauth-login.js";
import type { SignInEnd } from "./state/sign-in.js";

/** As the config keeps it: `expiresAt` is an ISO time, so the file reads plainly. */
export interface PendingSignIn {
  deviceCode: string;
  clientId: string;
  tokenEndpoint: string;
  resource: string;
  interval: number;
  expiresAt: string;
}

export function toPendingSignIn(auth: DeviceAuthorization): PendingSignIn {
  return {
    deviceCode: auth.deviceCode,
    clientId: auth.clientId,
    tokenEndpoint: auth.tokenEndpoint,
    resource: auth.resource,
    interval: auth.interval,
    expiresAt: new Date(auth.expiresAt).toISOString(),
  };
}

/** The account's pending sign-in, if it has a usable one. */
export function parsePendingSignIn(raw: unknown): DeviceAuthorization | undefined {
  const entry = asRecord(raw);
  const text = (key: string) =>
    typeof entry[key] === "string" && entry[key] ? (entry[key] as string) : undefined;
  const deviceCode = text("deviceCode");
  const clientId = text("clientId");
  const tokenEndpoint = text("tokenEndpoint");
  const resource = text("resource");
  const expiresAt = Date.parse(text("expiresAt") ?? "");
  if (!deviceCode || !clientId || !tokenEndpoint || !resource || Number.isNaN(expiresAt)) {
    return undefined;
  }
  const interval = typeof entry.interval === "number" && entry.interval > 0 ? entry.interval : 5;
  return { deviceCode, clientId, tokenEndpoint, resource, interval, expiresAt };
}

function accountsOf(draft: Record<string, unknown>): Record<string, unknown> {
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  return asRecord(config.accounts);
}

/**
 * Ends `deviceCode`'s pending sign-in on `accountId`. With a token the account keeps it; without
 * one the account and its binding go, since an account with neither is not one. False when a
 * newer login replaced it meanwhile: that one is left alone.
 */
export function applySignInResult(
  draft: Record<string, unknown>,
  accountId: string,
  deviceCode: string,
  token?: string,
): boolean {
  const accounts = accountsOf(draft);
  const account = asRecord(accounts[accountId]);
  if (asRecord(account.pendingSignIn).deviceCode !== deviceCode) return false;
  delete account.pendingSignIn;
  if (token) {
    account.connectToken = token;
    return true;
  }
  delete accounts[accountId];
  if (Array.isArray(draft.bindings)) {
    draft.bindings = draft.bindings.filter((raw) => {
      const match = asRecord(asRecord(raw).match);
      return match.channel !== FILAMENT_CHANNEL_ID || match.accountId !== accountId;
    });
  }
  return true;
}

export type SignInOutcome = "signed-in" | SignInEnd["reason"] | "superseded" | "aborted";

export interface FinishSignInParams extends Pick<PollOptions, "fetch" | "sleep" | "now"> {
  accountId: string;
  pending: DeviceAuthorization;
  abortSignal: AbortSignal;
  log: (message: string) => void;
  writeConfig: (mutate: (draft: Record<string, unknown>) => void) => Promise<boolean>;
  saveEnd?: (accountId: string, end: SignInEnd) => void;
  clearEnd?: (accountId: string) => void;
  /** Between failed attempts to save the token. */
  retryWriteMs?: number;
}

/** Polls until the owner approves or the link ends, then writes the outcome to the config. */
export async function finishPendingSignIn(params: FinishSignInParams): Promise<SignInOutcome> {
  const { accountId, pending, abortSignal, log } = params;
  const now = params.now ?? Date.now;
  log("filament: waiting for sign-in approval");
  let token: string;
  try {
    let unreachable = false;
    token = await pollDeviceToken(pending, {
      fetch: params.fetch,
      sleep: params.sleep,
      now,
      signal: abortSignal,
      // Said once per outage: polling goes on until the link expires.
      onTransientError: (error) => {
        if (!unreachable) log(`filament: sign-in poll failed, retrying: ${error.message}`);
        unreachable = true;
      },
    });
  } catch (error) {
    if (abortSignal.aborted) return "aborted";
    const reason: SignInEnd["reason"] =
      error instanceof LoginError && error.reason === "expired"
        ? "expired"
        : error instanceof LoginError && error.reason === "denied"
          ? "denied"
          : "failed";
    log(
      reason === "expired"
        ? "filament: sign-in link expired; run openclaw filament login again"
        : reason === "denied"
          ? "filament: sign-in was declined; run openclaw filament login again"
          : `filament: sign-in failed (${error instanceof Error ? error.message : String(error)}); run openclaw filament login again`,
    );
    params.saveEnd?.(accountId, { reason, at: now() });
    let current = true;
    await params
      .writeConfig((draft) => {
        current = applySignInResult(draft, accountId, pending.deviceCode);
      })
      .catch((writeError) => {
        log(`filament: could not clear the ended sign-in: ${String(writeError)}`);
      });
    return current ? reason : "superseded";
  }

  // The token is issued once: keep trying to save it while this account lives.
  log("filament: sign-in approved; saving the token");
  params.clearEnd?.(accountId);
  for (;;) {
    try {
      let current = true;
      await params.writeConfig((draft) => {
        current = applySignInResult(draft, accountId, pending.deviceCode, token);
      });
      if (!current) {
        log("filament: a newer sign-in replaced this one; dropping its token");
        return "superseded";
      }
      return "signed-in";
    } catch (error) {
      log(`filament: could not save the sign-in, retrying: ${String(error)}`);
      if (abortSignal.aborted) return "aborted";
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, params.retryWriteMs ?? 5000);
        function done() {
          clearTimeout(timer);
          abortSignal.removeEventListener("abort", done);
          resolve();
        }
        abortSignal.addEventListener("abort", done, { once: true });
      });
      if (abortSignal.aborted) return "aborted";
    }
  }
}
