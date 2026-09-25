const MAX_ENGAGED_THREADS = 500;
class EngagedThreads {
  keys = /* @__PURE__ */ new Set();
  key(roomId, threadRoot) {
    return `${roomId}\0${threadRoot}`;
  }
  /** Remember (or refresh) a thread; `threadRoot` is the thread's root event id. */
  record(roomId, threadRoot) {
    const key = this.key(roomId, threadRoot);
    this.keys.delete(key);
    this.keys.add(key);
    if (this.keys.size > MAX_ENGAGED_THREADS) {
      const oldest = this.keys.values().next().value;
      if (oldest !== void 0) this.keys.delete(oldest);
    }
  }
  isEngaged(roomId, threadId) {
    return !!threadId && this.keys.has(this.key(roomId, threadId));
  }
}
function serverOf(mxid) {
  const colon = mxid.indexOf(":");
  return colon === -1 ? "" : mxid.slice(colon + 1);
}
function isSystemSender(senderId, selfMxid) {
  const server = serverOf(selfMxid);
  return !!server && senderId === `@filament_god:${server}`;
}
function decideWake(push, ctx) {
  if (!push.roomId) return { wake: false, reason: "no room" };
  if (push.senderId && push.senderId === ctx.selfMxid) {
    return { wake: false, reason: "own message" };
  }
  if (isSystemSender(push.senderId, ctx.selfMxid)) {
    return { wake: false, reason: "system notice" };
  }
  if (ctx.ccRoomId && push.roomId === ctx.ccRoomId) return { wake: true, reason: "backchannel" };
  if (push.branchType === "direct_message") return { wake: true, reason: "direct message" };
  const mentioned = push.isMentionOfRecipient === true || !!ctx.selfMxid && typeof push.text === "string" && push.text.includes(ctx.selfMxid);
  if (mentioned) return { wake: true, reason: "mention" };
  if (push.senderIsAgent === true) return { wake: false, reason: "agent sender, no mention" };
  if (push.isReplyToRecipient === true) return { wake: true, reason: "reply to the agent" };
  if (ctx.engaged.isEngaged(push.roomId, push.threadId)) {
    return { wake: true, reason: "follow-up in an engaged thread" };
  }
  return { wake: false, reason: "not addressed to the agent" };
}
export {
  EngagedThreads,
  decideWake,
  isSystemSender
};
//# sourceMappingURL=wake-policy.js.map
