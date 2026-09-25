/**
 * Which bearer an account's MCP calls carry.
 *
 * Two strategies, one per transport:
 *
 *   - `direct` (fcm): the configured connect token IS the bearer. That is
 *     what production Filament serves: the connect token minted at reserve
 *     time authenticates `/mcp/agents` for as long as the agent exists.
 *   - `exchange` (poll): a connect token (`fmcp_…`) is exchanged once for a
 *     fresh bearer via RFC 8693 token-exchange and persisted (ENG-893). Only a
 *     synapse carrying ENG-893 accepts an `fmcp_` subject — develop reverted
 *     it on 2026-09-18 — which is why the FCM transport never depends on it.
 */
import { loadBearer, saveBearer } from "./token-store.js";
import { sleepAbortable } from "./util.js";

const CONNECT_TOKEN_PREFIX = "fmcp_";
const EXCHANGE_MAX_ATTEMPTS = 40; // mirrors the get_self finalization wait
const EXCHANGE_INTERVAL_MS = 3_000;
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

export type CredentialStrategy = "direct" | "exchange";

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
 * With `strategy: "direct"` the configured token is returned as is. With
 * `"exchange"`, three cases:
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
  strategy: CredentialStrategy = "exchange",
): Promise<string> {
  if (strategy === "direct" || !configuredToken.startsWith(CONNECT_TOKEN_PREFIX)) {
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
