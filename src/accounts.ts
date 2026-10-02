import { createHash } from "node:crypto";

/**
 * Channel accounts: one per Filament agent, since a connect token belongs to exactly one agent.
 * OpenClaw `bindings` route an account to an OpenClaw agent, and a `filament_*` tool call must use
 * the account bound to its own agent, never another's. The top-level `connectToken` is `default`.
 */

export const DEFAULT_ACCOUNT_ID = "default";

export const FILAMENT_CHANNEL_ID = "filament";

export const PLUGIN_ID = "filament-openclaw";

/** install.sh writes this id. */
export const GATEWAY_ACCOUNT_ID = "gateway";

/** A connect token not yet bound to an OpenClaw agent lives under this id; see choose-agent.ts. */
export const PENDING_ACCOUNT_PREFIX = "pending-";

/** The same id install.sh derives, so the two paths never duplicate an account for one token. */
export function pendingAccountId(token: string): string {
  return PENDING_ACCOUNT_PREFIX + createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function hasTokenInput(value: unknown): boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "object" && value !== null)
  );
}

/** With nothing configured, `default` is still listed so the channel shows up (idle) in status. */
export function listConfiguredAccountIds(
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const cfg = asRecord(pluginConfig);
  const ids = Object.entries(asRecord(cfg.accounts))
    .filter(([, entry]) => hasTokenInput(asRecord(entry).connectToken))
    .map(([id]) => id);
  const hasDefault = hasTokenInput(cfg.connectToken) || !!env.FILAMENT_MCP_TOKEN?.trim();
  if ((hasDefault || ids.length === 0) && !ids.includes(DEFAULT_ACCOUNT_ID)) {
    ids.unshift(DEFAULT_ACCOUNT_ID);
  }
  return ids;
}

export function isControlAccount(pluginConfig: unknown, accountId: string): boolean {
  return asRecord(asRecord(asRecord(pluginConfig).accounts)[accountId]).control === true;
}

/** install.sh added it without naming an OpenClaw agent; see choose-agent.ts. */
export function isPendingAccount(pluginConfig: unknown, accountId: string): boolean {
  return asRecord(asRecord(asRecord(pluginConfig).accounts)[accountId]).pending === true;
}

export function pluginConfigFrom(gatewayConfig: unknown): unknown {
  const entry = asRecord(asRecord(asRecord(gatewayConfig).plugins).entries)[PLUGIN_ID];
  return entry === undefined ? undefined : asRecord(entry).config;
}

export interface ToolAccountContext {
  config?: unknown;
  getRuntimeConfig?: () => unknown;
  agentId?: string;
  messageChannel?: string;
  agentAccountId?: string;
}

/**
 * In order: the Filament turn's own account, the account bound to this agent, or the only
 * configured account when nothing is bound (a single-agent install needs no binding).
 */
export function resolveToolAccountId(
  ctx: ToolAccountContext,
  fallbackPluginConfig?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (ctx.messageChannel === FILAMENT_CHANNEL_ID && ctx.agentAccountId) {
    return ctx.agentAccountId;
  }
  const gatewayConfig = ctx.getRuntimeConfig?.() ?? ctx.config;
  const bindings = asRecord(gatewayConfig).bindings;
  const ours = (Array.isArray(bindings) ? bindings : [])
    .map(asRecord)
    .filter((binding) => asRecord(binding.match).channel === FILAMENT_CHANNEL_ID);
  if (ctx.agentId) {
    const bound = ours.find((binding) => binding.agentId === ctx.agentId);
    if (bound) {
      const accountId = asRecord(bound.match).accountId;
      return typeof accountId === "string" && accountId !== "*" ? accountId : DEFAULT_ACCOUNT_ID;
    }
  }
  if (ours.length > 0) return null;
  const pluginConfig = pluginConfigFrom(gatewayConfig) ?? fallbackPluginConfig;
  const configured = listConfiguredAccountIds(pluginConfig, env).filter(
    (id) => !isControlAccount(pluginConfig, id) && !isPendingAccount(pluginConfig, id),
  );
  return configured.length === 1 ? configured[0]! : null;
}
