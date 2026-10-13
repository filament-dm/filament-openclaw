/**
 * This gateway's OpenClaw agents, and the account a Filament agent gets on it: one per OpenClaw
 * agent, account id = agent id, bound to it (`openclaw filament login` and install.sh).
 */
import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  GATEWAY_ACCOUNT_ID,
  PLUGIN_ID,
} from "./accounts.js";

/** OpenClaw's implicit agent when `agents.entries` is empty. */
const IMPLICIT_AGENT_ID = "main";

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RESERVED_ACCOUNT_IDS: ReadonlySet<string> = new Set([
  DEFAULT_ACCOUNT_ID,
  GATEWAY_ACCOUNT_ID,
]);

export interface GatewayAgent {
  id: string;
  name: string;
  emoji?: string;
  boundAccount?: string;
}

export function listGatewayAgents(gatewayConfig: unknown): GatewayAgent[] {
  const cfg = asRecord(gatewayConfig);
  const entries = asRecord(asRecord(cfg.agents).entries);
  const ids = Object.keys(entries);
  const bound = new Map<string, string>();
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
    const name =
      (typeof identity.name === "string" && identity.name.trim()) ||
      (typeof entry.name === "string" && entry.name.trim()) ||
      id;
    const emoji = typeof identity.emoji === "string" && identity.emoji ? identity.emoji : undefined;
    const boundAccount = bound.get(id);
    return {
      id,
      name,
      ...(emoji ? { emoji } : {}),
      ...(boundAccount ? { boundAccount } : {}),
    };
  });
}

/**
 * One Filament account per OpenClaw agent, with account id = agent id. Other bindings of either are
 * removed: an unbound account would land on the system agent.
 */
export function applyAgentConnect(
  draft: Record<string, unknown>,
  agentId: string,
  token: string,
): { displaced: string[] } {
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, PLUGIN_ID);
  const config = ensureRecord(entry, "config");
  const accounts = ensureRecord(config, "accounts");

  const bindings = Array.isArray(draft.bindings) ? (draft.bindings as unknown[]) : [];
  const displaced = new Set<string>();
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

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}
