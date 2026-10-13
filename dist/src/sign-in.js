import { asRecord, FILAMENT_CHANNEL_ID, PLUGIN_ID } from "./accounts.js";
import {
  LoginError,
  pollDeviceToken
} from "./oauth-login.js";
function toPendingSignIn(auth) {
  return {
    deviceCode: auth.deviceCode,
    clientId: auth.clientId,
    tokenEndpoint: auth.tokenEndpoint,
    resource: auth.resource,
    interval: auth.interval,
    expiresAt: new Date(auth.expiresAt).toISOString()
  };
}
function parsePendingSignIn(raw) {
  const entry = asRecord(raw);
  const text = (key) => typeof entry[key] === "string" && entry[key] ? entry[key] : void 0;
  const deviceCode = text("deviceCode");
  const clientId = text("clientId");
  const tokenEndpoint = text("tokenEndpoint");
  const resource = text("resource");
  const expiresAt = Date.parse(text("expiresAt") ?? "");
  if (!deviceCode || !clientId || !tokenEndpoint || !resource || Number.isNaN(expiresAt)) {
    return void 0;
  }
  const interval = typeof entry.interval === "number" && entry.interval > 0 ? entry.interval : 5;
  return { deviceCode, clientId, tokenEndpoint, resource, interval, expiresAt };
}
function accountsOf(draft) {
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  return asRecord(config.accounts);
}
function applySignInResult(draft, accountId, deviceCode, token) {
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
async function finishPendingSignIn(params) {
  const { accountId, pending, abortSignal, log } = params;
  const now = params.now ?? Date.now;
  log("filament: waiting for sign-in approval");
  let token;
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
      }
    });
  } catch (error) {
    if (abortSignal.aborted) return "aborted";
    const reason = error instanceof LoginError && error.reason === "expired" ? "expired" : error instanceof LoginError && error.reason === "denied" ? "denied" : "failed";
    log(
      reason === "expired" ? "filament: sign-in link expired; run openclaw filament login again" : reason === "denied" ? "filament: sign-in was declined; run openclaw filament login again" : `filament: sign-in failed (${error instanceof Error ? error.message : String(error)}); run openclaw filament login again`
    );
    params.saveEnd?.(accountId, { reason, at: now() });
    let current = true;
    await params.writeConfig((draft) => {
      current = applySignInResult(draft, accountId, pending.deviceCode);
    }).catch((writeError) => {
      log(`filament: could not clear the ended sign-in: ${String(writeError)}`);
    });
    return current ? reason : "superseded";
  }
  log("filament: sign-in approved; saving the token");
  params.clearEnd?.(accountId);
  for (; ; ) {
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
      await new Promise((resolve) => {
        const timer = setTimeout(done, params.retryWriteMs ?? 5e3);
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
export {
  applySignInResult,
  finishPendingSignIn,
  parsePendingSignIn,
  toPendingSignIn
};
