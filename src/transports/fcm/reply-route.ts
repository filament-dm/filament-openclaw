/**
 * Where an FCM-woken turn's reply goes. Pure.
 *
 * poll_work pre-resolves this server-side (`reply_with`); over FCM the plugin
 * decides, following Filament's participation rules (synapse
 * `agents_mcp/participation.py`): outside group chats the default mode only
 * allows `reply_in_thread`, in a thread where the agent was mentioned — so a
 * channel reply threads off the message that woke the agent, and a top-level
 * post is reserved for the rooms where it is always allowed.
 *
 *   - backchannel        → message_principal (the control plane; top level)
 *   - direct message     → post_message, or reply_in_thread inside a thread
 *   - channel            → reply_in_thread, rooted at the thread or the message
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

/**
 * Whether a write tool already answered this conversation during the turn
 * (src/filament-tools.ts records where). With no work ledger to reject a
 * second reply, this is what keeps an FCM turn to one.
 */
export function alreadyAnswered(push: RoutablePush, repliedTo: ReadonlySet<string>): boolean {
  if (repliedTo.has(REPLIED_UNKNOWN_ROOM) || repliedTo.has(push.roomId)) return true;
  return push.isBackchannel && repliedTo.has(REPLIED_BACKCHANNEL);
}
