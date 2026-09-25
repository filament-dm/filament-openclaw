import { loadBearer, saveBearer } from "./token-store.js";
import { sleepAbortable } from "./util.js";
const CONNECT_TOKEN_PREFIX = "fmcp_";
const EXCHANGE_MAX_ATTEMPTS = 40;
const EXCHANGE_INTERVAL_MS = 3e3;
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
class ConnectAbortedError extends Error {
  constructor() {
    super("connect aborted");
    this.name = "ConnectAbortedError";
  }
}
async function exchangeConnectToken(mcpUrl, connectToken, log, abortSignal, fetchImpl) {
  const tokenUrl = `${mcpUrl}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: connectToken,
    subject_token_type: ACCESS_TOKEN_TYPE
  }).toString();
  for (let attempt = 1; attempt <= EXCHANGE_MAX_ATTEMPTS; attempt++) {
    if (abortSignal?.aborted) throw new ConnectAbortedError();
    let status;
    let json;
    try {
      const response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: abortSignal
      });
      status = response.status;
      try {
        json = await response.json();
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
    const errorCode = typeof json?.error === "string" ? json.error : void 0;
    if (status === 400 && errorCode === "authorization_pending") {
      log(
        `filament-connect: agent not finalized yet (attempt ${attempt}/${EXCHANGE_MAX_ATTEMPTS}); retrying`
      );
      await sleepAbortable(EXCHANGE_INTERVAL_MS, abortSignal);
      continue;
    }
    if (status >= 500 || status === 429) {
      log(`filament-connect: token exchange transient failure (HTTP ${status}); retrying`);
      await sleepAbortable(EXCHANGE_INTERVAL_MS, abortSignal);
      continue;
    }
    throw new Error(
      `connect token exchange rejected: HTTP ${status} ${errorCode ?? json?.error_description ?? "unknown error"}`
    );
  }
  throw new Error("connect token exchange did not complete within the retry window");
}
const defaultBearerPersistence = { load: loadBearer, save: saveBearer };
async function resolveBearer(mcpUrl, configuredToken, log, abortSignal, fetchImpl, persistence = defaultBearerPersistence, strategy = "exchange") {
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
export {
  ConnectAbortedError,
  exchangeConnectToken,
  resolveBearer
};
//# sourceMappingURL=credentials.js.map
