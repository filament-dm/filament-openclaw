/**
 * A turn that failed is never answered where it came from: an "AI service" error posted in a group
 * reads as the agent speaking. The principal hears about it instead, in the backchannel. Both
 * transports use this.
 */
import { REPLIED_BACKCHANNEL, REPLIED_UNKNOWN_ROOM } from "./filament-tools.js";
import type { FilamentMcpClient } from "./mcp-client.js";
import type { TurnResult } from "./transports/types.js";
import type { DispatchTurnResult } from "./turn.js";
import type { WorkItem } from "./work-item.js";

// Enough to recognise the error; an SDK error string can carry a stack.
const MAX_REASON_CHARS = 300;

export function failureNote(
  item: Pick<WorkItem, "is_backchannel" | "channel_name">,
  result: Pick<DispatchTurnResult, "errorDetail" | "errorReplyText">,
): string {
  const raw = (result.errorReplyText ?? result.errorDetail ?? "").trim() || "no detail";
  const reason = raw.length > MAX_REASON_CHARS ? `${raw.slice(0, MAX_REASON_CHARS)}…` : raw;
  const where = item.is_backchannel
    ? "your last message"
    : item.channel_name
      ? `a message in ${item.channel_name}`
      : "a message in one of my channels";
  return `OpenClaw ended my turn on ${where} with an error, so I posted nothing there. OpenClaw said: ${reason}`;
}

/**
 * OpenClaw counts only the turn's final text as an answer, so a turn that must answer (a mention)
 * fails when the agent reacted or posted through a Filament tool and then ended in `NO_REPLY`. The
 * agent did answer: that failure is not one to report.
 */
export function answeredWithTools(
  item: Pick<WorkItem, "is_backchannel" | "channel_id">,
  result: Pick<TurnResult, "repliedTo" | "reacted">,
): boolean {
  if (result.reacted) return true;
  const { repliedTo } = result;
  if (repliedTo.has(REPLIED_UNKNOWN_ROOM) || repliedTo.has(item.channel_id)) return true;
  return item.is_backchannel === true && repliedTo.has(REPLIED_BACKCHANNEL);
}

/** Best effort: resolves true only when the note landed; never throws. */
export async function notifyPrincipalOfFailure(
  client: Pick<FilamentMcpClient, "callTool">,
  item: Pick<WorkItem, "is_backchannel" | "channel_name">,
  result: Pick<DispatchTurnResult, "errorDetail" | "errorReplyText">,
  opts: { signal?: AbortSignal; log: (message: string) => void },
): Promise<boolean> {
  try {
    const res = await client.callTool(
      "message_principal",
      { markdown_body: failureNote(item, result) },
      { signal: opts.signal },
    );
    if (!res.ok) opts.log(`filament: failure note not sent (${res.error?.message ?? "?"})`);
    return res.ok;
  } catch (error) {
    opts.log(`filament: failure note not sent: ${String(error)}`);
    return false;
  }
}
