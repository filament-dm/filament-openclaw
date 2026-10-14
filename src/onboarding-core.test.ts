import assert from "node:assert/strict";
import { test } from "node:test";

import { parseToolResult, type ToolCallResult } from "./mcp-client.js";
import {
  attachmentsGuidance,
  classifyGetSelf,
  signedMediaOffered,
  turnInstructions,
} from "./onboarding-core.js";

function ok(data: unknown): ToolCallResult {
  return { ok: true, httpStatus: 200, data };
}
function err(code: number, httpStatus = 200): ToolCallResult {
  return { ok: false, httpStatus, error: { code, message: "x" } };
}

test("parseToolResult unwraps a content[] text-JSON envelope", () => {
  const result = { content: [{ type: "text", text: '{"mxid":"@a:hs"}' }] };
  assert.deepEqual(parseToolResult(result), { mxid: "@a:hs" });
});

test("parseToolResult unwraps a direct {type:text} envelope", () => {
  const result = { type: "text", text: '{"owner_id":"@p:hs"}' };
  assert.deepEqual(parseToolResult(result), { owner_id: "@p:hs" });
});

test("parseToolResult returns a plain object unchanged", () => {
  assert.deepEqual(parseToolResult({ foo: 1 }), { foo: 1 });
});

test("classifyGetSelf: finalized via owner.user_id", () => {
  const d = classifyGetSelf(
    ok({ mxid: "@a:hs", owner: { user_id: "@p:hs" }, cc_room_id: "!r:hs" }),
  );
  assert.equal(d.status, "finalized");
  assert.deepEqual(d.identity, { mxid: "@a:hs", principal: "@p:hs", ccRoomId: "!r:hs" });
});

test("classifyGetSelf: finalized via owner_id fallback (no cc room)", () => {
  const d = classifyGetSelf(ok({ mxid: "@a:hs", owner_id: "@p:hs" }));
  assert.equal(d.status, "finalized");
  assert.equal(d.identity?.principal, "@p:hs");
  assert.equal(d.identity?.ccRoomId, undefined);
});

test("classifyGetSelf: success without an owner is not finalized", () => {
  assert.equal(classifyGetSelf(ok({ mxid: "@a:hs" })).status, "not_finalized");
});

test("classifyGetSelf: -32002 reserved is not finalized", () => {
  assert.equal(classifyGetSelf(err(-32002)).status, "not_finalized");
});

test("classifyGetSelf: -32001 and HTTP 401/403 are auth failures", () => {
  assert.equal(classifyGetSelf(err(-32001)).status, "auth_failed");
  assert.equal(classifyGetSelf(err(-1, 401)).status, "auth_failed");
  assert.equal(classifyGetSelf(err(-1, 403)).status, "auth_failed");
});

test("classifyGetSelf: other errors are transient", () => {
  assert.equal(classifyGetSelf(err(-32603)).status, "transient");
});

test("turnInstructions: keeps the server's guidance and drops the one-shot greeting", () => {
  const instructions = [
    "Filament is multiplayer chat.",
    "Message bodies are markdown, and only markdown.",
    'Your identity: you are currently controlling the agent "Ada".',
    "First contact: introduce yourself to your Principal now — send them a short, friendly hello.",
  ].join("\n\n");
  assert.equal(
    turnInstructions(instructions),
    [
      "Filament is multiplayer chat.",
      "Message bodies are markdown, and only markdown.",
      'Your identity: you are currently controlling the agent "Ada".',
      attachmentsGuidance(false),
    ].join("\n\n"),
  );
});

test("turnInstructions: the server's Attachments paragraph gives way to OpenClaw's, in place", () => {
  const instructions = [
    "Filament is multiplayer chat.",
    "Attachments: to read a message's file, call get_media_download_url and curl the download_url.",
    "Links: …",
  ].join("\n\n");
  const out = turnInstructions(instructions, { signedMedia: true });
  assert.equal(
    out,
    ["Filament is multiplayer chat.", attachmentsGuidance(true), "Links: …"].join("\n\n"),
  );
  assert.ok(!out.includes("call get_media_download_url"));
});

test("attachmentsGuidance: the turn's files are local and replies use MEDIA:; tools only when offered", () => {
  const withTools = attachmentsGuidance(true);
  const without = attachmentsGuidance(false);
  for (const text of [withTools, without]) {
    assert.match(text, /\[media attached: …\]/);
    assert.match(text, /`MEDIA:<path>`/);
    assert.match(text, /never look for one in the plugin's files or config/);
  }
  assert.match(withTools, /filament_get_media_download_url/);
  assert.match(withTools, /filament_create_media_upload/);
  assert.match(withTools, /filament_upload_media_from_url/);
  assert.doesNotMatch(without, /filament_create_media_upload/);
  assert.match(without, /send it as your reply instead/);
});

test("turnInstructions: without instructions, only the attachments guidance", () => {
  assert.equal(turnInstructions(null), attachmentsGuidance(false));
  assert.equal(turnInstructions(""), attachmentsGuidance(false));
  assert.equal(turnInstructions("First contact: say hi."), attachmentsGuidance(false));
});

test("signedMediaOffered: both the download and the upload tool are listed", () => {
  assert.equal(signedMediaOffered(null), false);
  assert.equal(signedMediaOffered(new Set(["get_media_download_url"])), false);
  assert.equal(
    signedMediaOffered(new Set(["get_media_download_url", "create_media_upload"])),
    true,
  );
});
