/**
 * Per-account settings. An `fcm` account must register with the Firebase project the server sends
 * through: a token from another project registers fine and is never delivered to.
 */
import { asRecord, DEFAULT_ACCOUNT_ID, hasTokenInput } from "./accounts.js";

const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";

// The server caps `wait_seconds` at 60, and an intermediary proxy can time out around 60s.
export const MIN_POLL_WAIT_SECONDS = 1;
export const MAX_POLL_WAIT_SECONDS = 60;

export type Transport = "fcm" | "poll";

// `poll` is served by production Filament; `fcm` stays available by name for a
// gateway that wants pushes and a matching Firebase project.
export const DEFAULT_TRANSPORT: Transport = "poll";

/** Public client identifiers, not secrets. */
export interface FirebaseSettings {
  projectId: string;
  apiKey: string;
  appId: string;
  messagingSenderId: string;
}

// Filament's production Firebase project (public client config).
const PRODUCTION_FIREBASE: FirebaseSettings = {
  projectId: "filament-8ce44",
  apiKey: "AIzaSyBtYzzP3IRpmIZ57dp1PMS4Y8RPjTB0snk",
  appId: "1:143821144946:web:90e517a7f36aa42a6093eb",
  messagingSenderId: "143821144946",
};

export interface McpSettings {
  /** A string, `${ENV}` shorthand, or SecretRef; file/exec refs need the gateway config. */
  tokenInput?: unknown;
  mcpUrl: string;
  transport: Transport;
  firebase: FirebaseSettings;
  pollWaitSeconds?: number;
}

function clampPollWaitSeconds(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MAX_POLL_WAIT_SECONDS, Math.max(MIN_POLL_WAIT_SECONDS, Math.trunc(n)));
}

export function parseTransport(raw: unknown): Transport | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return value === "poll" || value === "fcm" ? value : undefined;
}

/** Field by field: config, then `FILAMENT_FIREBASE_*`, then production. */
function resolveFirebase(raw: unknown, env: NodeJS.ProcessEnv): FirebaseSettings {
  const cfg = asRecord(raw);
  const pick = (key: keyof FirebaseSettings, envName: string): string => {
    const value = cfg[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    return env[envName]?.trim() || PRODUCTION_FIREBASE[key];
  };
  return {
    projectId: pick("projectId", "FILAMENT_FIREBASE_PROJECT_ID"),
    apiKey: pick("apiKey", "FILAMENT_FIREBASE_API_KEY"),
    appId: pick("appId", "FILAMENT_FIREBASE_APP_ID"),
    messagingSenderId: pick("messagingSenderId", "FILAMENT_FIREBASE_SENDER_ID"),
  };
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
  const mcpUrl = (cfgUrl || env.FILAMENT_MCP_URL?.trim() || DEFAULT_MCP_URL).replace(/\/+$/, "");
  const transport =
    parseTransport(cfg.transport) ?? parseTransport(env.FILAMENT_TRANSPORT) ?? DEFAULT_TRANSPORT;
  return {
    tokenInput,
    mcpUrl,
    transport,
    firebase: resolveFirebase(cfg.firebase, env),
    pollWaitSeconds: clampPollWaitSeconds(cfg.pollWaitSeconds),
  };
}
