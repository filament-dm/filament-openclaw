/**
 * The wake rules both transports share, applied per message before any
 * question of whether a channel message was addressed to the agent. Pure.
 *
 *   - never: its own messages, and the system notices `@filament_god` sends
 *     (matched on the agent's own homeserver only, so an impersonator from
 *     another server is not treated as system);
 *   - always: the backchannel, direct messages, an @-mention (the server's
 *     flag, or the mxid in the text);
 *   - never, past that: another agent, so agents never wake each other
 *     without an explicit @-mention.
 *
 * Anything else is left undecided here. Over FCM the plugin's own policy
 * decides it (src/transports/fcm/wake-policy.ts); a poll_work item was
 * already let through by the server's participation mode.
 */

export type WakeDecision = { wake: boolean; reason: string };

export interface WakeFacts {
  senderId: string | undefined;
  isBackchannel: boolean;
  isDirect: boolean;
  isMention: boolean;
  text: string | null | undefined;
  senderIsAgent: boolean;
}

function serverOf(mxid: string): string {
  const colon = mxid.indexOf(":");
  return colon === -1 ? "" : mxid.slice(colon + 1);
}

/** The system user's notices (e.g. "you were added to…") never wake an agent. */
export function isSystemSender(senderId: string | undefined, selfMxid: string): boolean {
  const server = serverOf(selfMxid);
  return !!server && senderId === `@filament_god:${server}`;
}

/** The shared rules' decision for one message, or null when they don't settle it. */
export function decideWakeBeforeAddressing(
  facts: WakeFacts,
  selfMxid: string,
): WakeDecision | null {
  if (facts.senderId && facts.senderId === selfMxid) {
    return { wake: false, reason: "own message" };
  }
  if (isSystemSender(facts.senderId, selfMxid)) return { wake: false, reason: "system notice" };
  if (facts.isBackchannel) return { wake: true, reason: "backchannel" };
  if (facts.isDirect) return { wake: true, reason: "direct message" };
  const mentioned =
    facts.isMention ||
    (!!selfMxid && typeof facts.text === "string" && facts.text.includes(selfMxid));
  if (mentioned) return { wake: true, reason: "mention" };
  if (facts.senderIsAgent) return { wake: false, reason: "agent sender, no mention" };
  return null;
}
