/**
 * Channel accounts: one per Filament agent on this gateway.
 *
 * A Filament connect token belongs to exactly one Filament agent, so each
 * token is its own OpenClaw channel account
 * (`plugins.entries.filament-fcm.config.accounts.<id>.connectToken`), and
 * OpenClaw's own `bindings` route that account to an OpenClaw agent:
 *
 *   { agentId: "researcher", match: { channel: "filament", accountId: "researcher" } }
 *
 * The pre-multi-account shape — one top-level `connectToken` — is the
 * `default` account, so an existing install keeps working unchanged.
 *
 * The same bindings answer the reverse question for tool calls: a
 * `filament_*` tool runs on behalf of an OpenClaw agent, and must reach
 * Filament with the bearer of the account bound to *that* agent, never
 * another agent's (`resolveToolAccountId`).
 */

export const DEFAULT_ACCOUNT_ID = "default";

export const FILAMENT_CHANNEL_ID = "filament";

export const PLUGIN_ID = "filament-fcm";

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

/**
 * The channel accounts the plugin config declares: every `accounts.<id>`
 * entry with a token, plus `default` when the legacy top-level
 * `connectToken` (or `FILAMENT_MCP_TOKEN`) is set. With nothing configured,
 * `default` alone is listed so the channel still shows up (idle) in
 * `openclaw channels status`.
 */
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

/** This plugin's own config inside the full gateway config, or undefined. */
export function pluginConfigFrom(gatewayConfig: unknown): unknown {
  const entry = asRecord(asRecord(asRecord(gatewayConfig).plugins).entries)[PLUGIN_ID];
  return entry === undefined ? undefined : asRecord(entry).config;
}

/** The subset of OpenClaw's tool-factory context this module reads. */
export interface ToolAccountContext {
  config?: unknown;
  getRuntimeConfig?: () => unknown;
  agentId?: string;
  messageChannel?: string;
  agentAccountId?: string;
}

/**
 * The Filament account a tool call made by this OpenClaw agent belongs to,
 * or null when the agent has none. In order: the account of the Filament
 * turn itself; the account a binding routes to this agent; the only
 * configured account, when there is just one and nothing is bound (the
 * single-agent install, where no binding is needed).
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
  const configured = listConfiguredAccountIds(
    pluginConfigFrom(gatewayConfig) ?? fallbackPluginConfig,
    env,
  );
  return configured.length === 1 ? configured[0]! : null;
}
