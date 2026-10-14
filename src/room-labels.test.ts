import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCallResult } from "./mcp-client.js";
import { createRoomLabels, roomLabelFrom } from "./room-labels.js";

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
