import { REPLIED_BACKCHANNEL, REPLIED_UNKNOWN_ROOM } from "../../filament-tools.js";
function routeReply(push) {
  if (push.isBackchannel) return { tool: "message_principal", args: {} };
  if (push.isDirect && !push.threadId) {
    return { tool: "post_message", args: { channel: push.roomId } };
  }
  return { tool: "reply_in_thread", args: { message_id: push.threadId ?? push.eventId } };
}
function alreadyAnswered(push, repliedTo) {
  if (repliedTo.has(REPLIED_UNKNOWN_ROOM) || repliedTo.has(push.roomId)) return true;
  return push.isBackchannel && repliedTo.has(REPLIED_BACKCHANNEL);
}
export {
  alreadyAnswered,
  routeReply
};
//# sourceMappingURL=reply-route.js.map
