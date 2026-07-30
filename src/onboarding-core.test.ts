import assert from "node:assert/strict";
import { test } from "node:test";

import { parseToolResult, type ToolCallResult } from "./mcp-client.js";
import { classifyGetSelf, isFirstContact } from "./onboarding-core.js";

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

test("isFirstContact detects the first-contact directive", () => {
  assert.equal(isFirstContact("First contact: greet your principal"), true);
  assert.equal(isFirstContact("some other instructions"), false);
  assert.equal(isFirstContact(null), false);
  assert.equal(isFirstContact(undefined), false);
});
