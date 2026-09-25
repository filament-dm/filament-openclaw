/**
 * Filament connect sequence — the client half of onboarding, shared by both
 * transports:
 *
 *   1. Resolve the bearer (src/credentials.ts): the connect token itself for
 *      `fcm`, a one-time exchange for `poll`.
 *   2. initialize + get_self until the agent is finalized; learn its identity
 *      (principal, backchannel room, mxid) and persist it per account.
 *   3. Presence heartbeat loop (independent 20s interval, cancelled on abort).
 *
 * Everything transport-specific — registering a push token, the poll loop,
 * the invite sweep, the first-contact greeting — lives in src/transports/.
 */
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import {
  type BearerPersistence,
  ConnectAbortedError,
  type CredentialStrategy,
  resolveBearer,
} from "./credentials.js";
import { sleepAbortable } from "./util.js";
import { FilamentMcpClient, type ToolCallResult } from "./mcp-client.js";
import { classifyGetSelf, type ResolvedIdentity } from "./onboarding-core.js";
import { saveIdentity } from "./token-store.js";

export { ConnectAbortedError };

const GETSELF_MAX_ATTEMPTS = 40; // ~2 min at the default 3s interval
const GETSELF_INTERVAL_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 20_000; // < 30s presence-decay window

/** A running connection: stop the heartbeat, or use the MCP client for outbound calls. */
export interface ConnectHandle {
  stop(): void;
  client: FilamentMcpClient;
  identity: ResolvedIdentity;
}

export interface RunConnectOptions {
  mcpUrl: string;
  /** The configured token: a connect token (`fmcp_…`) or an already-issued bearer. */
  token: string;
  /** The channel account this connection belongs to; keys its stored identity. */
  accountId?: string;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests (defaults to the real token-store). */
  bearerPersistence?: BearerPersistence;
  /** How the configured token becomes a bearer; see src/credentials.ts. */
  credential?: CredentialStrategy;
}

/**
 * Run the connect sequence: resolve a bearer, verify it with a read-only
 * get_self, and start the presence heartbeat. Throws (including
 * `ConnectAbortedError`) if the token is rejected or connect is aborted
 * before finishing.
 */
export async function runConnect(opts: RunConnectOptions): Promise<ConnectHandle> {
  const {
    mcpUrl,
    token,
    accountId = DEFAULT_ACCOUNT_ID,
    log = () => {},
    abortSignal,
    fetchImpl = fetch,
    bearerPersistence,
    credential = "exchange",
  } = opts;

  const bearer = await resolveBearer(
    mcpUrl,
    token,
    log,
    abortSignal,
    fetchImpl,
    bearerPersistence,
    credential,
  );
  if (abortSignal?.aborted) throw new ConnectAbortedError();

  const client = new FilamentMcpClient(mcpUrl, bearer, undefined, fetchImpl);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  // initialize + get_self: read-only verification step. Learns identity;
  // never mutates anything.
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
      throw new Error("bearer rejected");
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

  // Presence heartbeat loop — independent of the poll loop, cancelled on abort.
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
