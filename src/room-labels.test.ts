import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCallResult } from "./mcp-client.js";
import { createRoomLabels, roomLabelFrom, roomLabelFromFacts } from "./room-labels.js";

const IDENTITY = { mxid: "@carl:x", principal: "@owner:x", ccRoomId: "!cc:x" };

const member = (mxid: string, display_name?: string) => ({ mxid, display_name, is_agent: false });

test("roomLabelFrom: the backchannel is named for the owner, never its room id", () => {
  const details = {
    name: "Carl",
    members: [member("@owner:x", "Test One"), member("@carl:x", "Carl")],
  };
  assert.deepEqual(roomLabelFrom(details, "!cc:x", IDENTITY), { label: "Filament · Test One" });
  // No display name: the owner's id.
  assert.deepEqual(roomLabelFrom({ members: [] }, "!cc:x", IDENTITY), {
    label: "Filament · @owner:x",
  });
});

test("roomLabelFrom: a named channel by its name; a DM or unnamed room by its people", () => {
  assert.deepEqual(roomLabelFrom({ name: " Design review ", members: [] }, "!room:x", IDENTITY), {
    label: "Filament · Design review",
    subject: "Design review",
  });
  assert.deepEqual(
    roomLabelFrom(
      { name: "", members: [member("@carl:x", "Carl"), member("@alice:x", "Alice")] },
      "!dm:x",
      IDENTITY,
    ),
    { label: "Filament · Alice", subject: "Alice" },
  );
  const crowd = ["a", "b", "c", "d", "e"].map((n) => member(`@${n}:x`, n.toUpperCase()));
  assert.deepEqual(roomLabelFrom({ members: crowd }, "!g:x", IDENTITY), {
    label: "Filament · A, B, C +2",
    subject: "A, B, C +2",
  });
  // A member without a display name shows as their id; nothing at all, the room id.
  assert.deepEqual(roomLabelFrom({ members: [member("@bob:x")] }, "!dm:x", IDENTITY), {
    label: "Filament · @bob:x",
    subject: "@bob:x",
  });
  assert.deepEqual(roomLabelFrom({}, "!lonely:x", IDENTITY), { label: "Filament · !lonely:x" });
});

test("createRoomLabels: one get_channel_details per room; a failure falls back and is retried", async () => {
  const calls: unknown[] = [];
  let fail = true;
  const client = {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (args.channel_id === "!flaky:x" && fail) {
        fail = false;
        return { ok: false, error: { code: -1, message: "timed out" } } as ToolCallResult;
      }
      return { ok: true, data: { name: "General", members: [] } } as ToolCallResult;
    },
  };
  const labelOf = createRoomLabels(client, IDENTITY);
  assert.deepEqual(await labelOf("!room:x"), { label: "Filament · General", subject: "General" });
  await labelOf("!room:x");
  assert.deepEqual(calls, [{ name: "get_channel_details", args: { channel_id: "!room:x" } }]);

  assert.deepEqual(await labelOf("!flaky:x"), { label: "Filament · !flaky:x" });
  assert.deepEqual(await labelOf("!flaky:x"), { label: "Filament · General", subject: "General" });

  const down = createRoomLabels(
    {
      callTool: async () => {
        throw new TypeError("fetch failed");
      },
    },
    IDENTITY,
  );
  assert.deepEqual(await down("!cc:x"), { label: "Filament · @owner:x" });
});

test("roomLabelFromFacts: an item's own room facts name the room; without them, null", () => {
  const names = { "@owner:x": "Test One", "@alice:x": "Alice", "@carl:x": "Carl" };
  assert.deepEqual(roomLabelFromFacts({ sender_names: names }, "!cc:x", ["@owner:x"], IDENTITY), {
    label: "Filament · Test One",
  });
  assert.deepEqual(
    roomLabelFromFacts(
      { channel_name: "Design review", sender_names: names },
      "!room:x",
      ["@alice:x"],
      IDENTITY,
    ),
    { label: "Filament · Design review", subject: "Design review" },
  );
  // A DM by the people in it other than the agent; an unnamed sender by their id.
  assert.deepEqual(
    roomLabelFromFacts(
      { sender_names: names },
      "!dm:x",
      ["@alice:x", "@carl:x", "@bob:x"],
      IDENTITY,
    ),
    { label: "Filament · Alice, @bob:x", subject: "Alice, @bob:x" },
  );
  // Nothing to go on: an older server, a backchannel item without the owner, only the agent.
  assert.equal(roomLabelFromFacts({}, "!room:x", ["@alice:x"], IDENTITY), null);
  assert.equal(roomLabelFromFacts({ sender_names: {} }, "!cc:x", ["@carl:x"], IDENTITY), null);
  assert.equal(roomLabelFromFacts({ sender_names: names }, "!dm:x", ["@carl:x"], IDENTITY), null);
});

test("createRoomLabels: an item with room facts needs no get_channel_details", async () => {
  const calls: string[] = [];
  const client = {
    callTool: async (name: string) => {
      calls.push(name);
      return { ok: true, data: { name: "Looked up", members: [] } } as ToolCallResult;
    },
  };
  const labelOf = createRoomLabels(client, IDENTITY);
  const item = {
    channel_name: "General",
    sender_names: { "@alice:x": "Alice" },
    messages: [{ event_id: "$1", sender: "@alice:x", body: "hi", ts: 1 }],
  };
  assert.deepEqual(await labelOf("!room:x", undefined, item), {
    label: "Filament · General",
    subject: "General",
  });
  assert.deepEqual(calls, []);
  // An item from an older server falls back to the lookup.
  const old = { messages: item.messages };
  assert.deepEqual(await labelOf("!other:x", undefined, old), {
    label: "Filament · Looked up",
    subject: "Looked up",
  });
  assert.deepEqual(calls, ["get_channel_details"]);
});
