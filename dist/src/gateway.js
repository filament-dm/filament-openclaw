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
function inventoryEntries(agents) {
  return agents.map((agent) => ({
    name: agent.id,
    description: JSON.stringify(agent),
    origin: AGENT_INVENTORY_ORIGIN,
    health: "ok"
  }));
}
function parseGatewayCommand(body) {
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
    reason: "commands: /filament agents, /filament connect <agent-id> <token>"
  };
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
  const answered = (ok) => ok ? { kind: "published" } : { kind: "silent" };
  const fromPrincipal = ctx.principal !== void 0 && item.messages.every((m) => m.sender === ctx.principal);
  if (!item.is_backchannel || item.channel_id !== ctx.ccRoomId || !fromPrincipal) {
    log("filament-gateway: ignoring work outside the principal's backchannel");
    return { kind: "silent" };
  }
  const command = [...item.messages].reverse().map((m) => parseGatewayCommand(m.body)).find((parsed) => parsed !== null);
  if (!command) {
    return answered(
      await ctx.reply(
        "I'm this OpenClaw gateway's link to Filament, not an agent. Connect its agents from the OpenClaw card in Filament."
      )
    );
  }
  if (command.kind === "invalid") {
    return answered(await ctx.reply(`\u26A0\uFE0F ${command.reason}`));
  }
  if (command.kind === "agents") {
    await ctx.reportInventory().catch((error) => {
      log(`filament-gateway: inventory report failed: ${String(error)}`);
    });
    return answered(await ctx.reply("Agent list refreshed."));
  }
  const agent = listGatewayAgents(ctx.gatewayConfig).find((a) => a.id === command.agentId);
  if (!agent) {
    return answered(await ctx.reply(`\u26A0\uFE0F This gateway has no OpenClaw agent "${command.agentId}".`));
  }
  const replied = await ctx.reply(
    `Connecting ${agent.emoji ? `${agent.emoji} ` : ""}**${agent.name}** (\`${agent.id}\`)\u2026`
  );
  try {
    let displaced = [];
    await ctx.mutateConfig((draft) => {
      displaced = applyAgentConnect(draft, command.agentId, command.token).displaced;
    });
    log(`filament-gateway: wrote account + binding for agent ${command.agentId}`);
    if (displaced.length > 0) {
      await ctx.followUp(`Replaced the Filament account this agent had (${displaced.join(", ")}).`).catch(() => {
      });
    }
  } catch (error) {
    log(`filament-gateway: config write failed for agent ${command.agentId}: ${String(error)}`);
    await ctx.followUp(`\u26A0\uFE0F Couldn't save the connection on the gateway: ${String(error)}`).catch(() => {
    });
  }
  return answered(replied);
}
export {
  AGENT_INVENTORY_ORIGIN,
  applyAgentConnect,
  handleGatewayItem,
  inventoryEntries,
  listGatewayAgents,
  parseGatewayCommand
};
//# sourceMappingURL=gateway.js.map
