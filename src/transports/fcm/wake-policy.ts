/**
 * Which pushes wake the agent. Pure — no OpenClaw, eneris or network.
 *
 * DirectPusher pushes the agent every message in its rooms; with poll_work
 * the server decides what counts as addressed, but over FCM the plugin has
 * to. This is the minimum of filament-hermes' wake policy (adapter.py,
 * `_handle_message`) that keeps an agent correct on today's Filament:
 *
 *   - never: its own messages, and the system notices `@filament_god` sends
 *     (matched on the agent's own homeserver only, so an impersonator from
 *     another server is not treated as system);
 *   - always: the backchannel and direct messages;
 *   - in a channel: an @-mention (the server's flag, or the mxid in the text),
 *     a reply to one of the agent's messages, or a follow-up in a thread the
 *     agent was already woken in — the last two only from a human, so agents
 *     never wake each other without an explicit @-mention. `@everyone` is not
 *     a mention: one broadcast must not wake every agent at once.
 */
import type { DecodedPush } from "./decode.js";

export type WakeDecision = { wake: boolean; reason: string };

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

function serverOf(mxid: string): string {
  const colon = mxid.indexOf(":");
  return colon === -1 ? "" : mxid.slice(colon + 1);
}

/** The system user's notices (e.g. "you were added to…") never wake an agent. */
export function isSystemSender(senderId: string | undefined, selfMxid: string): boolean {
  const server = serverOf(selfMxid);
  return !!server && senderId === `@filament_god:${server}`;
}

/** Whether a chat push should wake the agent. The caller checks `isChatMessage` first. */
export function decideWake(push: DecodedPush, ctx: WakeContext): WakeDecision {
  if (!push.roomId) return { wake: false, reason: "no room" };
  if (push.senderId && push.senderId === ctx.selfMxid) {
    return { wake: false, reason: "own message" };
  }
  if (isSystemSender(push.senderId, ctx.selfMxid)) {
    return { wake: false, reason: "system notice" };
  }
  if (ctx.ccRoomId && push.roomId === ctx.ccRoomId) return { wake: true, reason: "backchannel" };
  if (push.branchType === "direct_message") return { wake: true, reason: "direct message" };

  const mentioned =
    push.isMentionOfRecipient === true ||
    (!!ctx.selfMxid && typeof push.text === "string" && push.text.includes(ctx.selfMxid));
  if (mentioned) return { wake: true, reason: "mention" };
  if (push.senderIsAgent === true) return { wake: false, reason: "agent sender, no mention" };
  if (push.isReplyToRecipient === true) return { wake: true, reason: "reply to the agent" };
  if (ctx.engaged.isEngaged(push.roomId, push.threadId)) {
    return { wake: true, reason: "follow-up in an engaged thread" };
  }
  return { wake: false, reason: "not addressed to the agent" };
}
