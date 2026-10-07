import { openTable } from "./store.js";

/**
 * The pending-account flow: whether the question "which OpenClaw agent are you?" was already put
 * to the principal, and what the account bound by the answer says when it first connects. The
 * pending account cannot say it: the reload that applies its choice replaces it.
 */
const asked = openTable<number>("choice-asked");

// Tagged with the account that left it, so a losing bind clears only its own.
interface Greeting {
  from: string;
  body: string;
}

const greetings = openTable<Greeting>("bound-greetings");

/** False when this pending account already asked; a config reload must not ask again. */
export function choiceAsked(accountId: string): boolean {
  return asked.get(accountId) !== undefined;
}

/** Record that the question was put to the principal. Call it after the send succeeded. */
export function markChoiceAsked(accountId: string): void {
  asked.set(accountId, Date.now());
}

export function leaveGreeting(accountId: string, from: string, markdownBody: string): void {
  greetings.set(accountId, { from, body: markdownBody });
}

/** Clears the greeting only if `from` left it: another account's successful bind keeps its own. */
export function dropGreeting(accountId: string, from: string): void {
  if (greetings.get(accountId)?.from === from) greetings.delete(accountId);
}

/** The greeting left for this account, cleared on read so a later reload does not repeat it. */
export function takeGreeting(accountId: string): string | undefined {
  return greetings.take(accountId)?.body;
}
