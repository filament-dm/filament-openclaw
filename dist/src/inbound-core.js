function asRecord(value) {
  return value && typeof value === "object" ? value : void 0;
}
function str(value) {
  return typeof value === "string" ? value : void 0;
}
function bool(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return void 0;
}
function decodeDirectPusher(env) {
  const data = env?.message?.data;
  if (!data) return null;
  const inner = asRecord(data.data) ?? data;
  if (bool(inner.badge_only) === true) return null;
  const rawBody = str(inner.body);
  let payload;
  if (rawBody) {
    try {
      payload = asRecord(JSON.parse(rawBody));
    } catch {
      payload = void 0;
    }
  }
  payload = payload ?? inner;
  const branch = asRecord(payload.branch);
  const branchType = str(branch?.type) ?? str(payload.type);
  if (!branchType) return null;
  let text;
  if (branch && "content" in branch) {
    const content = asRecord(branch.content);
    text = content ? str(content.text) ?? null : null;
  }
  return {
    branchType,
    eventId: str(payload.event_id),
    roomId: str(payload.room_id),
    isDirect: bool(payload.is_direct),
    sender: str(branch?.sender),
    senderId: str(branch?.sender_id),
    text,
    channel: str(branch?.channel),
    threadId: str(branch?.thread_id) ?? null,
    isMentionOfRecipient: bool(branch?.is_mention_of_recipient),
    isEveryoneMention: bool(branch?.is_everyone_mention),
    key: str(branch?.key),
    targetEventId: str(branch?.target_event_id),
    loopId: str(branch?.loop_id),
    nonce: str(payload.nonce),
    raw: payload
  };
}
function isChatMessage(branchType) {
  return branchType === "direct_message" || branchType === "channel_message";
}
function isInvite(branchType) {
  return branchType === "add_to_channel" || branchType === "add_to_space";
}
function isVouch(branchType) {
  return branchType === "knock_invite_received";
}
export {
  decodeDirectPusher,
  isChatMessage,
  isInvite,
  isVouch
};
//# sourceMappingURL=inbound-core.js.map
