import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  GATEWAY_ACCOUNT_ID,
  PLUGIN_ID
} from "./accounts.js";
const IMPLICIT_AGENT_ID = "main";
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_ACCOUNT_IDS = /* @__PURE__ */ new Set([
  DEFAULT_ACCOUNT_ID,
  GATEWAY_ACCOUNT_ID
]);
function listGatewayAgents(gatewayConfig) {
  const cfg = asRecord(gatewayConfig);
  const entries = asRecord(asRecord(cfg.agents).entries);
  const ids = Object.keys(entries);
  const bound = /* @__PURE__ */ new Map();
  const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  for (const raw of bindings) {
    const binding = asRecord(raw);
    const match = asRecord(binding.match);
    if (match.channel !== FILAMENT_CHANNEL_ID || typeof binding.agentId !== "string") continue;
    const accountId = typeof match.accountId === "string" ? match.accountId : DEFAULT_ACCOUNT_ID;
    bound.set(binding.agentId, accountId);
  }
  return (ids.length > 0 ? ids : [IMPLICIT_AGENT_ID]).map((id) => {
    const entry = asRecord(entries[id]);
    const identity = asRecord(entry.identity);
    const name = typeof identity.name === "string" && identity.name.trim() || typeof entry.name === "string" && entry.name.trim() || id;
    const emoji = typeof identity.emoji === "string" && identity.emoji ? identity.emoji : void 0;
    const boundAccount = bound.get(id);
    return {
      id,
      name,
      ...emoji ? { emoji } : {},
      ...boundAccount ? { boundAccount } : {}
    };
  });
}
function applyAgentConnect(draft, agentId, token) {
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, PLUGIN_ID);
  const config = ensureRecord(entry, "config");
  const accounts = ensureRecord(config, "accounts");
  const bindings = Array.isArray(draft.bindings) ? draft.bindings : [];
  const displaced = /* @__PURE__ */ new Set();
  const kept = bindings.filter((raw) => {
    const binding = asRecord(raw);
    const match = asRecord(binding.match);
    if (match.channel !== FILAMENT_CHANNEL_ID) return true;
    const accountId = typeof match.accountId === "string" ? match.accountId : DEFAULT_ACCOUNT_ID;
    if (binding.agentId === agentId) {
      if (accountId !== agentId) displaced.add(accountId);
      return false;
    }
    return accountId !== agentId;
  });
  kept.push({ agentId, match: { channel: FILAMENT_CHANNEL_ID, accountId: agentId } });
  draft.bindings = kept;
  for (const accountId of displaced) {
    if (accountId === DEFAULT_ACCOUNT_ID) delete config.connectToken;
    else delete accounts[accountId];
  }
  accounts[agentId] = { ...asRecord(accounts[agentId]), connectToken: token };
  return { displaced: [...displaced] };
}
function ensureRecord(parent, key) {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing;
  }
  const created = {};
  parent[key] = created;
  return created;
}
export {
  AGENT_ID_PATTERN,
  RESERVED_ACCOUNT_IDS,
  applyAgentConnect,
  listGatewayAgents
};
