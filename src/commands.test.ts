import assert from "node:assert/strict";
import { test } from "node:test";

import { isBackchannelCommandItem, otherCommandBody, parseBackchannelCommand } from "./commands.js";
import type { WorkItem } from "./work-item.js";

const PRINCIPAL = "@owner:x";
const CC = "!cc:x";

function item(body: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    channel_id: CC,
    thread_id: null,
    is_backchannel: true,
    messages: [{ event_id: "$e1", sender: PRINCIPAL, body, ts: 1 }],
    ...overrides,
  };
}

test("parseBackchannelCommand: update by verb or by the notice's button; anything else /filament", () => {
  assert.deepEqual(parseBackchannelCommand(" /filament update "), { kind: "update" });
  assert.deepEqual(parseBackchannelCommand("update now"), { kind: "update" });
  assert.deepEqual(parseBackchannelCommand("/filament connect fmcp_x"), {
    kind: "other",
    verb: "connect",
  });
  assert.deepEqual(parseBackchannelCommand("/filament update please"), {
    kind: "other",
    verb: "update",
  });
  assert.equal(parseBackchannelCommand("hello there"), null);
  assert.equal(parseBackchannelCommand("/filamentish"), null);
});

test("isBackchannelCommandItem: only the principal's last line, in this backchannel", () => {
  assert.equal(isBackchannelCommandItem(item("/filament update"), PRINCIPAL, CC), true);
  assert.equal(isBackchannelCommandItem(item("/filament connect fmcp_x"), PRINCIPAL, CC), true);
  assert.equal(isBackchannelCommandItem(item("hi"), PRINCIPAL, CC), false);
  assert.equal(isBackchannelCommandItem(item("/filament update"), "@other:x", CC), false);
  assert.equal(
    isBackchannelCommandItem(item("/filament update", { channel_id: "!room:x" }), PRINCIPAL, CC),
    false,
  );
  assert.equal(
    isBackchannelCommandItem(item("/filament update", { is_backchannel: false }), PRINCIPAL, CC),
    false,
  );
  assert.equal(isBackchannelCommandItem(item("/filament update"), undefined, CC), false);
});

test("otherCommandBody: the retired verbs point at the login; the rest at update", () => {
  for (const verb of ["connect", "disconnect", "unpair", "agents"]) {
    assert.match(otherCommandBody(verb), /is gone\..*openclaw filament login/);
  }
  assert.equal(otherCommandBody("frobnicate"), "The only command here is `/filament update`.");
});
