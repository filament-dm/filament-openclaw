/**
 * The `poll_work` transport (opt-in: `transport: "poll"`).
 *
 * Work arrives as items from a blocking `poll_work` call (./poll-work.ts);
 * the server has already decided what wakes the agent and where the reply
 * goes (`reply_with`), and its work ledger makes replying the acknowledgment.
 * Needs a synapse carrying ENG-1392.
 *
 * What the plugin still decides is the part both transports share
 * (src/wake-rules.ts): an item made only of messages that would never wake
 * the agent — its own, the system user's, another agent's without a mention
 * — is acknowledged without a turn. A failed turn, or a reply the server
 * refuses, is logged and acknowledged, as over FCM; a reply that may not
 * have landed is retried on the next offer (./poll-work.ts).
 */
import { acceptPending } from "../../accept-pending.js";
import type { ToolCallResult } from "../../mcp-client.js";
import { decideWakeBeforeAddressing } from "../../wake-rules.js";
import type { DispatchOutcome } from "../../work-item.js";
import type { TransportContext, TransportResult } from "../types.js";
import { type PollWorkItem, runPollLoop } from "./poll-work.js";

/** True when a publish result looks like a genuine success (has an event_id, no error). */
function publishSucceeded(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.event_id === "string" && d.event_id.length > 0 && d.error === undefined;
}

/**
 * The exact prefix of synapse's `_ALREADY_ANSWERED` message
 * (`tools_write.py`), returned as `{"error": "..."}` (HTTP 200, no
 * `isError`) when a reply targets a work-ledger item a tool call already
 * answered this turn (e.g. the model called `filament_post_message` itself
 * before the poll loop's own `reply_with` publish ran). This is a success
 * from the ledger's point of view — the item got exactly one reply — so it
 * must not be treated as a publish failure.
 */
const ALREADY_ANSWERED_PREFIX = "You have already answered this message";

function isAlreadyAnsweredError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const err = (data as Record<string, unknown>).error;
  return typeof err === "string" && err.startsWith(ALREADY_ANSWERED_PREFIX);
}

/** Why no message in the item would wake the agent, or null when one would. */
export function skipReason(item: PollWorkItem, selfMxid: string): string | null {
  const reasons = new Set<string>();
  for (const m of item.messages) {
    const decision = decideWakeBeforeAddressing(
      {
        senderId: m.sender,
        isBackchannel: item.is_backchannel,
        isDirect: item.is_direct === true,
        isMention: m.is_mention === true,
        text: m.body,
        senderIsAgent: m.sender_is_agent === true,
      },
      selfMxid,
    );
    if (!decision || decision.wake) return null;
    reasons.add(decision.reason);
  }
  return reasons.size ? [...reasons].join(", ") : null;
}

/** What a reply_with publish result means for the item. */
export function classifyPublish(res: ToolCallResult): DispatchOutcome {
  if (res.ok) {
    if (publishSucceeded(res.data)) return { kind: "published" };
    const err = (res.data as Record<string, unknown> | undefined)?.error;
    if (typeof err === "string") {
      return { kind: "dropped", diagnostic: `the server refused the reply: ${err}` };
    }
    return { kind: "retry", diagnostic: "publish returned no event_id" };
  }
  const message = res.error?.message ?? "?";
  if (res.kind === "auth") return { kind: "fatal", diagnostic: `auth: ${message}` };
  if (res.kind === "tool") {
    return { kind: "dropped", diagnostic: `the server refused the reply (${message})` };
  }
  return { kind: "retry", diagnostic: `publish failed (${res.kind ?? "?"}: ${message})` };
}

export async function runPollTransport(ctx: TransportContext): Promise<TransportResult> {
  const { client, abortSignal, log } = ctx;

  // Dispatch one work item: run the turn, publish at most once via
  // reply_with, and classify the outcome for the poll loop.
  const dispatchItem = async (item: PollWorkItem): Promise<DispatchOutcome> => {
    const replyWith = item.reply_with;
    if (!replyWith) {
      // Defense in depth: the poll loop already filters these out.
      return { kind: "ambiguous" };
    }
    if (ctx.control) {
      // The gateway never chats: every control item is acked.
      await ctx.handleControl(item);
      return { kind: "silent" };
    }

    const skip = skipReason(item, ctx.identity.mxid);
    if (skip) {
      log(`filament-poll: not waking for ${item.channel_id} (${skip}); acknowledging`);
      return { kind: "silent" };
    }

    let result;
    try {
      result = await ctx.runTurn(item);
    } catch (error) {
      return { kind: "dropped", diagnostic: `the turn threw: ${String(error)}` };
    }

    if (result.sawError) {
      return { kind: "dropped", diagnostic: `the turn failed: ${result.errorDetail ?? "?"}` };
    }
    if (result.sawFinal) {
      if (abortSignal.aborted) return { kind: "retry", diagnostic: "aborted before publish" };
      let publishRes;
      try {
        publishRes = await client.replyWith(replyWith, result.finalText, {
          signal: abortSignal,
        });
      } catch (error) {
        return { kind: "retry", diagnostic: `publish threw: ${String(error)}` };
      }
      if (publishRes.ok && isAlreadyAnsweredError(publishRes.data)) {
        // The model already answered this item with a tool call
        // (filament_post_message/filament_reply_in_thread/
        // filament_message_principal) during the turn; the ledger
        // rejected our own reply_with publish as a duplicate. The item
        // got its one reply, so this is success, not a publish failure.
        log("filament: item already answered by a tool call; skipping publish");
        return { kind: "published" };
      }
      const outcome = classifyPublish(publishRes);
      if (outcome.kind === "published") {
        log(`filament: reply published to ${item.channel_id} via ${replyWith.tool}`);
      }
      return outcome;
    }
    if (result.sawSkip) {
      return { kind: "silent" };
    }
    log(
      `filament: turn produced no text and no explicit skip signal for ${item.channel_id}; leaving unacknowledged`,
    );
    return { kind: "ambiguous" };
  };

  return runPollLoop({
    client,
    abortSignal,
    log,
    dispatchItem,
    waitSeconds: ctx.settings.pollWaitSeconds,
    sweepPending: ctx.control ? undefined : () => acceptPending(client, log, abortSignal),
  });
}
