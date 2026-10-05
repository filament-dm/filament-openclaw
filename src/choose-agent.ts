/**
 * A pending account: install.sh connected a Filament agent without naming an OpenClaw agent
 * (`pending: true`), because only the gateway knows its agents. The account runs no turns. A
 * gateway with one free agent binds it at once; otherwise the account asks its principal in the
 * backchannel, one suggested-message button per agent, and binds the one they tap.
 */
import {
  asRecord,
  DEFAULT_ACCOUNT_ID,
  GATEWAY_ACCOUNT_ID,
  PENDING_ACCOUNT_PREFIX,
  PLUGIN_ID,
} from "./accounts.js";
import { applyAgentConnect, type GatewayAgent } from "./gateway.js";
import type { DispatchOutcome, WorkItem } from "./work-item.js";

export { PENDING_ACCOUNT_PREFIX };

const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set([DEFAULT_ACCOUNT_ID, GATEWAY_ACCOUNT_ID]);

/** The agents a pending account may become; `taken` ones answer as another Filament agent now. */
export interface ChoiceOption {
  agentId: string;
  /** The button's text, which is also the message a tap sends back. */
  label: string;
  taken: boolean;
}

export function choiceOptions(agents: readonly GatewayAgent[]): ChoiceOption[] {
  const usable = agents.filter((agent) => !RESERVED_AGENT_IDS.has(agent.id));
  const base = (agent: GatewayAgent) => `${agent.emoji ? `${agent.emoji} ` : ""}${agent.name}`;
  const counts = new Map<string, number>();
  for (const agent of usable) counts.set(base(agent), (counts.get(base(agent)) ?? 0) + 1);
  return usable.map((agent) => ({
    agentId: agent.id,
    label: counts.get(base(agent))! > 1 ? `${base(agent)} (${agent.id})` : base(agent),
    taken: agent.boundAccount !== undefined,
  }));
}

/** The agents still free to take; a taken one answers as another Filament agent already. */
export function freeOptions(options: readonly ChoiceOption[]): ChoiceOption[] {
  return options.filter((option) => !option.taken);
}

/** A gateway with exactly one free agent needs no question. */
export function automaticChoice(options: readonly ChoiceOption[]): string | null {
  const free = freeOptions(options);
  return free.length === 1 ? free[0]!.agentId : null;
}

/** Only free agents are offered; taken ones are listed, not tappable. */
export function questionBody(options: readonly ChoiceOption[], retry = false): string {
  const lead = retry
    ? "I didn't catch that. Tap the OpenClaw agent that should answer here:"
    : "I'm connected to your OpenClaw gateway. Which of its agents should answer here?";
  const rows = freeOptions(options).map((option) => `- [${option.label}](filament:message-send)`);
  const taken = options.filter((option) => option.taken).map((option) => option.label);
  const footer =
    taken.length > 0
      ? ["", `Already connected to another Filament agent: ${taken.join(", ")}.`]
      : [];
  return [lead, "", ...rows, ...footer].join("\n");
}

/** What to say when nothing on the gateway is free to take. */
export function nothingFreeBody(options: readonly ChoiceOption[]): string {
  return options.length === 0
    ? "I'm connected to your OpenClaw gateway, but it has no agents to answer as. Add one in OpenClaw, then connect again."
    : "I'm connected to your OpenClaw gateway, but every agent on it already answers as another Filament agent. Disconnect one of those, or add an agent in OpenClaw, then connect again.";
}

/** A tap sends the label back; a typed reply may also name the agent id. */
export function resolveChoice(text: string, options: readonly ChoiceOption[]): string | null {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  const match = freeOptions(options).find(
    (option) => option.label.toLowerCase() === needle || option.agentId.toLowerCase() === needle,
  );
  return match ? match.agentId : null;
}

/** The account `agentId` is bound to in `draft`, if any. */
function boundAccountOf(draft: Record<string, unknown>, agentId: string): string | undefined {
  const bindings = Array.isArray(draft.bindings) ? draft.bindings : [];
  for (const raw of bindings) {
    const binding = asRecord(raw);
    const match = asRecord(binding.match);
    if (match.channel === "filament" && binding.agentId === agentId) {
      return typeof match.accountId === "string" ? match.accountId : DEFAULT_ACCOUNT_ID;
    }
  }
  return undefined;
}

/**
 * Binds `agentId` to this account's token under its own account id and drops the pending one.
 * Checked against the draft it is applied to, not the options the question was built from: two
 * pending accounts asked at once may both be answered with the same agent, and the second write
 * must not displace the first. Returns false when the agent was taken meanwhile.
 */
export function applyPendingChoice(
  draft: Record<string, unknown>,
  pendingAccountId: string,
  agentId: string,
  token: string,
): boolean {
  const holder = boundAccountOf(draft, agentId);
  if (holder !== undefined && holder !== pendingAccountId && holder !== agentId) return false;
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  const accounts = asRecord(config.accounts);
  const current = asRecord(accounts[holder ?? ""]);
  // Bound to a live account already (its own id): taken, unless it is this very token.
  if (holder === agentId && current.connectToken !== undefined && current.connectToken !== token) {
    return false;
  }
  applyAgentConnect(draft, agentId, token);
  delete accounts[pendingAccountId];
  return true;
}

export type BindOutcome = "taken" | "applied" | "written";

export interface PendingChoiceContext {
  item: WorkItem;
  principal: string | undefined;
  ccRoomId: string | undefined;
  options: readonly ChoiceOption[];
  consume: (upToEventId: string) => Promise<void>;
  say: (markdownBody: string) => Promise<void>;
  /**
   * `taken`: another account bound the agent meanwhile. `applied`: the gateway reloaded with the
   * choice, which replaces this account. `written`: saved, but the gateway did not pick it up.
   */
  bind: (agentId: string, label: string) => Promise<BindOutcome>;
  /** The options as they stand now, for a second question. */
  refreshOptions?: () => readonly ChoiceOption[];
  log: (message: string) => void;
}

export function greetingBody(label: string): string {
  return `Done — **${label}** answers here from now on.`;
}

export function notAppliedBody(label: string): string {
  return `I saved **${label}** as the agent for this chat, but the gateway did not pick the change up. Run \`openclaw gateway restart\` on it and **${label}** will take over here.`;
}

/** Never "error": the account has to stay up until the principal answers. */
export async function handlePendingItem(ctx: PendingChoiceContext): Promise<DispatchOutcome> {
  const { item, log } = ctx;
  const done: DispatchOutcome = { kind: "silent" };
  const last = item.messages[item.messages.length - 1];
  if (!last) return done;
  // Consume first: binding reloads the plugin, and an unread answer would come back after it.
  await ctx.consume(last.event_id).catch((error) => {
    log(`filament-choose: could not mark the answer read: ${String(error)}`);
  });
  const fromPrincipal = ctx.principal !== undefined && last.sender === ctx.principal;
  if (!item.is_backchannel || item.channel_id !== ctx.ccRoomId || !fromPrincipal) {
    log("filament-choose: ignoring work until an OpenClaw agent is chosen");
    return done;
  }
  const agentId = resolveChoice(last.body, ctx.options);
  if (!agentId) {
    await ctx.say(questionBody(ctx.options, true));
    return done;
  }
  const label = ctx.options.find((option) => option.agentId === agentId)!.label;
  try {
    const outcome = await ctx.bind(agentId, label);
    if (outcome === "taken") {
      log(`filament-choose: '${agentId}' was taken before the write`);
      await ctx.say(
        `**${label}** was just connected to another Filament agent.\n\n${questionBody(ctx.refreshOptions?.() ?? ctx.options, true)}`,
      );
      return done;
    }
    if (outcome === "written") {
      log(`filament-choose: bound OpenClaw agent '${agentId}' but the gateway did not reload`);
      await ctx.say(notAppliedBody(label));
      return done;
    }
    // Applied: the reload replaced this account, and the bound one greets on connect.
    log(`filament-choose: bound OpenClaw agent '${agentId}'`);
  } catch (error) {
    log(`filament-choose: config write failed: ${String(error)}`);
    await ctx.say(`I couldn't save that on the gateway: ${String(error)}`);
  }
  return done;
}
