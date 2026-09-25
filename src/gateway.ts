/**
 * The gateway control account: Filament drives this OpenClaw gateway through
 * one Filament agent's backchannel, with no terminal after pairing.
 *
 * Pairing is an ordinary connect (install.sh with OPENCLAW_GATEWAY=1): a
 * Filament agent whose account is marked `control: true`. That account never
 * runs an agent turn. Instead it
 *
 *   - reports this gateway's OpenClaw agents to Filament, over the existing
 *     tool-inventory side channel (POST /mcp/agents/tools), one entry per
 *     agent with origin "openclaw-agent" — the Filament app reads it back with
 *     GET /_filament/agents/{id}/tools and shows it as a picker;
 *   - obeys `/filament connect <agent-id> <fmcp_token>` from its principal in
 *     its own backchannel: it writes the channel account + binding for that
 *     agent with `api.runtime.config.mutateConfigFile`, and the gateway's
 *     reload starts the new account.
 *
 * Authority is the backchannel's: a command counts only when the item is the
 * backchannel of this account, every message in it is from the principal
 * `get_self` returned, and the room is that principal's `ccRoomId`.
 *
 * Trade-off, accepted for the PoC: the connect token travels as a message
 * body, so it stays in the room's history. It is single-use and the new
 * account exchanges it within seconds, after which the server has revoked it.
 * See plans/openclaw/rfc-009-gateway-agent-inventory-and-picker.md, option C.
 */
import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  GATEWAY_ACCOUNT_ID,
  PLUGIN_ID,
} from "./accounts.js";
import type { DispatchOutcome, PollWorkItem } from "./poll-work.js";

/** Tool-inventory `origin` for one OpenClaw agent entry. The app filters on it. */
export const AGENT_INVENTORY_ORIGIN = "openclaw-agent";

/** OpenClaw's implicit agent when `agents.entries` is empty (`BOOTSTRAP_AGENT_ID`). */
const IMPLICIT_AGENT_ID = "main";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_ACCOUNT_IDS: ReadonlySet<string> = new Set([DEFAULT_ACCOUNT_ID, GATEWAY_ACCOUNT_ID]);

/** One OpenClaw agent, as the picker shows it. */
export interface GatewayAgent {
  id: string;
  name: string;
  emoji?: string;
  /** The Filament channel account bound to this agent, if any. */
  boundAccount?: string;
}

/** The gateway's OpenClaw agents, read from the live gateway config. */
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

/** One tool-inventory entry: the server allows only these four string keys. */
export interface InventoryEntry {
  name: string;
  description: string;
  origin: string;
  health: "ok";
}

/**
 * The agents as tool-inventory entries. `name` is the agent id; the picker's
 * fields ride in `description` as JSON, the one free-text key the inventory
 * accepts. A borrowed shape, flagged: fine for the PoC, a real endpoint later.
 */
export function inventoryEntries(agents: GatewayAgent[]): InventoryEntry[] {
  return agents.map((agent) => ({
    name: agent.id,
    description: JSON.stringify(agent),
    origin: AGENT_INVENTORY_ORIGIN,
    health: "ok",
  }));
}

export type GatewayCommand =
  | { kind: "connect"; agentId: string; token: string }
  | { kind: "agents" }
  | { kind: "invalid"; reason: string };

/** Parse one message body; null when it isn't a `/filament` command at all. */
export function parseGatewayCommand(body: string): GatewayCommand | null {
  const words = body.trim().split(/\s+/);
  if (words[0] !== "/filament") return null;
  if (words[1] === "agents" && words.length === 2) return { kind: "agents" };
  if (words[1] === "connect") {
    const [, , agentId, token, ...rest] = words;
    if (!agentId || !token || rest.length > 0) {
      return { kind: "invalid", reason: "usage: /filament connect <agent-id> <connect-token>" };
    }
    if (!AGENT_ID_PATTERN.test(agentId) || RESERVED_ACCOUNT_IDS.has(agentId)) {
      return { kind: "invalid", reason: `"${agentId}" is not a usable agent id` };
    }
    if (!token.startsWith("fmcp_")) {
      return { kind: "invalid", reason: "the connect token must start with fmcp_" };
    }
    return { kind: "connect", agentId, token };
  }
  return {
    kind: "invalid",
    reason: "commands: /filament agents, /filament connect <agent-id> <token>",
  };
}

/**
 * Point `agentId` at a new Filament account holding `token`, in place on a
 * mutable config draft. Account id = agent id. One Filament account per
 * OpenClaw agent: any other account bound to this agent is removed, as is
 * any binding of this account to another agent — an unbound account would
 * land on the system agent (install.sh enforces the same invariant).
 * Returns what it displaced, for the reply.
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
    if (accountId === GATEWAY_ACCOUNT_ID) continue;
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

/** What the control handler needs from its surroundings; all injectable for tests. */
export interface GatewayItemContext {
  item: PollWorkItem;
  principal: string | undefined;
  ccRoomId: string | undefined;
  /** The live gateway config, to check the agent exists. */
  gatewayConfig: unknown;
  /** Publish via the item's reply_with (consumes it). */
  reply: (markdown: string) => Promise<boolean>;
  /** Post a follow-up to the backchannel after the item is consumed. */
  followUp: (markdown: string) => Promise<void>;
  /** Persist a config mutation through the gateway (mutateConfigFile). */
  mutateConfig: (mutate: (draft: Record<string, unknown>) => void) => Promise<void>;
  /** Re-send the agent inventory. */
  reportInventory: () => Promise<void>;
  log: (message: string) => void;
}

/**
 * Handle one work item on the control account. Never runs an agent turn and
 * never returns "error" — that would pause the account, and the gateway
 * account must stay up to take the next command.
 */
export async function handleGatewayItem(ctx: GatewayItemContext): Promise<DispatchOutcome> {
  const { item, log } = ctx;
  // A reply that didn't publish leaves the item unconsumed; "silent" acks it
  // on the next poll so a command is never replayed forever.
  const answered = (ok: boolean): DispatchOutcome =>
    ok ? { kind: "published" } : { kind: "silent" };
  const fromPrincipal =
    ctx.principal !== undefined && item.messages.every((m) => m.sender === ctx.principal);
  if (!item.is_backchannel || item.channel_id !== ctx.ccRoomId || !fromPrincipal) {
    log("filament-gateway: ignoring work outside the principal's backchannel");
    return { kind: "silent" };
  }

  // The newest command wins; plain chatter gets a pointer, not a turn.
  const command = [...item.messages]
    .reverse()
    .map((m) => parseGatewayCommand(m.body))
    .find((parsed) => parsed !== null);

  if (!command) {
    return answered(
      await ctx.reply(
        "I'm this OpenClaw gateway's link to Filament, not an agent. Connect its agents from the OpenClaw card in Filament.",
      ),
    );
  }
  if (command.kind === "invalid") {
    return answered(await ctx.reply(`⚠️ ${command.reason}`));
  }
  if (command.kind === "agents") {
    await ctx.reportInventory().catch((error) => {
      log(`filament-gateway: inventory report failed: ${String(error)}`);
    });
    return answered(await ctx.reply("Agent list refreshed."));
  }

  const agent = listGatewayAgents(ctx.gatewayConfig).find((a) => a.id === command.agentId);
  if (!agent) {
    return answered(await ctx.reply(`⚠️ This gateway has no OpenClaw agent "${command.agentId}".`));
  }

  // Reply first: the config write reloads the plugin, this account included,
  // so anything after it may never run. Never log the command: it holds a token.
  const replied = await ctx.reply(
    `Connecting ${agent.emoji ? `${agent.emoji} ` : ""}**${agent.name}** (\`${agent.id}\`)…`,
  );
  try {
    let displaced: string[] = [];
    await ctx.mutateConfig((draft) => {
      displaced = applyAgentConnect(draft, command.agentId, command.token).displaced;
    });
    log(`filament-gateway: wrote account + binding for agent ${command.agentId}`);
    if (displaced.length > 0) {
      await ctx
        .followUp(`Replaced the Filament account this agent had (${displaced.join(", ")}).`)
        .catch(() => {});
    }
  } catch (error) {
    log(`filament-gateway: config write failed for agent ${command.agentId}: ${String(error)}`);
    await ctx
      .followUp(`⚠️ Couldn't save the connection on the gateway: ${String(error)}`)
      .catch(() => {});
  }
  return answered(replied);
}
