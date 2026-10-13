/**
 * The first hello: the Filament app's connect screen waits for the new agent to say something in
 * its principal's backchannel, and a sign-in the gateway finishes has no turn in flight to say
 * it. On an account's first connect as a Filament agent, the agent runs one turn in the
 * backchannel, in its own voice, and the reply is posted there. Once landed it is never repeated
 * for that account and agent; a turn that says nothing falls back to a fixed line.
 */
import { isFirstContact, type ResolvedIdentity } from "./onboarding-core.js";
import type { TurnResult } from "./transports/types.js";
import type { WorkItem } from "./work-item.js";

/**
 * Read by the agent as its principal's message; it is the gateway speaking, so it says so. The
 * profile was seeded in code (profile-seed.ts); `filamentName` is the name it now carries.
 */
export function helloPrompt(filamentName?: string): string {
  const named = filamentName ? ` Your Filament profile name is now "${filamentName}".` : "";
  return (
    "[system: You just joined Filament for your owner, and this is your private chat with them; " +
    `they are waiting to see you arrive.${named} Reply with one short message: say hello, ` +
    "introduce yourself by the name your owner knows you by, and say you are listening here for " +
    "anything they want. Use no tools.]"
  );
}

export const FALLBACK_HELLO =
  "Hi — I'm connected to Filament and listening here. Ask me anything, give me tasks, or tell me how you'd like me to behave.";

const HELLO_TURN_TIMEOUT_MS = 90_000;

/**
 * The hello runs in a side session of the backchannel's: its gateway-written prompt never shows as
 * the owner's message in the main session, in Filament or in OpenClaw's own chat.
 */
export const HELLO_SIDE_SESSION = "filament-first-hello";

/**
 * Due when the server asks for a first contact (it stops once the agent has posted in its
 * backchannel), or when this account connects as a Filament agent it has not been before; never
 * twice for the same account and agent.
 */
export function helloDue(params: {
  instructions: string | null | undefined;
  mxid: string;
  previousMxid: string | undefined;
  helloSentAs: string | undefined;
}): boolean {
  if (params.helloSentAs === params.mxid) return false;
  return isFirstContact(params.instructions) || params.previousMxid !== params.mxid;
}

export function helloItem(
  identity: ResolvedIdentity,
  ccRoomId: string,
  now: number,
  filamentName?: string,
): WorkItem {
  return {
    channel_id: ccRoomId,
    thread_id: null,
    is_backchannel: true,
    messages: [
      {
        event_id: `first-hello:${identity.mxid}`,
        sender: identity.principal,
        body: helloPrompt(filamentName),
        ts: now,
      },
    ],
  };
}

export type HelloOutcome = "tool" | "turn" | "fallback" | "failed" | "skipped";

export interface HelloContext {
  identity: ResolvedIdentity;
  runTurn: (item: WorkItem) => Promise<TurnResult>;
  /** Posts to the principal's backchannel; true only when it landed. */
  say: (markdownBody: string) => Promise<boolean>;
  log: (message: string) => void;
  /** The name the profile was just given, if it was. */
  filamentName?: string;
  now?: () => number;
  timeoutMs?: number;
}

/** `tool`: the agent posted it itself. Anything but `failed` and `skipped` landed. */
export async function sayFirstHello(ctx: HelloContext): Promise<HelloOutcome> {
  const ccRoomId = ctx.identity.ccRoomId;
  if (!ccRoomId) {
    ctx.log("filament-hello: no backchannel to say hello in; skipping");
    return "skipped";
  }
  ctx.log("filament-hello: first connect; the agent says hello in the backchannel");
  let result: TurnResult | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    result = await Promise.race([
      ctx.runTurn(helloItem(ctx.identity, ccRoomId, (ctx.now ?? Date.now)(), ctx.filamentName)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ctx.timeoutMs ?? HELLO_TURN_TIMEOUT_MS);
      }),
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
  if (text && (await ctx.say(text))) return "turn";
  if (await ctx.say(FALLBACK_HELLO)) return "fallback";
  ctx.log("filament-hello: could not say hello; will try again on the next connect");
  return "failed";
}
