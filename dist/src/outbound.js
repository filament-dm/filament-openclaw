const eventId = (value) => typeof value === "string" && value.startsWith("$") ? value : void 0;
function sentEventId(result) {
  if (!result.ok || !result.data || typeof result.data !== "object") return void 0;
  const data = result.data;
  return typeof data.event_id === "string" && data.event_id && data.error === void 0 ? data.event_id : void 0;
}
function failure(result) {
  if (result.ok) {
    const err = result.data?.error;
    return typeof err === "string" ? err : "no event_id in the result";
  }
  return `${result.kind ?? "error"}: ${result.error?.message ?? "?"}`;
}
async function sendToFilament(client, send, opts) {
  const attachments = send.attachments?.length ? { attachments: send.attachments } : {};
  const thread = eventId(send.threadId);
  if (thread) {
    const result2 = await client.callTool(
      "reply_in_thread",
      { message_id: thread, markdown_body: send.text, ...attachments },
      opts
    );
    const id2 = sentEventId(result2);
    if (!id2) throw new Error(`filament: reply_in_thread failed: ${failure(result2)}`);
    return { messageId: id2, roomId: send.to };
  }
  const base = { channel: send.to, markdown_body: send.text, ...attachments };
  const inReplyTo = eventId(send.replyToId);
  let result = await client.callTool(
    "post_message",
    inReplyTo ? { ...base, in_reply_to: inReplyTo } : base,
    opts
  );
  if (inReplyTo && !sentEventId(result) && /in_reply_to/.test(failure(result))) {
    result = await client.callTool("post_message", base, opts);
  }
  const id = sentEventId(result);
  if (!id) throw new Error(`filament: post_message failed: ${failure(result)}`);
  return { messageId: id, roomId: send.to };
}
async function waitForClient(get, opts = {}) {
  const end = Date.now() + (opts.timeoutMs ?? 3e4);
  for (; ; ) {
    const client = get();
    if (client) return client;
    if (Date.now() >= end || opts.signal?.aborted) {
      throw new Error("filament: not connected, so the message could not be sent");
    }
    await new Promise((resolve) => setTimeout(resolve, opts.everyMs ?? 500));
  }
}
export {
  sendToFilament,
  waitForClient
};
