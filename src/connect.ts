/**
 * The connect sequence both transports share: resolve the bearer, poll `get_self` until the agent
 * is finalized, then keep a presence heartbeat.
 */
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { resolveBearer } from "./credentials.js";
import { nextBackoffMs, sleepAbortable } from "./util.js";
import { FilamentMcpClient, type ToolCallResult } from "./mcp-client.js";
import { classifyGetSelf, type ResolvedIdentity } from "./onboarding-core.js";
import { saveIdentity } from "./token-store.js";

const GETSELF_MAX_ATTEMPTS = 40; // ~2 min at the default 3s interval
const GETSELF_INTERVAL_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 20_000; // < 30s presence-decay window

export class ConnectAbortedError extends Error {
  constructor() {
    super("connect aborted");
    this.name = "ConnectAbortedError";
  }
}

/** Thrown when the server refuses the bearer: retrying cannot fix it. */
export class BearerRejectedError extends Error {
  constructor() {
    super("bearer rejected");
    this.name = "BearerRejectedError";
  }
}

export interface RetryConnectOptions {
  log?: (msg: string) => void;
  abortSignal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  backoff?: (attempt: number) => number;
}

/**
 * A gateway that starts before Filament is reachable would otherwise leave the account idle until
 * the next restart. A rejected bearer or an abort ends the attempts.
 */
export async function retryConnect<T>(
  connect: () => Promise<T>,
  opts: RetryConnectOptions = {},
): Promise<T> {
  const {
    log = () => {},
    abortSignal,
    sleep = sleepAbortable,
    backoff = (attempt) => nextBackoffMs(attempt),
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

export interface ConnectHandle {
  stop(): void;
  client: FilamentMcpClient;
  identity: ResolvedIdentity;
}

export interface RunConnectOptions {
  mcpUrl: string;
  token: string;
  accountId?: string;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function runConnect(opts: RunConnectOptions): Promise<ConnectHandle> {
  const {
    mcpUrl,
    token,
    accountId = DEFAULT_ACCOUNT_ID,
    log = () => {},
    abortSignal,
    fetchImpl = fetch,
  } = opts;

  const bearer = resolveBearer(token, log);
  if (abortSignal?.aborted) throw new ConnectAbortedError();

  const client = new FilamentMcpClient(mcpUrl, bearer, undefined, fetchImpl);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  await client.initialize({ signal: abortSignal });

  let identity: ResolvedIdentity | null = null;
  for (let attempt = 1; attempt <= GETSELF_MAX_ATTEMPTS; attempt++) {
    if (abortSignal?.aborted) throw new ConnectAbortedError();
    let res: ToolCallResult;
    try {
      res = await client.getSelf({ signal: abortSignal });
    } catch (error) {
      if (abortSignal?.aborted) throw new ConnectAbortedError();
      log(
        `filament-connect: get_self attempt ${attempt}/${GETSELF_MAX_ATTEMPTS} threw: ${String(error)}`,
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
      "agent not finalized within the verification window; will retry on next restart",
    );
  }
  saveIdentity(accountId, { ...identity, onboardedAt: Date.now() });
  log(
    `filament-connect: identity account=${accountId} principal=${identity.principal} ccRoom=${identity.ccRoomId ?? "(none)"}`,
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
