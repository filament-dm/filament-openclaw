/**
 * A pending account: install.sh connected a Filament agent without naming an OpenClaw agent
 * (`pending: true`), because only the gateway knows its agents. The account runs no turns. A
 * gateway with one free agent binds it at once; otherwise the account asks its principal in the
 * backchannel, one suggested-message button per agent, and binds the one they tap.
 */
import { asRecord, DEFAULT_ACCOUNT_ID, GATEWAY_ACCOUNT_ID, PLUGIN_ID } from "./accounts.js";
import { applyAgentConnect, type GatewayAgent } from "./gateway.js";
import type { DispatchOutcome, WorkItem } from "./work-item.js";

export const PENDING_ACCOUNT_PREFIX = "pending-";

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

/** A gateway with exactly one agent, still free, needs no question. */
export function automaticChoice(options: readonly ChoiceOption[]): string | null {
  return options.length === 1 && !options[0]!.taken ? options[0]!.agentId : null;
}

export function questionBody(options: readonly ChoiceOption[], retry = false): string {
  const lead = retry
    ? "I didn't catch that. Tap the OpenClaw agent that should answer here:"
    : "I'm connected to your OpenClaw gateway. Which of its agents should answer here?";
  const rows = options.map(
    (option) =>
      `- [${option.label}](filament:message-send)${
        option.taken ? " — connected to another Filament agent; choosing it moves it here" : ""
      }`,
  );
  return [lead, "", ...rows].join("\n");
}

/** A tap sends the label back; a typed reply may also name the agent id. */
export function resolveChoice(text: string, options: readonly ChoiceOption[]): string | null {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  const match = options.find(
    (option) => option.label.toLowerCase() === needle || option.agentId.toLowerCase() === needle,
  );
  return match ? match.agentId : null;
}

/** Binds `agentId` to this account's token under its own account id and drops the pending one. */
export function applyPendingChoice(
  draft: Record<string, unknown>,
  pendingAccountId: string,
  agentId: string,
  token: string,
): void {
  applyAgentConnect(draft, agentId, token);
  const config = asRecord(asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config);
  delete asRecord(config.accounts)[pendingAccountId];
}

export interface PendingChoiceContext {
  item: WorkItem;
  principal: string | undefined;
  ccRoomId: string | undefined;
  options: readonly ChoiceOption[];
  consume: (upToEventId: string) => Promise<void>;
  say: (markdownBody: string) => Promise<void>;
  bind: (agentId: string) => Promise<void>;
  log: (message: string) => void;
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
  // Said before binding: the write restarts this account under the agent's own id.
  await ctx.say(`Done — **${label}** answers here from now on.`);
  try {
    await ctx.bind(agentId);
    log(`filament-choose: bound OpenClaw agent '${agentId}'`);
  } catch (error) {
    log(`filament-choose: config write failed: ${String(error)}`);
    await ctx.say(`I couldn't save that on the gateway: ${String(error)}`);
  }
  return done;
}
