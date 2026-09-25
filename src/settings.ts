/**
 * Per-account settings: where Filament is, which token to use, and how work
 * reaches this account.
 *
 * Transport: `fcm` (the default — what production Filament speaks) or `poll`
 * (the `poll_work` long-poll, which only a synapse carrying ENG-1392 serves).
 * Set once for every account at the top of the plugin config, or per account;
 * install.sh writes the top-level value from `FILAMENT_TRANSPORT`.
 *
 * Firebase: the project an `fcm` account registers with. It must be the
 * project the homeserver sends through, or the token registers fine and is
 * never delivered to; defaults to production.
 */
import { asRecord, DEFAULT_ACCOUNT_ID, hasTokenInput } from "./accounts.js";

const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";

/** Bounds for the configurable `pollWaitSeconds`: server max is 60, and a
 *  known intermediary (the filament-dev.local nginx dev proxy) times out
 *  around 60s, so nothing above that is usable end to end. */
export const MIN_POLL_WAIT_SECONDS = 1;
export const MAX_POLL_WAIT_SECONDS = 60;

export type Transport = "fcm" | "poll";

export const DEFAULT_TRANSPORT: Transport = "fcm";

/** The Firebase project an `fcm` account registers with (public identifiers, not secrets). */
export interface FirebaseSettings {
  projectId: string;
  apiKey: string;
  appId: string;
  messagingSenderId: string;
}

// Filament's production Firebase project — the same values the Electron
// desktop client ships (apps/electron/src/fcm-push-receiver.ts) and the
// filament-hermes plugin defaults to.
const PRODUCTION_FIREBASE: FirebaseSettings = {
  projectId: "filament-8ce44",
  apiKey: "AIzaSyBtYzzP3IRpmIZ57dp1PMS4Y8RPjTB0snk",
  appId: "1:143821144946:web:90e517a7f36aa42a6093eb",
  messagingSenderId: "143821144946",
};

export interface McpSettings {
  /**
   * The raw connect-token input: a string, a `${ENV}` shorthand, or a SecretRef
   * object. Resolved to a concrete token by the caller (which has the gateway
   * config needed to resolve file/exec refs). Undefined = not configured.
   */
  tokenInput?: unknown;
  mcpUrl: string;
  transport: Transport;
  firebase: FirebaseSettings;
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

/** `poll` only when asked for by name; anything else is the default. */
export function parseTransport(raw: unknown): Transport | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return value === "poll" || value === "fcm" ? value : undefined;
}

/**
 * The Firebase project: config fields win, then `FILAMENT_FIREBASE_*` (the
 * names filament-hermes reads), then production — field by field.
 */
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

/**
 * Settings for one channel account: its own `accounts.<id>` entry layered
 * over the top-level fields (so `mcpUrl`/`transport`/`firebase`/
 * `pollWaitSeconds` can be set once for every account). The `default`
 * account is the top-level shape itself.
 */
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

/** The config path a secret-input resolver reports for an account's token. */
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

/**
 * Resolve the MCP endpoint, the connect-token *input*, the transport and its
 * knobs from plugin config, falling back to env (`FILAMENT_MCP_TOKEN`/
 * `FILAMENT_MCP_URL`/`FILAMENT_TRANSPORT`/`FILAMENT_FIREBASE_*`) then the
 * production defaults. A present token input is the gate that enables connect.
 */
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
