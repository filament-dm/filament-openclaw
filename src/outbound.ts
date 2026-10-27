/**
 * The channel's outbound side: OpenClaw sending to Filament outside a turn this plugin dispatched.
 * The case that matters is restart recovery: a turn a gateway restart cut short is run again by
 * OpenClaw itself after the restart, and it delivers the answer through the channel the session
 * last used. Without this, that delivery fails ("Channel is unavailable: filament") and the owner
 * never sees the answer. `to` is the room the turn came from (`OriginatingTo`); a reply names the
 * message it answers (`in_reply_to`), which also finishes that message's poll_work item.
 */
import type { CallOptions, ToolCallResult } from "./mcp-client.js";
import type { OutboundAttachment } from "./media.js";

export interface OutboundClient {
  callTool(
    name: string,
    args?: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<ToolCallResult>;
}

export interface FilamentSend {
  /** The room: a Matrix room id. */
  to: string;
  text: string;
  /** The message this answers; only a Matrix event id (`$…`) is used. */
  replyToId?: string | null;
  /** A thread root; the reply goes in that thread. */
  threadId?: string | number | null;
  attachments?: OutboundAttachment[];
}

export interface FilamentSendResult {
  messageId: string;
  roomId: string;
}

const eventId = (value: unknown): string | undefined =>
  typeof value === "string" && value.startsWith("$") ? value : undefined;

function sentEventId(result: ToolCallResult): string | undefined {
  if (!result.ok || !result.data || typeof result.data !== "object") return undefined;
  const data = result.data as Record<string, unknown>;
  return typeof data.event_id === "string" && data.event_id && data.error === undefined
    ? data.event_id
    : undefined;
}

function failure(result: ToolCallResult): string {
  if (result.ok) {
    const err = (result.data as Record<string, unknown> | undefined)?.error;
    return typeof err === "string" ? err : "no event_id in the result";
  }
  return `${result.kind ?? "error"}: ${result.error?.message ?? "?"}`;
}

/** Posts one message to a Filament room. Throws when the server refuses it. */
export async function sendToFilament(
  client: OutboundClient,
  send: FilamentSend,
  opts?: CallOptions,
): Promise<FilamentSendResult> {
  const attachments = send.attachments?.length ? { attachments: send.attachments } : {};
  const thread = eventId(send.threadId);
  if (thread) {
    const result = await client.callTool(
      "reply_in_thread",
      { message_id: thread, markdown_body: send.text, ...attachments },
      opts,
    );
    const id = sentEventId(result);
    if (!id) throw new Error(`filament: reply_in_thread failed: ${failure(result)}`);
    return { messageId: id, roomId: send.to };
  }
  const base = { channel: send.to, markdown_body: send.text, ...attachments };
  const inReplyTo = eventId(send.replyToId);
  let result = await client.callTool(
    "post_message",
    inReplyTo ? { ...base, in_reply_to: inReplyTo } : base,
    opts,
  );
  // A server from before `in_reply_to` refuses the argument: send without it.
  if (inReplyTo && !sentEventId(result) && /in_reply_to/.test(failure(result))) {
    result = await client.callTool("post_message", base, opts);
  }
  const id = sentEventId(result);
  if (!id) throw new Error(`filament: post_message failed: ${failure(result)}`);
  return { messageId: id, roomId: send.to };
}

/** The account's client, waited for briefly: recovery can deliver before the account reconnects. */
export async function waitForClient<T>(
  get: () => T | null,
  opts: { timeoutMs?: number; everyMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const end = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    const client = get();
    if (client) return client;
    if (Date.now() >= end || opts.signal?.aborted) {
      throw new Error("filament: not connected, so the message could not be sent");
    }
    await new Promise((resolve) => setTimeout(resolve, opts.everyMs ?? 500));
  }
}
