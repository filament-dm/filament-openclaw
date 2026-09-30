import { decideWakeBeforeAddressing } from "../../wake-rules.js";
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
function decideWake(push, ctx) {
  if (!push.roomId) return { wake: false, reason: "no room" };
  const shared = decideWakeBeforeAddressing(
    {
      senderId: push.senderId,
      isBackchannel: !!ctx.ccRoomId && push.roomId === ctx.ccRoomId,
      isDirect: push.branchType === "direct_message",
      isMention: push.isMentionOfRecipient === true,
      text: push.text,
      senderIsAgent: push.senderIsAgent === true
    },
    ctx.selfMxid
  );
  if (shared) return shared;
  if (push.isReplyToRecipient === true) return { wake: true, reason: "reply to the agent" };
  if (ctx.engaged.isEngaged(push.roomId, push.threadId)) {
    return { wake: true, reason: "follow-up in an engaged thread" };
  }
  return { wake: false, reason: "not addressed to the agent" };
}
export {
  EngagedThreads,
  decideWake
};
//# sourceMappingURL=wake-policy.js.map
