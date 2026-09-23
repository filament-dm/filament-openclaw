/**
 * Filament connect sequence — the client half of onboarding.
 *
 * PoC scope (RFC-007, "OpenClaw as a `poll_work` channel plugin"):
 *   1. Resolve the configured token. If it's a connect token (`fmcp_…`),
 *      exchange it once for a bearer via the token-exchange grant and persist
 *      the result; if a persisted bearer already exists, reuse it and skip
 *      the exchange entirely. If the configured token is already a bearer,
 *      use it directly.
 *   2. initialize + get_self, purely as a read-only verification step (learns
 *      the agent's identity: principal, backchannel room, mxid).
 *   3. Presence heartbeat loop (independent 20s interval, cancelled on abort).
 *
 * Removed from the old FCM-based sequence: FCM registration, handing Filament
 * a push token, the initial invite/vouch backlog sweep, and the first-contact
 * greeting side effect. The poll loop (src/poll-work.ts) now owns all inbound
 * dispatch; connect.ts only proves the credential works and learns identity.
 */
import { sleepAbortable } from "./util.js";
import { FilamentMcpClient, type ToolCallResult } from "./mcp-client.js";
import { classifyGetSelf, type ResolvedIdentity } from "./onboarding-core.js";
import { loadBearer, saveBearer, saveIdentity } from "./token-store.js";

const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";
const GETSELF_MAX_ATTEMPTS = 40; // ~2 min at the default 3s interval
const GETSELF_INTERVAL_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 20_000; // < 30s presence-decay window

const CONNECT_TOKEN_PREFIX = "fmcp_";
const EXCHANGE_MAX_ATTEMPTS = 40; // mirrors the get_self finalization wait
const EXCHANGE_INTERVAL_MS = 3_000;
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

/** Bounds for the configurable `pollWaitSeconds`: server max is 60, and a
 *  known intermediary (the filament-dev.local nginx dev proxy) times out
 *  around 60s, so nothing above that is usable end to end. */
export const MIN_POLL_WAIT_SECONDS = 1;
export const MAX_POLL_WAIT_SECONDS = 60;

export interface McpSettings {
  /**
   * The raw connect-token input: a string, a `${ENV}` shorthand, or a SecretRef
   * object. Resolved to a concrete token by the caller (which has the gateway
   * config needed to resolve file/exec refs). Undefined = not configured.
   */
  tokenInput?: unknown;
  mcpUrl: string;
  /**
   * The `poll_work` `wait_seconds` to request, already clamped to
   * [MIN_POLL_WAIT_SECONDS, MAX_POLL_WAIT_SECONDS]. Undefined when not
   * configured (or not a finite number) — the caller falls back to
   * poll-work.ts's own default.
   */
  pollWaitSeconds?: number;
}

/** Parse and clamp a configured `pollWaitSeconds` value; undefined if absent/invalid. */
function clampPollWaitSeconds(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MAX_POLL_WAIT_SECONDS, Math.max(MIN_POLL_WAIT_SECONDS, Math.trunc(n)));
}

/**
 * Resolve the MCP endpoint, the connect-token *input*, and the poll wait
 * from plugin config, falling back to env (`FILAMENT_MCP_TOKEN`/
 * `FILAMENT_MCP_URL`) then the prod default. A present token input is the
 * gate that enables connect.
 */
export function resolveMcpSettings(
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): McpSettings {
  const cfg =
    pluginConfig && typeof pluginConfig === "object"
      ? (pluginConfig as Record<string, unknown>)
      : {};
  const cfgToken = cfg.connectToken;
  const hasCfgToken =
    (typeof cfgToken === "string" && cfgToken.trim().length > 0) ||
    (typeof cfgToken === "object" && cfgToken !== null);
  const envToken = env.FILAMENT_MCP_TOKEN?.trim();
  const tokenInput = hasCfgToken ? cfgToken : envToken || undefined;
  const cfgUrl = typeof cfg.mcpUrl === "string" ? cfg.mcpUrl.trim() : "";
  const mcpUrl = (cfgUrl || env.FILAMENT_MCP_URL?.trim() || DEFAULT_MCP_URL).replace(/\/+$/, "");
  const pollWaitSeconds = clampPollWaitSeconds(cfg.pollWaitSeconds);
  return { tokenInput, mcpUrl, pollWaitSeconds };
}

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
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests (defaults to the real token-store). */
  bearerPersistence?: BearerPersistence;
}

/** Thrown when connect cannot proceed (auth rejected, or aborted). */
export class ConnectAbortedError extends Error {
  constructor() {
    super("connect aborted");
    this.name = "ConnectAbortedError";
  }
}

/**
 * Exchange a connect token (`fmcp_…`) for a bearer via RFC 8693 token-exchange
 * (see synapse/synapse/plugins/agents_mcp/oauth_token.py `_exchange_connect_token`,
 * ~L339-414). The subject is single-use: on success the server has already
 * revoked it, so the returned bearer is the only usable credential from here
 * on and MUST be persisted before this function returns.
 *
 * Retries only on "authorization_pending" (the agent isn't finalized in the
 * Filament app yet) and on transient HTTP failures. A rejected/already-used
 * subject token is NOT retried — see the module header on ambiguous rotation.
 */
export async function exchangeConnectToken(
  mcpUrl: string,
  connectToken: string,
  log: (message: string) => void,
  abortSignal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  const tokenUrl = `${mcpUrl}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: connectToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
  }).toString();

  for (let attempt = 1; attempt <= EXCHANGE_MAX_ATTEMPTS; attempt++) {
    if (abortSignal?.aborted) throw new ConnectAbortedError();
    let status: number;
    let json: Record<string, unknown> | null;
    try {
      const response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: abortSignal,
      });
      status = response.status;
      try {
        json = (await response.json()) as Record<string, unknown>;
      } catch {
        json = null;
      }
    } catch (error) {
      if (abortSignal?.aborted) throw new ConnectAbortedError();
      log(`filament-connect: token exchange request failed (attempt ${attempt}): ${String(error)}`);
      await sleepAbortable(EXCHANGE_INTERVAL_MS, abortSignal);
      continue;
    }

    if (status === 200 && json && typeof json.access_token === "string") {
      log("filament-connect: connect token exchanged for a bearer");
      return json.access_token;
    }

    const errorCode = typeof json?.error === "string" ? json.error : undefined;
    if (status === 400 && errorCode === "authorization_pending") {
      log(
        `filament-connect: agent not finalized yet (attempt ${attempt}/${EXCHANGE_MAX_ATTEMPTS}); retrying`,
      );
      await sleepAbortable(EXCHANGE_INTERVAL_MS, abortSignal);
      continue;
    }
    if (status >= 500 || status === 429) {
      log(`filament-connect: token exchange transient failure (HTTP ${status}); retrying`);
      await sleepAbortable(EXCHANGE_INTERVAL_MS, abortSignal);
      continue;
    }

    // 401 invalid_grant (already exchanged/expired), 403, or any other
    // rejection: never blindly retry — the subject may have been consumed by
    // a previous run that crashed before persisting the result (see the
    // plan's "ambiguous rotation" note). Surface it and let the operator act.
    throw new Error(
      `connect token exchange rejected: HTTP ${status} ${errorCode ?? json?.error_description ?? "unknown error"}`,
    );
  }
  throw new Error("connect token exchange did not complete within the retry window");
}

export interface BearerPersistence {
  load: (connectToken: string) => string | undefined;
  save: (connectToken: string, bearer: string) => void;
}

const defaultBearerPersistence: BearerPersistence = { load: loadBearer, save: saveBearer };

/**
 * Resolve the bearer to use for MCP calls, exchanging/persisting as needed.
 *
 * Three cases:
 *   - `configuredToken` isn't a connect token (`fmcp_…`) at all: it's already
 *     a bearer, use it directly.
 *   - it is a connect token AND a bearer is already persisted under THIS
 *     token's own key: reuse it, no exchange.
 *   - otherwise (new/unseen connect token): exchange it and persist the
 *     result under its key, so a later run with the same token skips the
 *     exchange but a *different* token never reuses someone else's bearer.
 */
export async function resolveBearer(
  mcpUrl: string,
  configuredToken: string,
  log: (message: string) => void,
  abortSignal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  persistence: BearerPersistence = defaultBearerPersistence,
): Promise<string> {
  if (!configuredToken.startsWith(CONNECT_TOKEN_PREFIX)) {
    // Already a bearer.
    return configuredToken;
  }
  const persisted = persistence.load(configuredToken);
  if (persisted) {
    log("filament-connect: persisted bearer found for this connect token; skipping exchange");
    return persisted;
  }
  log("filament-connect: new connect token; exchanging");
  const bearer = await exchangeConnectToken(mcpUrl, configuredToken, log, abortSignal, fetchImpl);
  persistence.save(configuredToken, bearer);
  return bearer;
}

/**
 * Run the connect sequence: resolve a bearer, verify it with a read-only
 * get_self, and start the presence heartbeat. Throws (including
 * `ConnectAbortedError`) if the token is rejected or connect is aborted
 * before finishing.
 */
export async function runConnect(opts: RunConnectOptions): Promise<ConnectHandle> {
  const { mcpUrl, token, log = () => {}, abortSignal, fetchImpl = fetch, bearerPersistence } = opts;

  const bearer = await resolveBearer(
    mcpUrl,
    token,
    log,
    abortSignal,
    fetchImpl,
    bearerPersistence ?? defaultBearerPersistence,
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
  saveIdentity({ ...identity, onboardedAt: Date.now() });
  log(
    `filament-connect: identity principal=${identity.principal} ccRoom=${identity.ccRoomId ?? "(none)"}`,
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
