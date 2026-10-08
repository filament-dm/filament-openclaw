import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { resolveBearer } from "./credentials.js";
import { nextBackoffMs, sleepAbortable } from "./util.js";
import { FilamentMcpClient } from "./mcp-client.js";
import { classifyGetSelf } from "./onboarding-core.js";
import { saveIdentity } from "./state/identities.js";
const GETSELF_MAX_ATTEMPTS = 40;
const GETSELF_INTERVAL_MS = 3e3;
const HEARTBEAT_INTERVAL_MS = 2e4;
class ConnectAbortedError extends Error {
  constructor() {
    super("connect aborted");
    this.name = "ConnectAbortedError";
  }
}
class BearerRejectedError extends Error {
  constructor() {
    super("bearer rejected");
    this.name = "BearerRejectedError";
  }
}
async function retryConnect(connect, opts = {}) {
  const {
    log = () => {
    },
    abortSignal,
    sleep = sleepAbortable,
    backoff = (attempt) => nextBackoffMs(attempt)
  } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (error) {
      if (abortSignal?.aborted || error instanceof ConnectAbortedError) {
        throw error instanceof ConnectAbortedError ? error : new ConnectAbortedError();
      }
      if (error instanceof BearerRejectedError) throw error;
      const wait = backoff(attempt);
      log(`filament: connect failed: ${String(error)}; retrying in ${wait}ms`);
      await sleep(wait, abortSignal);
      if (abortSignal?.aborted) throw new ConnectAbortedError();
    }
  }
}
async function runConnect(opts) {
  const {
    mcpUrl,
    token,
    accountId = DEFAULT_ACCOUNT_ID,
    log = () => {
    },
    abortSignal,
    fetchImpl = fetch
  } = opts;
  const bearer = resolveBearer(token, log);
  if (abortSignal?.aborted) throw new ConnectAbortedError();
  const client = new FilamentMcpClient(mcpUrl, bearer, void 0, fetchImpl);
  let heartbeatTimer = null;
  const stop = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
  await client.initialize({ signal: abortSignal });
  let identity = null;
  for (let attempt = 1; attempt <= GETSELF_MAX_ATTEMPTS; attempt++) {
    if (abortSignal?.aborted) throw new ConnectAbortedError();
    let res;
    try {
      res = await client.getSelf({ signal: abortSignal });
    } catch (error) {
      if (abortSignal?.aborted) throw new ConnectAbortedError();
      log(
        `filament-connect: get_self attempt ${attempt}/${GETSELF_MAX_ATTEMPTS} threw: ${String(error)}`
      );
      await sleepAbortable(GETSELF_INTERVAL_MS, abortSignal);
      continue;
    }
    const decision = classifyGetSelf(res);
    if (decision.status === "finalized" && decision.identity) {
      identity = decision.identity;
      break;
    }
    if (decision.status === "auth_failed") {
      log("filament-connect: bearer rejected (auth failed)");
      stop();
      throw new BearerRejectedError();
    }
    log(`filament-connect: not finalized yet (attempt ${attempt}/${GETSELF_MAX_ATTEMPTS})`);
    await sleepAbortable(GETSELF_INTERVAL_MS, abortSignal);
  }
  if (!identity) {
    stop();
    throw new Error(
      "agent not finalized within the verification window; will retry on next restart"
    );
  }
  saveIdentity(accountId, { ...identity, onboardedAt: Date.now() });
  log(
    `filament-connect: identity account=${accountId} principal=${identity.principal} ccRoom=${identity.ccRoomId ?? "(none)"}`
  );
  const beat = async () => {
    try {
      await client.heartbeat({ signal: abortSignal });
    } catch (error) {
      if (!abortSignal?.aborted) log(`filament-connect: heartbeat failed: ${String(error)}`);
    }
  };
  await beat();
  heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  abortSignal?.addEventListener("abort", stop, { once: true });
  return { stop, client, identity };
}
export {
  BearerRejectedError,
  ConnectAbortedError,
  retryConnect,
  runConnect
};
