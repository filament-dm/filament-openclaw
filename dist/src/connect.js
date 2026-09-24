import { asRecord, DEFAULT_ACCOUNT_ID, hasTokenInput } from "./accounts.js";
import { sleepAbortable } from "./util.js";
import { FilamentMcpClient } from "./mcp-client.js";
import { classifyGetSelf } from "./onboarding-core.js";
import { loadBearer, saveBearer, saveIdentity } from "./token-store.js";
const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";
const GETSELF_MAX_ATTEMPTS = 40;
const GETSELF_INTERVAL_MS = 3e3;
const HEARTBEAT_INTERVAL_MS = 2e4;
const CONNECT_TOKEN_PREFIX = "fmcp_";
const EXCHANGE_MAX_ATTEMPTS = 40;
const EXCHANGE_INTERVAL_MS = 3e3;
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const MIN_POLL_WAIT_SECONDS = 1;
const MAX_POLL_WAIT_SECONDS = 60;
function clampPollWaitSeconds(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return void 0;
  return Math.min(MAX_POLL_WAIT_SECONDS, Math.max(MIN_POLL_WAIT_SECONDS, Math.trunc(n)));
}
function resolveAccountSettings(pluginConfig, accountId, env = process.env) {
  const cfg = asRecord(pluginConfig);
  const entry = asRecord(asRecord(cfg.accounts)[accountId]);
  if (accountId === DEFAULT_ACCOUNT_ID && !hasTokenInput(entry.connectToken)) {
    return resolveMcpSettings(cfg, env);
  }
  const { accounts: _accounts, connectToken: _legacyToken, ...shared } = cfg;
  return resolveMcpSettings({ ...shared, ...entry }, { ...env, FILAMENT_MCP_TOKEN: "" });
}
function connectTokenConfigPath(pluginId, accountId, pluginConfig) {
  const entry = asRecord(asRecord(asRecord(pluginConfig).accounts)[accountId]);
  return accountId === DEFAULT_ACCOUNT_ID && !hasTokenInput(entry.connectToken) ? `plugins.entries.${pluginId}.config.connectToken` : `plugins.entries.${pluginId}.config.accounts.${accountId}.connectToken`;
}
function resolveMcpSettings(pluginConfig, env = process.env) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const cfgToken = cfg.connectToken;
  const hasCfgToken = hasTokenInput(cfgToken);
  const envToken = env.FILAMENT_MCP_TOKEN?.trim();
  const tokenInput = hasCfgToken ? cfgToken : envToken || void 0;
  const cfgUrl = typeof cfg.mcpUrl === "string" ? cfg.mcpUrl.trim() : "";
  const mcpUrl = (cfgUrl || env.FILAMENT_MCP_URL?.trim() || DEFAULT_MCP_URL).replace(/\/+$/, "");
  const pollWaitSeconds = clampPollWaitSeconds(cfg.pollWaitSeconds);
  return { tokenInput, mcpUrl, pollWaitSeconds };
}
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
async function resolveBearer(mcpUrl, configuredToken, log, abortSignal, fetchImpl, persistence = defaultBearerPersistence) {
  if (!configuredToken.startsWith(CONNECT_TOKEN_PREFIX)) {
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
async function runConnect(opts) {
  const {
    mcpUrl,
    token,
    accountId = DEFAULT_ACCOUNT_ID,
    log = () => {
    },
    abortSignal,
    fetchImpl = fetch,
    bearerPersistence
  } = opts;
  const bearer = await resolveBearer(
    mcpUrl,
    token,
    log,
    abortSignal,
    fetchImpl,
    bearerPersistence ?? defaultBearerPersistence
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
  MAX_POLL_WAIT_SECONDS,
  MIN_POLL_WAIT_SECONDS,
  connectTokenConfigPath,
  exchangeConnectToken,
  resolveAccountSettings,
  resolveBearer,
  resolveMcpSettings,
  runConnect
};
//# sourceMappingURL=connect.js.map
