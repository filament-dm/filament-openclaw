import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCallResult } from "./mcp-client.js";
import { sendToFilament, waitForClient } from "./outbound.js";

const ok = (data: unknown): ToolCallResult => ({ ok: true, httpStatus: 200, data });
const ROOM = "!room:example.test";

function fakeClient(results: ToolCallResult[]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      callTool: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        return results.shift() ?? ok({ event_id: "$sent" });
      },
    },
  };
}

test("outbound: a restart-recovered answer posts to its room, naming the message it answers", async () => {
  const { client, calls } = fakeClient([ok({ event_id: "$sent" })]);
  const sent = await sendToFilament(client, { to: ROOM, text: "13 × 3 = 39", replyToId: "$asked" });
  assert.deepEqual(sent, { messageId: "$sent", roomId: ROOM });
  assert.deepEqual(calls, [
    {
      name: "post_message",
      args: { channel: ROOM, markdown_body: "13 × 3 = 39", in_reply_to: "$asked" },
    },
  ]);
});

test("outbound: only a Matrix event id is passed as in_reply_to", async () => {
  const { client, calls } = fakeClient([]);
  await sendToFilament(client, { to: ROOM, text: "hi", replyToId: "first-hello:x" });
  assert.deepEqual(calls[0]!.args, { channel: ROOM, markdown_body: "hi" });
});

test("outbound: a server that doesn't know in_reply_to gets the message without it", async () => {
  const { client, calls } = fakeClient([
    ok({ error: "in_reply_to: Extra inputs are not permitted" }),
    ok({ event_id: "$sent" }),
  ]);
  const sent = await sendToFilament(client, { to: ROOM, text: "hi", replyToId: "$asked" });
  assert.equal(sent.messageId, "$sent");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.args, { channel: ROOM, markdown_body: "hi" });
});

test("outbound: a thread's answer goes in the thread", async () => {
  const { client, calls } = fakeClient([]);
  await sendToFilament(client, { to: ROOM, text: "hi", threadId: "$root", replyToId: "$asked" });
  assert.deepEqual(calls[0], {
    name: "reply_in_thread",
    args: { message_id: "$root", markdown_body: "hi" },
  });
});

test("outbound: attachments ride along", async () => {
  const { client, calls } = fakeClient([]);
  await sendToFilament(client, {
    to: ROOM,
    text: "",
    attachments: [{ mxc_url: "mxc://example.test/a", filename: "a.png" }],
  });
  assert.deepEqual(calls[0]!.args.attachments, [
    { mxc_url: "mxc://example.test/a", filename: "a.png" },
  ]);
});

test("outbound: a refusal throws, so OpenClaw records the delivery as failed", async () => {
  const { client } = fakeClient([ok({ error: "This agent is paused by its principal" })]);
  await assert.rejects(
    sendToFilament(client, { to: ROOM, text: "hi" }),
    /post_message failed: This agent is paused/,
  );
});

test("outbound: waits for the account's client, then gives up", async () => {
  let client: string | null = null;
  setTimeout(() => {
    client = "connected";
  }, 20);
  assert.equal(await waitForClient(() => client, { timeoutMs: 1000, everyMs: 5 }), "connected");
  await assert.rejects(
    waitForClient(() => null, { timeoutMs: 20, everyMs: 5 }),
    /not connected/,
  );
});
