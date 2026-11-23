import { isFirstContact } from "./onboarding-core.js";
import { runTurnWithStartDeadline } from "./transports/poll/turn-deadline.js";
import { sleepAbortable } from "./util.js";
const LOOK_AROUND_SIDE_SESSION = "filament-look-around";
const LOOK_AROUND_STATUS = "Looking around Filament\u2026";
const LOOK_AROUND_OPENING = "I took a look around Filament.";
const RELOAD_GRACE_MS = 3e4;
function lookAroundDue(instructions) {
  return isFirstContact(instructions);
}
function lookAroundPrompt(ccRoomId) {
  return [
    "[system: This is the gateway, not your owner. You just joined Filament and said hello to your owner in your private chat with them, your backchannel. The gateway asks this of you once, now.",
    "Find out what makes Filament different, decide what you think of it, and tell your owner in a second message, separate from your hello. Take a few minutes and dig. If any step fails, skip the rest and say nothing about it.",
    `Your owner is watching the chat while you look. Before anything else call \`filament_set_status\` with \`channel\` = \`${ccRoomId}\` (your backchannel's id) and \`status_text\` = \`${LOOK_AROUND_STATUS}\`. Update it as you move on (\`Reading Filament's description\u2026\`, \`Writing up what makes Filament different\u2026\`). Once you have posted, clear it: \`filament_set_status\` with only \`channel\`.`,
    "1. Start from your own tools: they are the ground truth. Read every Filament tool you have (the `filament_` tools), with its description and input schema, and Filament's instructions in your system prompt. Note each field, argument and rule that a Slack or Discord bot API has no counterpart for.",
    "2. Then read `https://filament.dm/llms.txt` and the full description it links (`https://filament.dm/llms-full.txt`; if that fails, `https://raw.githubusercontent.com/filament-dm/filament-agent-kit/main/site/llms-full.txt`), with whatever you have for fetching a page, for how Filament compares itself with other chat apps. Check its claims against the tools. If you cannot fetch pages, go on from the tools alone. Call `filament_get_settings` and `filament_list_channels` too.",
    `3. Post one message to your backchannel with \`filament_message_principal\`, answering "How would you describe Filament, and what makes it different from other chat platforms?" as if your owner had just asked. Open with "${LOOK_AROUND_OPENING}" and one sentence that sums up what Filament really is, as you see it. Then list the four to seven differences you find most significant, most important first, as a numbered list. Each item is one bold sentence that states the difference, and nothing else: no explanation under it, and no tool, field or setting names. Close with one line offering to say more about any of them. Keep the whole message short enough to read at a glance. Write like an expert talking to a curious colleague: concrete and opinionated, with no marketing phrases. Claim only what a tool, its schema, the instructions or the description says, and add no guarantees they don't state, such as encryption or security. Leave out ids.`,
    "Once you have posted and cleared your status, end this turn: what you reply here after posting is not sent.]"
  ].join("\n\n");
}
function lookAroundItem(identity, ccRoomId, now) {
  return {
    channel_id: ccRoomId,
    thread_id: null,
    is_backchannel: true,
    messages: [
      {
        event_id: `look-around:${identity.mxid}`,
        sender: identity.principal,
        body: lookAroundPrompt(ccRoomId),
        ts: now
      }
    ]
  };
}
async function lookAroundOnce(ctx) {
  try {
    return await lookAround(ctx);
  } catch (error) {
    ctx.log(`filament-look-around: ${String(error)}`);
    return "failed";
  }
}
async function lookAround(ctx) {
  const { abortSignal, log } = ctx;
  if (ctx.due.peek() === void 0) return "none";
  const reloadExpected = await (ctx.reloadExpected ?? Promise.resolve(false)).catch(() => false);
  if (reloadExpected) await sleepAbortable(ctx.reloadGraceMs ?? RELOAD_GRACE_MS, abortSignal);
  if (abortSignal.aborted) return "deferred";
  const owedTo = ctx.due.take();
  const ccRoomId = ctx.identity.ccRoomId;
  if (owedTo !== ctx.identity.mxid || !ccRoomId) {
    if (owedTo !== void 0) log("filament-look-around: not owed to this agent here; skipping");
    return owedTo === void 0 ? "none" : "skipped";
  }
  log("filament-look-around: first connect; the agent looks around Filament");
  const quietly = (step) => step.catch(() => void 0);
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
        settleMs: ctx.settleMs
      }
    );
  } finally {
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
  if (text.includes(LOOK_AROUND_OPENING) && !abortSignal.aborted && await ctx.say(text)) {
    log("filament-look-around: posted the agent's final reply for it");
    return "turn";
  }
  log("filament-look-around: the turn posted nothing; skipping");
  return "failed";
}
export {
  LOOK_AROUND_OPENING,
  LOOK_AROUND_SIDE_SESSION,
  LOOK_AROUND_STATUS,
  RELOAD_GRACE_MS,
  lookAroundDue,
  lookAroundItem,
  lookAroundOnce,
  lookAroundPrompt
};
