import { FilamentMcpClient } from "./mcp-client.js";
import { classifyGetSelf } from "./onboarding-core.js";
import { saveIdentity } from "./token-store.js";
const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";
const DEFAULT_MAX_ATTEMPTS = 40;
const DEFAULT_INTERVAL_MS = 3e3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function resolveMcpSettings(pluginConfig, env = process.env) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const cfgToken = cfg.connectToken;
  const hasCfgToken = typeof cfgToken === "string" && cfgToken.trim().length > 0 || typeof cfgToken === "object" && cfgToken !== null;
  const envToken = env.FILAMENT_MCP_TOKEN?.trim();
  const tokenInput = hasCfgToken ? cfgToken : envToken || void 0;
  const cfgUrl = typeof cfg.mcpUrl === "string" ? cfg.mcpUrl.trim() : "";
  const mcpUrl = (cfgUrl || env.FILAMENT_MCP_URL?.trim() || DEFAULT_MCP_URL).replace(/\/+$/, "");
  return { tokenInput, mcpUrl };
}
async function runOnboarding(opts) {
  const {
    mcpUrl,
    token,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    log = () => {
    }
  } = opts;
  const client = opts.client ?? new FilamentMcpClient(mcpUrl, token);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await client.getSelf();
    } catch (error) {
      log(
        `filament-onboarding: get_self attempt ${attempt}/${maxAttempts} threw: ${String(error)}`
      );
      if (attempt < maxAttempts) await sleep(intervalMs);
      continue;
    }
    const decision = classifyGetSelf(result);
    if (decision.status === "finalized" && decision.identity) {
      const identity = { ...decision.identity, onboardedAt: Date.now() };
      saveIdentity(identity);
      log(
        `filament-onboarding: finalized \u2014 principal=${identity.principal} ccRoom=${identity.ccRoomId ?? "(none)"}`
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
export {
  resolveMcpSettings,
  runOnboarding
};
//# sourceMappingURL=onboarding.js.map
