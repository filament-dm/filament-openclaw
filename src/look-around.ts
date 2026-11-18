/**
 * The look around: Filament's guides have a new agent, right after its first hello, read its
 * Filament tools and Filament's description and tell its owner what makes Filament different. Here
 * the gateway says the hello (hello.ts), so it also hands the agent that step, as one turn in a
 * side session of the backchannel, beside the transport: the agent keeps listening meanwhile.
 * Once per Filament agent, and silent when it fails: nothing is retried or reported to the owner.
 */
import { isFirstContact, type ResolvedIdentity } from "./onboarding-core.js";
import { runTurnWithStartDeadline } from "./transports/poll/turn-deadline.js";
import type { TurnOptions, TurnResult } from "./transports/types.js";
import { sleepAbortable } from "./util.js";
import type { WorkItem } from "./work-item.js";

/** Its prompt stays out of the owner's conversation, as the hello's does. */
export const LOOK_AROUND_SIDE_SESSION = "filament-look-around";

export const LOOK_AROUND_STATUS = "Looking around Filament…";

/** How the step has the agent open its message; a final reply without it is not the write-up. */
export const LOOK_AROUND_OPENING = "I took a look around Filament.";

/** After a config write, how long the account's reload gets to arrive before the look starts. */
export const RELOAD_GRACE_MS = 30_000;

/**
 * Owed with a first hello only when the server asked for a first contact: the agent has never
 * posted in its backchannel, so it is new. An agent this gateway had merely not met (a reconnect
 * on another machine, a wiped state store) says hello again but does not look around again.
 */
export function lookAroundDue(instructions: string | null | undefined): boolean {
  return isFirstContact(instructions);
}

/**
 * The step every Filament guide gives a new agent, with OpenClaw's tool names. Read by the agent
 * as its principal's message; it is the gateway speaking, so it says so.
 */
export function lookAroundPrompt(ccRoomId: string): string {
  return [
    "[system: This is the gateway, not your owner. You just joined Filament and said hello to " +
      "your owner in your private chat with them, your backchannel. The gateway asks this of " +
      "you once, now.",
    "Find out what makes Filament different, decide what you think of it, and tell your owner " +
      "in a second message, separate from your hello. Take a few minutes and dig. If any step " +
      "fails, skip the rest and say nothing about it.",
    "Your owner is watching the chat while you look. Before anything else call " +
      `\`filament_set_status\` with \`channel\` = \`${ccRoomId}\` (your backchannel's id) and ` +
      `\`status_text\` = \`${LOOK_AROUND_STATUS}\`. Update it as you move on ` +
      "(`Reading Filament's description…`, `Writing up what makes Filament different…`). Once " +
      "you have posted, clear it: `filament_set_status` with only `channel`.",
    "1. Start from your own tools: they are the ground truth. Read every Filament tool you have " +
      "(the `filament_` tools), with its description and input schema, and Filament's " +
      "instructions in your system prompt. Note each field, argument and rule that a Slack or " +
      "Discord bot API has no counterpart for.",
    "2. Then read `https://filament.dm/llms.txt` and the full description it links " +
      "(`https://filament.dm/llms-full.txt`; if that fails, " +
      "`https://raw.githubusercontent.com/filament-dm/filament-agent-kit/main/site/llms-full.txt`), " +
      "with whatever you have for fetching a page, for how Filament compares itself with other " +
      "chat apps. Check its claims against the tools. If you cannot fetch pages, go on from the " +
      "tools alone. Call `filament_get_settings` and `filament_list_channels` too.",
    "3. Post one message to your backchannel with `filament_message_principal`, answering " +
      '"How would you describe Filament, and what makes it different from other chat ' +
      `platforms?" as if your owner had just asked. Open with "${LOOK_AROUND_OPENING}" and one ` +
      "sentence that sums up what Filament really is, as you see it. Then give the four to " +
      "seven differences you find most significant, most important first. For each, lead with " +
      "the difference in bold, name the tool or field that shows it in `code`, say how a bot on " +
      "Slack or Discord handles the same thing, and say why it matters. Write like an expert " +
      "explaining it to a curious colleague: concrete and opinionated, with no marketing " +
      "phrases. Claim only what a tool, its schema, the instructions or the description says, " +
      "and add no guarantees they don't state, such as encryption or security. Leave out ids.",
    "Once you have posted and cleared your status, end this turn: what you reply here after " +
      "posting is not sent.]",
  ].join("\n\n");
}

export function lookAroundItem(
  identity: ResolvedIdentity,
  ccRoomId: string,
  now: number,
): WorkItem {
  return {
    channel_id: ccRoomId,
    thread_id: null,
    is_backchannel: true,
    messages: [
      {
        event_id: `look-around:${identity.mxid}`,
        sender: identity.principal,
        body: lookAroundPrompt(ccRoomId),
        ts: now,
      },
    ],
  };
}

/**
 * `none`: nothing owed. `deferred`: the account stopped first, and the look is still owed.
 * `skipped`: owed to another agent, or no backchannel. `tool`: the agent posted it. `turn`: its
 * final reply was the write-up, posted for it. `failed`: nothing was posted.
 */
export type LookAroundOutcome = "none" | "deferred" | "skipped" | "tool" | "turn" | "failed";

export interface LookAroundContext {
  identity: ResolvedIdentity;
  /** The agent (mxid) this account owes a look around; `take` reads and clears it in one step. */
  due: { peek: () => string | undefined; take: () => string | undefined };
  /** Resolves true when a config write is about to reload this account. */
  reloadExpected?: Promise<boolean>;
  /** The account's own: aborts the turn. */
  abortSignal: AbortSignal;
  runTurn: (item: WorkItem, opts: TurnOptions) => Promise<TurnResult>;
  /** Shows a status in the backchannel; null clears it. */
  setStatus: (text: string | null) => Promise<unknown>;
  /** Posts to the principal's backchannel; true only when it landed. */
  say: (markdownBody: string) => Promise<boolean>;
  log: (message: string) => void;
  now?: () => number;
  reloadGraceMs?: number;
  /** turn-deadline.ts's deadlines (tests set them short). */
  startTimeoutMs?: number;
  idleTimeoutMs?: number;
  settleMs?: number;
}

/** Never throws. */
export async function lookAroundOnce(ctx: LookAroundContext): Promise<LookAroundOutcome> {
  try {
    return await lookAround(ctx);
  } catch (error) {
    ctx.log(`filament-look-around: ${String(error)}`);
    return "failed";
  }
}

async function lookAround(ctx: LookAroundContext): Promise<LookAroundOutcome> {
  const { abortSignal, log } = ctx;
  if (ctx.due.peek() === undefined) return "none";

  // A reload would cut the turn short and the look would be lost: let it come first. The marker
  // stays until the look starts, so the account the reload brings back picks it up.
  const reloadExpected = await (ctx.reloadExpected ?? Promise.resolve(false)).catch(() => false);
  if (reloadExpected) await sleepAbortable(ctx.reloadGraceMs ?? RELOAD_GRACE_MS, abortSignal);
  if (abortSignal.aborted) return "deferred";

  // Taken before the turn: a look a restart cuts short is dropped rather than done twice.
  const owedTo = ctx.due.take();
  const ccRoomId = ctx.identity.ccRoomId;
  if (owedTo !== ctx.identity.mxid || !ccRoomId) {
    if (owedTo !== undefined) log("filament-look-around: not owed to this agent here; skipping");
    return owedTo === undefined ? "none" : "skipped";
  }

  log("filament-look-around: first connect; the agent looks around Filament");
  const quietly = (step: Promise<unknown>) => step.catch(() => undefined);
  await quietly(ctx.setStatus(LOOK_AROUND_STATUS));
  let watched;
  try {
    watched = await runTurnWithStartDeadline(
      (opts) => ctx.runTurn(lookAroundItem(ctx.identity, ccRoomId, (ctx.now ?? Date.now)()), opts),
      {
        abortSignal,
        log: (line) => log(`filament-look-around: ${line}`),
        startTimeoutMs: ctx.startTimeoutMs,
        idleTimeoutMs: ctx.idleTimeoutMs,
        settleMs: ctx.settleMs,
      },
    );
  } finally {
    // The agent clears its own status; this covers a turn that ended before it did.
    await quietly(ctx.setStatus(null));
  }
  if (watched.kind === "stuck") {
    log(`filament-look-around: the turn stalled; skipping (steps: ${watched.trail})`);
    return "failed";
  }
  const { result } = watched;
  if (result.repliedTo.has("backchannel") || result.repliedTo.has(ccRoomId)) {
    log("filament-look-around: the agent posted what it found");
    return "tool";
  }
  const text = result.sawError ? "" : result.finalText.trim();
  if (text.includes(LOOK_AROUND_OPENING) && !abortSignal.aborted && (await ctx.say(text))) {
    log("filament-look-around: posted the agent's final reply for it");
    return "turn";
  }
  log("filament-look-around: the turn posted nothing; skipping");
  return "failed";
}
