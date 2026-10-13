import { isFirstContact } from "./onboarding-core.js";
function helloPrompt(filamentName) {
  const named = filamentName ? ` Your Filament profile name is now "${filamentName}".` : "";
  return `[system: You just joined Filament for your owner, and this is your private chat with them; they are waiting to see you arrive.${named} Reply with one short message: say hello, introduce yourself by the name your owner knows you by, and say you are listening here for anything they want. Use no tools.]`;
}
const FALLBACK_HELLO = "Hi \u2014 I'm connected to Filament and listening here. Ask me anything, give me tasks, or tell me how you'd like me to behave.";
const HELLO_TURN_TIMEOUT_MS = 9e4;
function helloDue(params) {
  if (params.helloSentAs === params.mxid) return false;
  return isFirstContact(params.instructions) || params.previousMxid !== params.mxid;
}
function helloItem(identity, ccRoomId, now, filamentName) {
  return {
    channel_id: ccRoomId,
    thread_id: null,
    is_backchannel: true,
    messages: [
      {
        event_id: `first-hello:${identity.mxid}`,
        sender: identity.principal,
        body: helloPrompt(filamentName),
        ts: now
      }
    ]
  };
}
async function sayFirstHello(ctx) {
  const ccRoomId = ctx.identity.ccRoomId;
  if (!ccRoomId) {
    ctx.log("filament-hello: no backchannel to say hello in; skipping");
    return "skipped";
  }
  ctx.log("filament-hello: first connect; the agent says hello in the backchannel");
  let result;
  let timer;
  try {
    result = await Promise.race([
      ctx.runTurn(helloItem(ctx.identity, ccRoomId, (ctx.now ?? Date.now)(), ctx.filamentName)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(void 0), ctx.timeoutMs ?? HELLO_TURN_TIMEOUT_MS);
      })
    ]);
    if (!result) ctx.log("filament-hello: the hello turn took too long; saying the fixed hello");
  } catch (error) {
    ctx.log(`filament-hello: the hello turn failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (result && (result.repliedTo.has("backchannel") || result.repliedTo.has(ccRoomId))) {
    return "tool";
  }
  const text = result && !result.sawError ? result.finalText.trim() : "";
  if (text && await ctx.say(text)) return "turn";
  if (await ctx.say(FALLBACK_HELLO)) return "fallback";
  ctx.log("filament-hello: could not say hello; will try again on the next connect");
  return "failed";
}
export {
  FALLBACK_HELLO,
  helloDue,
  helloItem,
  helloPrompt,
  sayFirstHello
};
