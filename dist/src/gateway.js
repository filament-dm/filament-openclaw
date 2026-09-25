import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  FILAMENT_CHANNEL_ID,
  GATEWAY_ACCOUNT_ID,
  PLUGIN_ID
} from "./accounts.js";
const AGENT_INVENTORY_ORIGIN = "openclaw-agent";
const IMPLICIT_AGENT_ID = "main";
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_ACCOUNT_IDS = /* @__PURE__ */ new Set([DEFAULT_ACCOUNT_ID, GATEWAY_ACCOUNT_ID]);
function listGatewayAgents(gatewayConfig, filamentUserOf = () => void 0) {
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
    const filamentUserId = boundAccount ? filamentUserOf(boundAccount) : void 0;
    return {
      id,
      name,
      ...emoji ? { emoji } : {},
      ...boundAccount ? { boundAccount } : {},
      ...filamentUserId ? { filamentUserId } : {}
    };
  });
}
function inventoryEntries(agents, statuses = []) {
  return [
    ...agents.map((agent) => ({
      name: agent.id,
      description: JSON.stringify(agent),
      origin: AGENT_INVENTORY_ORIGIN,
      health: "ok"
    })),
    ...statuses.map((status) => ({
      name: `status:${status.requestId}`,
      description: JSON.stringify(status),
      origin: STATUS_INVENTORY_ORIGIN,
      health: "ok"
    }))
  ];
}
const STATUS_INVENTORY_ORIGIN = "openclaw-gateway-status";
const MAX_REPORTED_STATUSES = 10;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function parseGatewayCommand(body, fallbackRequestId) {
  const words = body.trim().split(/\s+/);
  if (words[0] !== "/filament") return null;
  const verb = words[1];
  const arity = verb === "connect" ? 2 : verb === "disconnect" ? 1 : 0;
  const args = words.slice(2);
  const extra = args.slice(arity);
  const requestId = extra.length === 1 && REQUEST_ID_PATTERN.test(extra[0]) ? extra[0] : fallbackRequestId;
  const invalid = (reason) => ({ kind: "invalid", reason, requestId });
  if (!["connect", "disconnect", "unpair", "agents"].includes(verb ?? "")) {
    return invalid("commands: agents, connect <agent-id> <token>, disconnect <agent-id>, unpair");
  }
  if (args.length < arity || extra.length > 1 || extra.length === 1 && requestId !== extra[0]) {
    return invalid(
      `usage: /filament ${verb}${arity >= 1 ? " <agent-id>" : ""}${arity === 2 ? " <connect-token>" : ""} [<request-id>]`
    );
  }
  if (verb === "agents") return { kind: "agents", requestId };
  if (verb === "unpair") return { kind: "unpair", requestId };
  const agentId = args[0];
  if (!AGENT_ID_PATTERN.test(agentId) || RESERVED_ACCOUNT_IDS.has(agentId)) {
    return invalid(`"${agentId}" is not a usable agent id`);
  }
  if (verb === "disconnect") return { kind: "disconnect", agentId, requestId };
  const token = args[1];
  if (!token.startsWith("fmcp_")) {
    return invalid("the connect token must start with fmcp_");
  }
  return { kind: "connect", agentId, token, requestId };
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
    if (accountId === GATEWAY_ACCOUNT_ID) continue;
    if (accountId === DEFAULT_ACCOUNT_ID) delete config.connectToken;
    else delete accounts[accountId];
  }
  accounts[agentId] = { ...asRecord(accounts[agentId]), connectToken: token };
  return { displaced: [...displaced] };
}
function applyAgentDisconnect(draft, agentId) {
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  const accounts = asRecord(config.accounts);
  delete accounts[agentId];
  if (Array.isArray(draft.bindings)) {
    draft.bindings = draft.bindings.filter((raw) => {
      const match = asRecord(asRecord(raw).match);
      return !(match.channel === FILAMENT_CHANNEL_ID && match.accountId === agentId);
    });
  }
}
function applyUnpair(draft) {
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  delete asRecord(config.accounts)[GATEWAY_ACCOUNT_ID];
}
function wouldChange(gatewayConfig, mutate) {
  const cfg = asRecord(gatewayConfig);
  const slice = (c) => JSON.stringify({
    config: asRecord(asRecord(asRecord(c.plugins).entries)[PLUGIN_ID]).config ?? null,
    bindings: c.bindings ?? null
  });
  const draft = structuredClone({ plugins: cfg.plugins, bindings: cfg.bindings });
  const before = slice(draft);
  mutate(draft);
  return slice(draft) !== before;
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
async function handleGatewayItem(ctx) {
  const { item, log } = ctx;
  const done = { kind: "silent" };
  const fromPrincipal = ctx.principal !== void 0 && item.messages.every((m) => m.sender === ctx.principal);
  if (!item.is_backchannel || item.channel_id !== ctx.ccRoomId || !fromPrincipal) {
    log("filament-gateway: ignoring work outside the principal's backchannel");
    return done;
  }
  const commands = item.messages.map((m) => parseGatewayCommand(m.body, m.event_id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64))).filter((parsed) => parsed !== null);
  const last = item.messages[item.messages.length - 1];
  await ctx.consume(last.event_id).catch((error) => {
    log(`filament-gateway: could not mark the commands read: ${String(error)}`);
  });
  if (commands.length === 0) return done;
  const knownAgents = new Set(listGatewayAgents(ctx.gatewayConfig).map((a) => a.id));
  const statuses = [];
  const mutations = [];
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
        message: `This gateway has no OpenClaw agent "${command.agentId}".`
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
  const report = (entries) => ctx.report(entries).catch((error) => {
    log(`filament-gateway: status report failed: ${String(error)}`);
  });
  await report(statuses);
  const mutate = (draft) => {
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
      statuses.filter((status) => status.state === "applied" && status.command !== "agents").map((status) => ({
        ...status,
        state: "failed",
        message: `Couldn't save the change on the gateway: ${String(error)}`
      }))
    );
  }
  return done;
}
export {
  AGENT_INVENTORY_ORIGIN,
  MAX_REPORTED_STATUSES,
  STATUS_INVENTORY_ORIGIN,
  applyAgentConnect,
  applyAgentDisconnect,
  applyUnpair,
  handleGatewayItem,
  inventoryEntries,
  listGatewayAgents,
  parseGatewayCommand,
  wouldChange
};
//# sourceMappingURL=gateway.js.map
