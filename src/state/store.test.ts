import assert from "node:assert/strict";
import { test } from "node:test";

import { dropGreeting, leaveGreeting, takeGreeting } from "./pending.js";
import { openTable, useMemoryState } from "./store.js";
import { markUpdateRequested, takeUpdateRequest } from "./updates.js";

useMemoryState();

test("a table reads back what it stored, take reads once, delete forgets", () => {
  const table = openTable<{ n: number }>("test-table");
  assert.equal(table.get("a"), undefined);
  table.set("a", { n: 1 });
  assert.deepEqual(table.get("a"), { n: 1 });
  assert.deepEqual(table.take("a"), { n: 1 });
  assert.equal(table.get("a"), undefined);
  table.set("b", { n: 2 });
  table.delete("b");
  assert.equal(table.get("b"), undefined);
});

test("greetings: read once, and a losing bind clears only its own", () => {
  leaveGreeting("writer", "pending-a", "Done — Writer answers here.");
  dropGreeting("writer", "pending-b");
  assert.equal(takeGreeting("writer"), "Done — Writer answers here.");
  assert.equal(takeGreeting("writer"), undefined);
  leaveGreeting("writer", "pending-a", "again");
  dropGreeting("writer", "pending-a");
  assert.equal(takeGreeting("writer"), undefined);
});

test("update requests: the marker survives until the account that left it reads it", () => {
  markUpdateRequested("writer", "0.1.0");
  assert.deepEqual(takeUpdateRequest("writer"), { fromVersion: "0.1.0" });
  assert.equal(takeUpdateRequest("writer"), undefined);
});
