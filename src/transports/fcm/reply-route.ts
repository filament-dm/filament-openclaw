/**
 * Where an FCM-woken turn replies (over poll_work the server resolves this as `reply_with`). In a
 * channel, Filament's default participation mode only allows `reply_in_thread` in a thread where
 * the agent was mentioned, so a channel reply threads off the message that woke the agent.
 */
import { REPLIED_BACKCHANNEL, REPLIED_UNKNOWN_ROOM } from "../../filament-tools.js";

export interface ReplyRoute {
  tool: "message_principal" | "post_message" | "reply_in_thread";
  args: Record<string, string>;
}

export interface RoutablePush {
  roomId: string;
  eventId: string;
  threadId: string | null;
  isBackchannel: boolean;
  isDirect: boolean;
}

export function routeReply(push: RoutablePush): ReplyRoute {
  if (push.isBackchannel) return { tool: "message_principal", args: {} };
  if (push.isDirect && !push.threadId) {
    return { tool: "post_message", args: { channel: push.roomId } };
  }
  return { tool: "reply_in_thread", args: { message_id: push.threadId ?? push.eventId } };
}

/** Nothing server-side rejects a second FCM reply, so this keeps a turn to one. */
export function alreadyAnswered(push: RoutablePush, repliedTo: ReadonlySet<string>): boolean {
  if (repliedTo.has(REPLIED_UNKNOWN_ROOM) || repliedTo.has(push.roomId)) return true;
  return push.isBackchannel && repliedTo.has(REPLIED_BACKCHANNEL);
}
