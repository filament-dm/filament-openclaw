import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import {
  ConnectAbortedError,
  resolveBearer
} from "./credentials.js";
import { sleepAbortable } from "./util.js";
import { FilamentMcpClient } from "./mcp-client.js";
import { classifyGetSelf } from "./onboarding-core.js";
import { saveIdentity } from "./token-store.js";
const GETSELF_MAX_ATTEMPTS = 40;
const GETSELF_INTERVAL_MS = 3e3;
const HEARTBEAT_INTERVAL_MS = 2e4;
async function runConnect(opts) {
  const {
    mcpUrl,
    token,
    accountId = DEFAULT_ACCOUNT_ID,
    log = () => {
    },
    abortSignal,
    fetchImpl = fetch,
    bearerPersistence,
    credential = "exchange"
  } = opts;
  const bearer = await resolveBearer(
    mcpUrl,
    token,
    log,
    abortSignal,
    fetchImpl,
    bearerPersistence,
    credential
  );
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
      throw new Error("bearer rejected");
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
  ConnectAbortedError,
  runConnect
};
//# sourceMappingURL=connect.js.map
