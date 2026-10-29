import { asRecord, DEFAULT_ACCOUNT_ID, hasTokenInput } from "./accounts.js";
const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";
const MCP_PATH = "/mcp/agents";
function normalizeMcpUrl(raw) {
  const url = raw.trim().replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(url) ? `${url}${MCP_PATH}` : url;
}
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
  const cfg = asRecord(pluginConfig);
  const cfgToken = cfg.connectToken;
  const envToken = env.FILAMENT_MCP_TOKEN?.trim();
  const tokenInput = hasTokenInput(cfgToken) ? cfgToken : envToken || void 0;
  const cfgUrl = typeof cfg.mcpUrl === "string" ? cfg.mcpUrl.trim() : "";
  const mcpUrl = normalizeMcpUrl(cfgUrl || env.FILAMENT_MCP_URL?.trim() || DEFAULT_MCP_URL);
  return {
    tokenInput,
    mcpUrl,
    pollWaitSeconds: clampPollWaitSeconds(cfg.pollWaitSeconds)
  };
}
export {
  DEFAULT_MCP_URL,
  MAX_POLL_WAIT_SECONDS,
  MIN_POLL_WAIT_SECONDS,
  connectTokenConfigPath,
  normalizeMcpUrl,
  resolveAccountSettings,
  resolveMcpSettings
};
