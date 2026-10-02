/**
 * The `poll_work` transport (opt-in; needs a server that supports `poll_work`). The server decides
 * what wakes the agent and where the reply goes (`reply_with`), and replying acknowledges the item.
 * An item made only of messages that would never wake the agent (src/wake-rules.ts) is acked
 * without a turn.
 */
import { acceptPending } from "../../accept-pending.js";
import type { ToolCallResult } from "../../mcp-client.js";
import { decideWakeBeforeAddressing } from "../../wake-rules.js";
import { isGatewayCommandItem } from "../../gateway.js";
import type { DispatchOutcome } from "../../work-item.js";
import type { TransportContext, TransportResult } from "../types.js";
import { type PollWorkItem, runPollLoop } from "./poll-work.js";

function publishSucceeded(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.event_id === "string" && d.event_id.length > 0 && d.error === undefined;
}

// The server rejects a second reply to an answered item with this error (HTTP 200, no `isError`),
// e.g. when a tool call replied before our `reply_with` publish. The item got its reply: success.
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

  const dispatchItem = async (item: PollWorkItem): Promise<DispatchOutcome> => {
    const replyWith = item.reply_with;
    if (!replyWith) {
      // The poll loop already filters these out.
      return { kind: "ambiguous" };
    }
    if (ctx.control) {
      await ctx.handleControl(item);
      return { kind: "silent" };
    }
    if (
      ctx.handleCommand &&
      isGatewayCommandItem(item, ctx.identity.principal, ctx.identity.ccRoomId)
    ) {
      await ctx.handleCommand(item);
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
