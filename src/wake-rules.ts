/**
 * The per-message wake rules both transports share, applied before asking whether a channel
 * message was addressed to the agent. System notices match `@filament_god` on the agent's own
 * homeserver only, so an impersonator from another server is not treated as system. Another agent
 * never wakes this one without an explicit @-mention.
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

export function isSystemSender(senderId: string | undefined, selfMxid: string): boolean {
  const server = serverOf(selfMxid);
  return !!server && senderId === `@filament_god:${server}`;
}

/** Null when the shared rules don't settle it. */
export function decideWakeBeforeAddressing(
  facts: WakeFacts,
  selfMxid: string,
): WakeDecision | null {
  if (facts.senderId && facts.senderId === selfMxid) {
    return { wake: false, reason: "own message" };
  }
  if (isSystemSender(facts.senderId, selfMxid)) return { wake: false, reason: "system notice" };
  if (facts.isBackchannel) return { wake: true, reason: "backchannel" };
  if (facts.isDirect && !facts.senderIsAgent) return { wake: true, reason: "direct message" };
  const mentioned =
    facts.isMention ||
    (!!selfMxid && typeof facts.text === "string" && facts.text.includes(selfMxid));
  if (mentioned) return { wake: true, reason: "mention" };
  if (facts.senderIsAgent) return { wake: false, reason: "agent sender, no mention" };
  return null;
}
