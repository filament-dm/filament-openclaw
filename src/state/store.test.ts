import assert from "node:assert/strict";
import { test } from "node:test";

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

test("update requests: the marker survives until the account that left it reads it", () => {
  markUpdateRequested("writer", "0.1.0");
  assert.deepEqual(takeUpdateRequest("writer"), { fromVersion: "0.1.0" });
  assert.equal(takeUpdateRequest("writer"), undefined);
});

test("poll cursors: kept per account, and only for the agent that sent them", async () => {
  const { loadPollCursor, savePollCursor } = await import("./poll-cursors.js");
  savePollCursor("main", "@a:server", "c:5");
  assert.equal(loadPollCursor("main", "@a:server"), "c:5");
  // After a sign-in as another agent, the old agent's position means nothing.
  assert.equal(loadPollCursor("main", "@b:server"), undefined);
  assert.equal(loadPollCursor("other", "@a:server"), undefined);
});

test("in-flight: a restart's markers are found by room until recovery clears them; the live run's are not", async () => {
  const { markInFlight, interruptedIn, clearInterruptedIn, setLiveRun, loadInFlight } =
    await import("./in-flight.js");
  markInFlight("acct", "@a:s", {
    eventId: "$old",
    room: "!r:s",
    startedAt: Date.now(),
    run: "before",
  });
  setLiveRun("acct", "now");
  markInFlight("acct", "@a:s", {
    eventId: "$new",
    room: "!r:s",
    startedAt: Date.now(),
    run: "now",
  });
  assert.deepEqual(
    interruptedIn("acct", "!r:s").map((t) => t.eventId),
    ["$old"],
  );
  assert.deepEqual(interruptedIn("acct", "!other:s"), []);
  clearInterruptedIn("acct", "!r:s");
  assert.deepEqual(interruptedIn("acct", "!r:s"), []);
  assert.deepEqual(
    loadInFlight("acct", "@a:s").map((t) => t.eventId),
    ["$new"],
  );
});
