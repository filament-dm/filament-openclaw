/** Per-account settings: config, then env, then production defaults. */
import { asRecord, DEFAULT_ACCOUNT_ID, hasTokenInput } from "./accounts.js";

export const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";

const MCP_PATH = "/mcp/agents";

/** Trailing slashes off; a bare server (`https://host`, no path) gets the agents endpoint's path. */
export function normalizeMcpUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(url) ? `${url}${MCP_PATH}` : url;
}

// The server caps `wait_seconds` at 60, and an intermediary proxy can time out around 60s.
export const MIN_POLL_WAIT_SECONDS = 1;
export const MAX_POLL_WAIT_SECONDS = 60;

export interface McpSettings {
  /** A string, `${ENV}` shorthand, or SecretRef; file/exec refs need the gateway config. */
  tokenInput?: unknown;
  mcpUrl: string;
  pollWaitSeconds?: number;
}

function clampPollWaitSeconds(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MAX_POLL_WAIT_SECONDS, Math.max(MIN_POLL_WAIT_SECONDS, Math.trunc(n)));
}

/** An `accounts.<id>` entry over the top-level fields; `default` is the top level itself. */
export function resolveAccountSettings(
  pluginConfig: unknown,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): McpSettings {
  const cfg = asRecord(pluginConfig);
  const entry = asRecord(asRecord(cfg.accounts)[accountId]);
  if (accountId === DEFAULT_ACCOUNT_ID && !hasTokenInput(entry.connectToken)) {
    return resolveMcpSettings(cfg, env);
  }
  const { accounts: _accounts, connectToken: _legacyToken, ...shared } = cfg;
  // The env token is the default account's; never let it stand in for another.
  return resolveMcpSettings({ ...shared, ...entry }, { ...env, FILAMENT_MCP_TOKEN: "" });
}

export function connectTokenConfigPath(
  pluginId: string,
  accountId: string,
  pluginConfig: unknown,
): string {
  const entry = asRecord(asRecord(asRecord(pluginConfig).accounts)[accountId]);
  return accountId === DEFAULT_ACCOUNT_ID && !hasTokenInput(entry.connectToken)
    ? `plugins.entries.${pluginId}.config.connectToken`
    : `plugins.entries.${pluginId}.config.accounts.${accountId}.connectToken`;
}

/** Config, then env, then production defaults. A present token input is what enables connect. */
export function resolveMcpSettings(
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): McpSettings {
  const cfg = asRecord(pluginConfig);
  const cfgToken = cfg.connectToken;
  const envToken = env.FILAMENT_MCP_TOKEN?.trim();
  const tokenInput = hasTokenInput(cfgToken) ? cfgToken : envToken || undefined;
  const cfgUrl = typeof cfg.mcpUrl === "string" ? cfg.mcpUrl.trim() : "";
  const mcpUrl = normalizeMcpUrl(cfgUrl || env.FILAMENT_MCP_URL?.trim() || DEFAULT_MCP_URL);
  return {
    tokenInput,
    mcpUrl,
    pollWaitSeconds: clampPollWaitSeconds(cfg.pollWaitSeconds),
  };
}
