import assert from "node:assert/strict";
import { test } from "node:test";

import { answeredWithTools, failureNote, notifyPrincipalOfFailure } from "./failure-note.js";

const EMPTY = "⚠️ The AI service returned an empty reply. Please try again.";

test("failureNote: names the room when the item says it, and quotes what OpenClaw said", () => {
  assert.equal(
    failureNote(
      { is_backchannel: false, channel_name: "Design review" },
      { errorReplyText: EMPTY },
    ),
    `OpenClaw ended my turn on a message in Design review with an error, so I posted nothing there. OpenClaw said: ${EMPTY}`,
  );
  assert.match(
    failureNote({ is_backchannel: false }, { errorDetail: "final: boom" }),
    /^OpenClaw ended my turn on a message in one of my channels with an error, .* OpenClaw said: final: boom$/,
  );
  assert.match(failureNote({ is_backchannel: true }, {}), /your last message.*no detail$/);
});

test("answeredWithTools: a reaction, or a tool reply in the item's room or the backchannel", () => {
  const group = { is_backchannel: false, channel_id: "!g:x" };
  const none = new Set<string>();
  assert.equal(answeredWithTools(group, { repliedTo: none, reacted: false }), false);
  assert.equal(answeredWithTools(group, { repliedTo: none, reacted: true }), true);
  assert.equal(answeredWithTools(group, { repliedTo: new Set(["!g:x"]), reacted: false }), true);
  assert.equal(answeredWithTools(group, { repliedTo: new Set(["*"]), reacted: false }), true);
  assert.equal(
    answeredWithTools(group, { repliedTo: new Set(["!other:x"]), reacted: false }),
    false,
  );
  // Telling the principal about a group message is not answering the group.
  assert.equal(
    answeredWithTools(group, { repliedTo: new Set(["backchannel"]), reacted: false }),
    false,
  );
  assert.equal(
    answeredWithTools(
      { is_backchannel: true, channel_id: "!cc:x" },
      { repliedTo: new Set(["backchannel"]), reacted: false },
    ),
    true,
  );
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
