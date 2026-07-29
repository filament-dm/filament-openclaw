/**
 * Filament agent onboarding: the client half of the connect flow, ported from
 * the Python Hermes plugin's `setup_cli` finalization poll.
 *
 * The Filament app mints an `fmcp_…` connect token (via reserve) and, separately,
 * finalizes the agent (creating its account + backchannel). This plugin, given
 * the connect token, speaks MCP-over-HTTP and polls `get_self` until the agent
 * is finalized, then persists the learned identity (principal + backchannel).
 */
import { FilamentMcpClient, type ToolCallResult } from "./mcp-client.js";
import { classifyGetSelf, type OnboardingDecision } from "./onboarding-core.js";
import { type AgentIdentity, saveIdentity } from "./token-store.js";

const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";
const DEFAULT_MAX_ATTEMPTS = 40; // ~2 min at the default 3s interval
const DEFAULT_INTERVAL_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface McpSettings {
  /**
   * The raw connect-token input: a string, a `${ENV}` shorthand, or a SecretRef
   * object. It is resolved to a concrete token by the caller (which has the
   * gateway config needed to resolve file/exec refs). Undefined = not configured.
   */
  tokenInput?: unknown;
  mcpUrl: string;
}

/**
 * Resolve the MCP endpoint and the connect-token *input* from plugin config,
 * falling back to env (mirroring Hermes' `FILAMENT_MCP_TOKEN`/`FILAMENT_MCP_URL`)
 * then the prod default. The token input is left unresolved here — it may be a
 * SecretRef — and is resolved via the plugin SDK where `api.config` is available.
 * A present token input is the gate that enables onboarding.
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
  return { tokenInput, mcpUrl };
}

export interface RunOnboardingOptions {
  mcpUrl: string;
  token: string;
  maxAttempts?: number;
  intervalMs?: number;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to a real client. */
  client?: Pick<FilamentMcpClient, "getSelf">;
}

/**
 * Poll `get_self` until the agent is finalized (or the token is rejected, or we
 * exhaust the bounded window), persisting the identity on success. Returns the
 * terminal decision.
 */
export async function runOnboarding(opts: RunOnboardingOptions): Promise<OnboardingDecision> {
  const {
    mcpUrl,
    token,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    log = () => {},
  } = opts;
  const client = opts.client ?? new FilamentMcpClient(mcpUrl, token);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: ToolCallResult;
    try {
      result = await client.getSelf();
    } catch (error) {
      log(
        `filament-onboarding: get_self attempt ${attempt}/${maxAttempts} threw: ${String(error)}`,
      );
      if (attempt < maxAttempts) await sleep(intervalMs);
      continue;
    }

    const decision = classifyGetSelf(result);
    if (decision.status === "finalized" && decision.identity) {
      const identity: AgentIdentity = { ...decision.identity, onboardedAt: Date.now() };
      saveIdentity(identity);
      log(
        `filament-onboarding: finalized — principal=${identity.principal} ccRoom=${identity.ccRoomId ?? "(none)"}`,
      );
      return { status: "finalized", identity: decision.identity };
    }
    if (decision.status === "auth_failed") {
      log("filament-onboarding: connect token rejected (auth failed); not retrying");
      return decision;
    }
    log(`filament-onboarding: not finalized yet (attempt ${attempt}/${maxAttempts})`);
    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  log(`filament-onboarding: gave up after ${maxAttempts} attempts (agent not finalized)`);
  return { status: "not_finalized" };
}
