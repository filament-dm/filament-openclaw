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
 *   - obeys commands from its principal in its own backchannel —
 *     `/filament connect <agent-id> <fmcp_token> [<request-id>]`,
 *     `/filament disconnect <agent-id> [<request-id>]`,
 *     `/filament unpair [<request-id>]`, `/filament agents` — by writing the
 *     gateway config with `api.runtime.config.mutateConfigFile`; the
 *     gateway's reload then starts or stops the affected account.
 *
 * It never writes into the chat: the Filament app hides this agent and its
 * backchannel. A command is consumed with a read receipt, and its outcome is
 * published as a status entry in the same inventory (origin
 * "openclaw-gateway-status", keyed by the request id), which the app's
 * connect popup reads.
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
  /** That account's Filament agent (its mxid), once it has connected. */
  filamentUserId?: string;
}

/**
 * The gateway's OpenClaw agents, read from the live gateway config.
 * `filamentUserOf` maps a bound account to the Filament agent it connected
 * as, so the app can tell which OpenClaw agent a Filament agent is.
 */
export function listGatewayAgents(
  gatewayConfig: unknown,
  filamentUserOf: (accountId: string) => string | undefined = () => undefined,
): GatewayAgent[] {
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
    const filamentUserId = boundAccount ? filamentUserOf(boundAccount) : undefined;
    return {
      id,
      name,
      ...(emoji ? { emoji } : {}),
      ...(boundAccount ? { boundAccount } : {}),
      ...(filamentUserId ? { filamentUserId } : {}),
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
export function inventoryEntries(
  agents: GatewayAgent[],
  statuses: readonly GatewayStatus[] = [],
): InventoryEntry[] {
  return [
    ...agents.map((agent) => ({
      name: agent.id,
      description: JSON.stringify(agent),
      origin: AGENT_INVENTORY_ORIGIN,
      health: "ok" as const,
    })),
    ...statuses.map((status) => ({
      name: `status:${status.requestId}`,
      description: JSON.stringify(status),
      origin: STATUS_INVENTORY_ORIGIN,
      health: "ok" as const,
    })),
  ];
}

/** Tool-inventory `origin` for a command's outcome. The connect popup reads it. */
export const STATUS_INVENTORY_ORIGIN = "openclaw-gateway-status";

/** How many recent outcomes ride along in each inventory report. */
export const MAX_REPORTED_STATUSES = 10;

/**
 * The outcome of one command, as the app sees it. "applied" is reported
 * before the config write (which reloads the plugin and clears this list);
 * the app confirms a connect by the new agent coming online.
 */
export interface GatewayStatus {
  requestId: string;
  command: "connect" | "disconnect" | "unpair" | "agents" | "invalid";
  agentId?: string;
  state: "applied" | "rejected" | "failed";
  message?: string;
}

export type GatewayCommand = { requestId: string } & (
  | { kind: "connect"; agentId: string; token: string }
  | { kind: "disconnect"; agentId: string }
  | { kind: "unpair" }
  | { kind: "agents" }
  | { kind: "invalid"; reason: string }
);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parse one message body; null when it isn't a `/filament` command at all.
 * A trailing request id (from the app) keys the command's reported outcome;
 * a hand-typed command without one gets the event id.
 */
export function parseGatewayCommand(
  body: string,
  fallbackRequestId: string,
): GatewayCommand | null {
  const words = body.trim().split(/\s+/);
  if (words[0] !== "/filament") return null;
  const verb = words[1];
  const arity = verb === "connect" ? 2 : verb === "disconnect" ? 1 : 0;
  const args = words.slice(2);
  const extra = args.slice(arity);
  const requestId =
    extra.length === 1 && REQUEST_ID_PATTERN.test(extra[0]!) ? extra[0]! : fallbackRequestId;
  const invalid = (reason: string): GatewayCommand => ({ kind: "invalid", reason, requestId });
  if (!["connect", "disconnect", "unpair", "agents"].includes(verb ?? "")) {
    return invalid("commands: agents, connect <agent-id> <token>, disconnect <agent-id>, unpair");
  }
  if (args.length < arity || extra.length > 1 || (extra.length === 1 && requestId !== extra[0])) {
    return invalid(
      `usage: /filament ${verb}${arity >= 1 ? " <agent-id>" : ""}${arity === 2 ? " <connect-token>" : ""} [<request-id>]`,
    );
  }
  if (verb === "agents") return { kind: "agents", requestId };
  if (verb === "unpair") return { kind: "unpair", requestId };
  const agentId = args[0]!;
  if (!AGENT_ID_PATTERN.test(agentId) || RESERVED_ACCOUNT_IDS.has(agentId)) {
    return invalid(`"${agentId}" is not a usable agent id`);
  }
  if (verb === "disconnect") return { kind: "disconnect", agentId, requestId };
  const token = args[1]!;
  if (!token.startsWith("fmcp_")) {
    return invalid("the connect token must start with fmcp_");
  }
  return { kind: "connect", agentId, token, requestId };
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

/** Remove `agentId`'s Filament account and its binding. Idempotent. */
export function applyAgentDisconnect(draft: Record<string, unknown>, agentId: string): void {
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  const accounts = asRecord(config.accounts);
  delete accounts[agentId];
  if (Array.isArray(draft.bindings)) {
    draft.bindings = (draft.bindings as unknown[]).filter((raw) => {
      const match = asRecord(asRecord(raw).match);
      return !(match.channel === FILAMENT_CHANNEL_ID && match.accountId === agentId);
    });
  }
}

/** Remove the gateway control account itself: the gateway stops taking commands. */
export function applyUnpair(draft: Record<string, unknown>): void {
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  delete asRecord(config.accounts)[GATEWAY_ACCOUNT_ID];
}

/** Whether `mutate` would change the plugin config or bindings of `gatewayConfig`. */
export function wouldChange(
  gatewayConfig: unknown,
  mutate: (draft: Record<string, unknown>) => void,
): boolean {
  const cfg = asRecord(gatewayConfig);
  const slice = (c: Record<string, unknown>) =>
    JSON.stringify({
      config: asRecord(asRecord(asRecord(c.plugins).entries)[PLUGIN_ID]).config ?? null,
      bindings: c.bindings ?? null,
    });
  const draft = structuredClone({ plugins: cfg.plugins, bindings: cfg.bindings }) as Record<
    string,
    unknown
  >;
  const before = slice(draft);
  mutate(draft);
  return slice(draft) !== before;
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
  /** Consume the item's messages with a read receipt, before any config write. */
  consume: (upToEventId: string) => Promise<void>;
  /** Persist a config mutation through the gateway (mutateConfigFile). */
  mutateConfig: (mutate: (draft: Record<string, unknown>) => void) => Promise<void>;
  /** Record outcomes and re-send the inventory carrying them. */
  report: (statuses: GatewayStatus[]) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Handle one work item on the control account. Never runs an agent turn,
 * never writes into the chat, and never returns "error" — that would pause
 * the account, and the gateway account must stay up to take the next
 * command. Every path acks the item ("silent").
 *
 * An item can carry several commands (the app sends a disconnect and an
 * unpair back to back): they are applied in order and written as ONE config
 * mutation, because the first write reloads the plugin and would cut the
 * rest off.
 */
export async function handleGatewayItem(ctx: GatewayItemContext): Promise<DispatchOutcome> {
  const { item, log } = ctx;
  const done: DispatchOutcome = { kind: "silent" };
  const fromPrincipal =
    ctx.principal !== undefined && item.messages.every((m) => m.sender === ctx.principal);
  if (!item.is_backchannel || item.channel_id !== ctx.ccRoomId || !fromPrincipal) {
    log("filament-gateway: ignoring work outside the principal's backchannel");
    return done;
  }

  const commands = item.messages
    .map((m) => parseGatewayCommand(m.body, m.event_id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)))
    .filter((parsed): parsed is GatewayCommand => parsed !== null);
  // Consume first: a config write reloads the plugin, this account included,
  // and a command left unread would be redelivered after the restart.
  const last = item.messages[item.messages.length - 1]!;
  await ctx.consume(last.event_id).catch((error) => {
    log(`filament-gateway: could not mark the commands read: ${String(error)}`);
  });
  if (commands.length === 0) return done;

  const knownAgents = new Set(listGatewayAgents(ctx.gatewayConfig).map((a) => a.id));
  const statuses: GatewayStatus[] = [];
  const mutations: Array<(draft: Record<string, unknown>) => void> = [];
  for (const command of commands) {
    const base = { requestId: command.requestId };
    if (command.kind === "invalid") {
      statuses.push({ ...base, command: "invalid", state: "rejected", message: command.reason });
    } else if (command.kind === "agents") {
      statuses.push({ ...base, command: "agents", state: "applied" });
    } else if (command.kind === "connect" && !knownAgents.has(command.agentId)) {
      statuses.push({
        ...base,
        command: "connect",
        agentId: command.agentId,
        state: "rejected",
        message: `This gateway has no OpenClaw agent "${command.agentId}".`,
      });
    } else if (command.kind === "connect") {
      mutations.push((draft) => {
        applyAgentConnect(draft, command.agentId, command.token);
      });
      statuses.push({ ...base, command: "connect", agentId: command.agentId, state: "applied" });
    } else if (command.kind === "disconnect") {
      mutations.push((draft) => applyAgentDisconnect(draft, command.agentId));
      statuses.push({ ...base, command: "disconnect", agentId: command.agentId, state: "applied" });
    } else {
      mutations.push(applyUnpair);
      statuses.push({ ...base, command: "unpair", state: "applied" });
    }
  }

  // Report before writing: the write reloads the plugin and drops the list.
  // Never log a command itself: a connect carries a token.
  const report = (entries: GatewayStatus[]) =>
    ctx.report(entries).catch((error) => {
      log(`filament-gateway: status report failed: ${String(error)}`);
    });
  await report(statuses);
  const mutate = (draft: Record<string, unknown>) => {
    for (const apply of mutations) apply(draft);
  };
  if (mutations.length === 0 || !wouldChange(ctx.gatewayConfig, mutate)) {
    if (mutations.length > 0) log("filament-gateway: commands change nothing; skipping the write");
    return done;
  }
  try {
    await ctx.mutateConfig(mutate);
    log(`filament-gateway: wrote ${commands.map((c) => c.kind).join(", ")}`);
  } catch (error) {
    log(`filament-gateway: config write failed: ${String(error)}`);
    await report(
      statuses
        .filter((status) => status.state === "applied" && status.command !== "agents")
        .map((status) => ({
          ...status,
          state: "failed" as const,
          message: `Couldn't save the change on the gateway: ${String(error)}`,
        })),
    );
  }
  return done;
}
