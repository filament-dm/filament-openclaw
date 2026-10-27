import assert from "node:assert/strict";
import { test } from "node:test";

import { failureNote, notifyPrincipalOfFailure } from "./failure-note.js";

const EMPTY = "⚠️ The AI service returned an empty reply. Please try again.";

test("failureNote: names the room when the item says it, and quotes what OpenClaw said", () => {
  assert.equal(
    failureNote(
      { is_backchannel: false, channel_name: "Design review" },
      { errorReplyText: EMPTY },
    ),
    `I couldn't answer a message in Design review, so I posted nothing there. OpenClaw said: ${EMPTY}`,
  );
  assert.match(
    failureNote({ is_backchannel: false }, { errorDetail: "final: boom" }),
    /^I couldn't answer a message in one of my channels, .* OpenClaw said: final: boom$/,
  );
  assert.match(failureNote({ is_backchannel: true }, {}), /your last message.*no detail$/);
});

test("failureNote: keeps a long error short", () => {
  const note = failureNote({ is_backchannel: false }, { errorDetail: "x".repeat(1000) });
  assert.ok(note.endsWith("…"));
  assert.ok(note.length < 450);
});

test("notifyPrincipalOfFailure: sends it with message_principal; a failure to send never throws", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      return { ok: true, httpStatus: 200, data: { event_id: "$n" } };
    },
  };
  const sent = await notifyPrincipalOfFailure(
    client as never,
    { is_backchannel: false, channel_name: "Ops" },
    { errorReplyText: EMPTY },
    { log: () => {} },
  );
  assert.equal(sent, true);
  assert.equal(calls[0]!.name, "message_principal");
  assert.match(String(calls[0]!.args.markdown_body), /a message in Ops/);

  const broken = {
    callTool: async () => {
      throw new TypeError("fetch failed");
    },
  };
  const logs: string[] = [];
  assert.equal(
    await notifyPrincipalOfFailure(
      broken as never,
      { is_backchannel: false },
      {},
      {
        log: (m) => logs.push(m),
      },
    ),
    false,
  );
  assert.match(logs[0]!, /failure note not sent/);
});
