import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  GATEWAY_ACCOUNT_ID,
  PENDING_ACCOUNT_PREFIX,
  PLUGIN_ID
} from "./accounts.js";
import { applyAgentConnect } from "./gateway.js";
const RESERVED_AGENT_IDS = /* @__PURE__ */ new Set([DEFAULT_ACCOUNT_ID, GATEWAY_ACCOUNT_ID]);
function choiceOptions(agents) {
  const usable = agents.filter((agent) => !RESERVED_AGENT_IDS.has(agent.id));
  const base = (agent) => `${agent.emoji ? `${agent.emoji} ` : ""}${agent.name}`;
  const counts = /* @__PURE__ */ new Map();
  for (const agent of usable) counts.set(base(agent), (counts.get(base(agent)) ?? 0) + 1);
  return usable.map((agent) => ({
    agentId: agent.id,
    label: counts.get(base(agent)) > 1 ? `${base(agent)} (${agent.id})` : base(agent),
    taken: agent.boundAccount !== void 0
  }));
}
function freeOptions(options) {
  return options.filter((option) => !option.taken);
}
function automaticChoice(options) {
  const free = freeOptions(options);
  return free.length === 1 ? free[0].agentId : null;
}
function questionBody(options, retry = false) {
  const lead = retry ? "I didn't catch that. Tap the OpenClaw agent that should answer here:" : "I'm connected to your OpenClaw gateway. Which of its agents should answer here?";
  const rows = freeOptions(options).map((option) => `- [${option.label}](filament:message-send)`);
  const taken = options.filter((option) => option.taken).map((option) => option.label);
  const footer = taken.length > 0 ? ["", `Already connected to another Filament agent: ${taken.join(", ")}.`] : [];
  return [lead, "", ...rows, ...footer].join("\n");
}
function nothingFreeBody(options) {
  return options.length === 0 ? "I'm connected to your OpenClaw gateway, but it has no agents to answer as. Add one in OpenClaw, then connect again." : "I'm connected to your OpenClaw gateway, but every agent on it already answers as another Filament agent. Disconnect one of those, or add an agent in OpenClaw, then connect again.";
}
function resolveChoice(text, options) {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  const match = freeOptions(options).find(
    (option) => option.label.toLowerCase() === needle || option.agentId.toLowerCase() === needle
  );
  return match ? match.agentId : null;
}
function applyPendingChoice(draft, pendingAccountId, agentId, token) {
  applyAgentConnect(draft, agentId, token);
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  delete asRecord(config.accounts)[pendingAccountId];
}
async function handlePendingItem(ctx) {
  const { item, log } = ctx;
  const done = { kind: "silent" };
  const last = item.messages[item.messages.length - 1];
  if (!last) return done;
  await ctx.consume(last.event_id).catch((error) => {
    log(`filament-choose: could not mark the answer read: ${String(error)}`);
  });
  const fromPrincipal = ctx.principal !== void 0 && last.sender === ctx.principal;
  if (!item.is_backchannel || item.channel_id !== ctx.ccRoomId || !fromPrincipal) {
    log("filament-choose: ignoring work until an OpenClaw agent is chosen");
    return done;
  }
  const agentId = resolveChoice(last.body, ctx.options);
  if (!agentId) {
    await ctx.say(questionBody(ctx.options, true));
    return done;
  }
  const label = ctx.options.find((option) => option.agentId === agentId).label;
  await ctx.say(`Done \u2014 **${label}** answers here from now on.`);
  try {
    await ctx.bind(agentId);
    log(`filament-choose: bound OpenClaw agent '${agentId}'`);
  } catch (error) {
    log(`filament-choose: config write failed: ${String(error)}`);
    await ctx.say(`I couldn't save that on the gateway: ${String(error)}`);
  }
  return done;
}
export {
  PENDING_ACCOUNT_PREFIX,
  applyPendingChoice,
  automaticChoice,
  choiceOptions,
  freeOptions,
  handlePendingItem,
  nothingFreeBody,
  questionBody,
  resolveChoice
};
