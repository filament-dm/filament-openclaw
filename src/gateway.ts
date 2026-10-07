/**
 * The gateway control account: a Filament agent (`control: true`) that never runs an agent turn.
 * It publishes this gateway's OpenClaw agents in its tool inventory and obeys `/filament` commands
 * from its principal by editing the gateway config, whose reload starts or stops the affected
 * account. Outcomes go to the inventory as status entries, never into the chat.
 *
 * A command counts only in this account's backchannel, with every message from the `get_self`
 * principal, in that principal's `ccRoomId`.
 *
 * Security: the connect token travels as a message body, so it stays in the room's history (and,
 * over FCM, in a push payload). It is the new account's bearer, valid while the agent exists.
 */
import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  GATEWAY_ACCOUNT_ID,
  pendingAccountId,
  PLUGIN_ID,
} from "./accounts.js";
import type { DispatchOutcome, WorkItem } from "./work-item.js";

export const AGENT_INVENTORY_ORIGIN = "openclaw-agent";

/** OpenClaw's implicit agent when `agents.entries` is empty. */
const IMPLICIT_AGENT_ID = "main";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_ACCOUNT_IDS: ReadonlySet<string> = new Set([DEFAULT_ACCOUNT_ID, GATEWAY_ACCOUNT_ID]);

export interface GatewayAgent {
  id: string;
  name: string;
  emoji?: string;
  boundAccount?: string;
  filamentUserId?: string;
}

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

/** The server accepts only these four string keys in an inventory entry. */
export interface InventoryEntry {
  name: string;
  description: string;
  origin: string;
  health: "ok";
}

/** An agent's fields ride in `description` as JSON, the one free-text key. */
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

export const STATUS_INVENTORY_ORIGIN = "openclaw-gateway-status";

export const MAX_REPORTED_STATUSES = 10;

/**
 * "applied" is reported before the config write, which reloads the plugin and clears this list; a
 * connect is confirmed by the new agent coming online.
 */
export interface GatewayStatus {
  requestId: string;
  command: "connect" | "disconnect" | "unpair" | "agents" | "update" | "invalid";
  agentId?: string;
  state: "applied" | "rejected" | "failed";
  message?: string;
}

export type GatewayCommand = { requestId: string } &
  /** Without `agentId` the token becomes a pending account that picks its agent in chat. */
  (
    | { kind: "connect"; agentId?: string; token: string }
    | { kind: "disconnect"; agentId: string }
    | { kind: "unpair" }
    | { kind: "agents" }
    | { kind: "update" }
    | { kind: "invalid"; reason: string }
  );

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The update notice's button sends its own label back; it reads as `/filament update`. */
export const UPDATE_NOW_LABEL = "Update now";

/** A trailing request id keys the reported outcome; a hand-typed command gets the event id. */
export function parseGatewayCommand(
  body: string,
  fallbackRequestId: string,
): GatewayCommand | null {
  const words =
    body.trim().toLowerCase() === UPDATE_NOW_LABEL.toLowerCase()
      ? ["/filament", "update"]
      : body.trim().split(/\s+/);
  if (words[0] !== "/filament") return null;
  const verb = words[1];
  const args = words.slice(2);
  // `connect <token>` names no agent: the app sends it through an agent that is
  // already connected, and the new account asks which agent it is in its chat.
  const tokenOnly =
    verb === "connect" &&
    (args[0]?.startsWith("fmcp_") ?? false) &&
    !(args[1]?.startsWith("fmcp_") ?? false);
  const arity = verb === "connect" ? (tokenOnly ? 1 : 2) : verb === "disconnect" ? 1 : 0;
  const extra = args.slice(arity);
  const requestId =
    extra.length === 1 && REQUEST_ID_PATTERN.test(extra[0]!) ? extra[0]! : fallbackRequestId;
  const invalid = (reason: string): GatewayCommand => ({ kind: "invalid", reason, requestId });
  if (!["connect", "disconnect", "unpair", "agents", "update"].includes(verb ?? "")) {
    return invalid(
      "commands: agents, connect <agent-id> <token>, disconnect <agent-id>, unpair, update",
    );
  }
  if (args.length < arity || extra.length > 1 || (extra.length === 1 && requestId !== extra[0])) {
    return invalid(
      verb === "connect"
        ? "usage: /filament connect [<agent-id>] <connect-token> [<request-id>]"
        : `usage: /filament ${verb}${arity >= 1 ? " <agent-id>" : ""} [<request-id>]`,
    );
  }
  if (verb === "agents") return { kind: "agents", requestId };
  if (verb === "unpair") return { kind: "unpair", requestId };
  if (verb === "update") return { kind: "update", requestId };
  if (tokenOnly) return { kind: "connect", token: args[0]!, requestId };
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
    if (accountId === GATEWAY_ACCOUNT_ID) continue;
    if (accountId === DEFAULT_ACCOUNT_ID) delete config.connectToken;
    else delete accounts[accountId];
  }
  accounts[agentId] = { ...asRecord(accounts[agentId]), connectToken: token };
  return { displaced: [...displaced] };
}

/**
 * A token with no agent named: the account install.sh would have written, so the plugin asks in
 * the new agent's chat which OpenClaw agent it is (choose-agent.ts). No binding yet.
 */
export function applyPendingConnect(draft: Record<string, unknown>, token: string): void {
  const plugins = ensureRecord(draft, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, PLUGIN_ID);
  const config = ensureRecord(entry, "config");
  const accounts = ensureRecord(config, "accounts");
  accounts[pendingAccountId(token)] = { connectToken: token, pending: true };
}

/**
 * Whether an item is a `/filament` command from the principal in this account's backchannel.
 * A connected agent answers these itself instead of waking its model, so a second Filament
 * agent can be connected from the app without a terminal, and the token never reaches a prompt.
 */
export function isGatewayCommandItem(
  item: WorkItem,
  principal: string | undefined,
  ccRoomId: string | undefined,
): boolean {
  if (!item.is_backchannel || item.channel_id !== ccRoomId || principal === undefined) return false;
  const last = item.messages[item.messages.length - 1];
  if (!last || last.sender !== principal) return false;
  return parseGatewayCommand(last.body, "x") !== null;
}

/** Deletes whichever account the binding pointed at, including `default` (the top-level token). */
export function applyAgentDisconnect(draft: Record<string, unknown>, agentId: string): void {
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  const accounts = asRecord(config.accounts);
  const bindings = Array.isArray(draft.bindings) ? (draft.bindings as unknown[]) : [];
  const unbound = new Set<string>();
  draft.bindings = bindings.filter((raw) => {
    const binding = asRecord(raw);
    const match = asRecord(binding.match);
    if (match.channel !== FILAMENT_CHANNEL_ID || binding.agentId !== agentId) return true;
    unbound.add(typeof match.accountId === "string" ? match.accountId : DEFAULT_ACCOUNT_ID);
    return false;
  });
  for (const accountId of unbound) {
    if (accountId === GATEWAY_ACCOUNT_ID) continue;
    if (accountId === DEFAULT_ACCOUNT_ID) delete config.connectToken;
    else delete accounts[accountId];
  }
}

export function applyUnpair(draft: Record<string, unknown>): void {
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  delete asRecord(config.accounts)[GATEWAY_ACCOUNT_ID];
}

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

export interface GatewayItemContext {
  item: WorkItem;
  /**
   * `control`: every command. `connect`: only `/filament connect <token>` and `/filament update`; a
   * connected agent's account must not disconnect or unpair what other accounts, or other
   * principals, own.
   */
  scope?: "control" | "connect";
  principal: string | undefined;
  ccRoomId: string | undefined;
  gatewayConfig: unknown;
  consume: (upToEventId: string) => Promise<void>;
  mutateConfig: (mutate: (draft: Record<string, unknown>) => void) => Promise<void>;
  /** Updates the plugin; the reload that follows replaces this account. Absent: `update` is rejected. */
  update?: () => Promise<void>;
  report: (statuses: GatewayStatus[]) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Never returns "error": that would pause the account, which must stay up for the next command.
 * Several commands in one item are written as ONE config mutation, because the first write reloads
 * the plugin and would cut the rest off.
 */
export async function handleGatewayItem(ctx: GatewayItemContext): Promise<DispatchOutcome> {
  const { item, log } = ctx;
  const done: DispatchOutcome = { kind: "silent" };
  if (item.messages.length === 0) return done;
  // Only the principal's own lines are commands; another sender's line in the
  // same item is ignored, not a reason to drop the principal's.
  const principalMessages =
    ctx.principal === undefined ? [] : item.messages.filter((m) => m.sender === ctx.principal);
  if (!item.is_backchannel || item.channel_id !== ctx.ccRoomId || principalMessages.length === 0) {
    log("filament-gateway: ignoring work outside the principal's backchannel");
    return done;
  }

  const commands = principalMessages
    .map((m) => parseGatewayCommand(m.body, m.event_id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)))
    .filter((parsed): parsed is GatewayCommand => parsed !== null)
    .map((command): GatewayCommand => {
      if (ctx.scope !== "connect" || command.kind === "invalid") return command;
      if (command.kind === "connect" && command.agentId === undefined) return command;
      if (command.kind === "update") return command;
      return {
        kind: "invalid",
        requestId: command.requestId,
        reason: "only `/filament connect <connect-token>` and `/filament update` are accepted here",
      };
    });
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
  let update: GatewayStatus | undefined;
  for (const command of commands) {
    const base = { requestId: command.requestId };
    if (command.kind === "invalid") {
      statuses.push({ ...base, command: "invalid", state: "rejected", message: command.reason });
    } else if (command.kind === "update") {
      update = ctx.update
        ? { ...base, command: "update", state: "applied" }
        : { ...base, command: "update", state: "rejected", message: "updates are off here" };
      statuses.push(update);
    } else if (command.kind === "agents") {
      statuses.push({ ...base, command: "agents", state: "applied" });
    } else if (command.kind === "connect" && command.agentId === undefined) {
      mutations.push((draft) => {
        applyPendingConnect(draft, command.token);
      });
      statuses.push({ ...base, command: "connect", state: "applied" });
    } else if (command.kind === "connect") {
      const { agentId, token } = command as { agentId: string; token: string };
      if (!knownAgents.has(agentId)) {
        statuses.push({
          ...base,
          command: "connect",
          agentId,
          state: "rejected",
          message: `This gateway has no OpenClaw agent "${agentId}".`,
        });
      } else {
        mutations.push((draft) => {
          applyAgentConnect(draft, agentId, token);
        });
        statuses.push({ ...base, command: "connect", agentId, state: "applied" });
      }
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
  const failed = (status: GatewayStatus, message: string): GatewayStatus => ({
    ...status,
    state: "failed",
    message,
  });
  if (mutations.length > 0 && wouldChange(ctx.gatewayConfig, mutate)) {
    try {
      await ctx.mutateConfig(mutate);
      log(`filament-gateway: wrote ${commands.map((c) => c.kind).join(", ")}`);
    } catch (error) {
      log(`filament-gateway: config write failed: ${String(error)}`);
      await report(
        statuses
          .filter(
            (status) =>
              status.state === "applied" && status.command !== "agents" && status !== update,
          )
          .map((status) =>
            failed(status, `Couldn't save the change on the gateway: ${String(error)}`),
          ),
      );
    }
  } else if (mutations.length > 0) {
    log("filament-gateway: commands change nothing; skipping the write");
  }
  // Last: the update reloads the plugin, and a write before it would be cut off.
  if (update?.state === "applied" && ctx.update) {
    try {
      await ctx.update();
      log("filament-gateway: plugin update started");
    } catch (error) {
      log(`filament-gateway: plugin update failed: ${String(error)}`);
      await report([failed(update, `Couldn't update the plugin: ${String(error)}`)]);
    }
  }
  return done;
}
