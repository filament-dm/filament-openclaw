/**
 * Which pushes wake the agent. Pure — no OpenClaw, eneris or network.
 *
 * DirectPusher pushes the agent every message in its rooms; with poll_work
 * the server decides what counts as addressed, but over FCM the plugin has
 * to. This is the minimum of filament-hermes' wake policy (adapter.py,
 * `_handle_message`) that keeps an agent correct on today's Filament: the
 * rules both transports share (src/wake-rules.ts), and then, in a channel,
 * a reply to one of the agent's messages or a follow-up in a thread the
 * agent was already woken in — from a human only, since the shared rules
 * already turned another agent away without a mention. `@everyone` is not a
 * mention: one broadcast must not wake every agent at once.
 */
import { decideWakeBeforeAddressing, type WakeDecision } from "../../wake-rules.js";
import type { DecodedPush } from "./decode.js";

const MAX_ENGAGED_THREADS = 500;

/** Threads the agent was woken in, per room, bounded (oldest dropped first). */
export class EngagedThreads {
  private readonly keys = new Set<string>();

  private key(roomId: string, threadRoot: string): string {
    return `${roomId}\u0000${threadRoot}`;
  }

  /** Remember (or refresh) a thread; `threadRoot` is the thread's root event id. */
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
  /** The agent's own mxid. */
  selfMxid: string;
  /** The agent's backchannel room. */
  ccRoomId?: string;
  engaged: EngagedThreads;
}

/** Whether a chat push should wake the agent. The caller checks `isChatMessage` first. */
export function decideWake(push: DecodedPush, ctx: WakeContext): WakeDecision {
  if (!push.roomId) return { wake: false, reason: "no room" };
  const shared = decideWakeBeforeAddressing(
    {
      senderId: push.senderId,
      isBackchannel: !!ctx.ccRoomId && push.roomId === ctx.ccRoomId,
      isDirect: push.branchType === "direct_message",
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
