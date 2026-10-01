/**
 * Which FCM pushes wake the agent. The server pushes every message in the agent's rooms, so the
 * plugin decides what is addressed: the rules shared with poll (src/wake-rules.ts), then, in a
 * channel, a reply to the agent or a follow-up in a thread it was already woken in.
 */
import { decideWakeBeforeAddressing, type WakeDecision } from "../../wake-rules.js";
import type { DecodedPush } from "./decode.js";

const MAX_ENGAGED_THREADS = 500;

export class EngagedThreads {
  private readonly keys = new Set<string>();

  private key(roomId: string, threadRoot: string): string {
    return `${roomId}\u0000${threadRoot}`;
  }

  record(roomId: string, threadRoot: string): void {
    const key = this.key(roomId, threadRoot);
    this.keys.delete(key);
    this.keys.add(key);
    if (this.keys.size > MAX_ENGAGED_THREADS) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
  }

  isEngaged(roomId: string, threadId: string | null | undefined): boolean {
    return !!threadId && this.keys.has(this.key(roomId, threadId));
  }
}

export interface WakeContext {
  selfMxid: string;
  ccRoomId?: string;
  engaged: EngagedThreads;
}

/** The caller checks `isChatMessage` first. */
export function decideWake(push: DecodedPush, ctx: WakeContext): WakeDecision {
  if (!push.roomId) return { wake: false, reason: "no room" };
  const shared = decideWakeBeforeAddressing(
    {
      senderId: push.senderId,
      isBackchannel: !!ctx.ccRoomId && push.roomId === ctx.ccRoomId,
      isDirect: push.branchType === "direct_message",
      // Not `isEveryoneMention`: one broadcast must not wake every agent at once.
      isMention: push.isMentionOfRecipient === true,
      text: push.text,
      senderIsAgent: push.senderIsAgent === true,
    },
    ctx.selfMxid,
  );
  if (shared) return shared;
  if (push.isReplyToRecipient === true) return { wake: true, reason: "reply to the agent" };
  if (ctx.engaged.isEngaged(push.roomId, push.threadId)) {
    return { wake: true, reason: "follow-up in an engaged thread" };
  }
  return { wake: false, reason: "not addressed to the agent" };
}
