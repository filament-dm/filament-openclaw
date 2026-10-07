function serverOf(mxid) {
  const colon = mxid.indexOf(":");
  return colon === -1 ? "" : mxid.slice(colon + 1);
}
function isSystemSender(senderId, selfMxid) {
  const server = serverOf(selfMxid);
  return !!server && senderId === `@filament_god:${server}`;
}
function decideWakeBeforeAddressing(facts, selfMxid) {
  if (facts.senderId && facts.senderId === selfMxid) {
    return { wake: false, reason: "own message" };
  }
  if (isSystemSender(facts.senderId, selfMxid)) return { wake: false, reason: "system notice" };
  if (facts.isBackchannel) return { wake: true, reason: "backchannel" };
  const agentAsksUs = facts.senderIsAgent && facts.addressedWithReply === true;
  if (facts.isDirect && (!facts.senderIsAgent || agentAsksUs)) {
    return { wake: true, reason: "direct message" };
  }
  const mentioned = facts.isMention || !!selfMxid && typeof facts.text === "string" && facts.text.includes(selfMxid);
  if (mentioned) return { wake: true, reason: "mention" };
  if (agentAsksUs) return { wake: true, reason: "addressed by another agent" };
  if (facts.senderIsAgent) return { wake: false, reason: "agent sender, no mention" };
  return null;
}
export {
  decideWakeBeforeAddressing,
  isSystemSender
};
