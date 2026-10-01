import assert from "node:assert/strict";
import { test } from "node:test";

import { alreadyAnswered, type RoutablePush, routeReply } from "./reply-route.js";

const base: RoutablePush = {
  roomId: "!room:x",
  eventId: "$e",
  threadId: null,
  isBackchannel: false,
  isDirect: false,
};

test("route: the backchannel answers the principal", () => {
  assert.deepEqual(routeReply({ ...base, isBackchannel: true }), {
    tool: "message_principal",
    args: {},
  });
});

test("route: a DM replies top level, or in its thread", () => {
  assert.deepEqual(routeReply({ ...base, isDirect: true }), {
    tool: "post_message",
    args: { channel: "!room:x" },
  });
  assert.deepEqual(routeReply({ ...base, isDirect: true, threadId: "$t" }), {
    tool: "reply_in_thread",
    args: { message_id: "$t" },
  });
});

test("route: a channel always threads, off the thread or the message", () => {
  assert.deepEqual(routeReply(base), { tool: "reply_in_thread", args: { message_id: "$e" } });
  assert.deepEqual(routeReply({ ...base, threadId: "$t" }), {
    tool: "reply_in_thread",
    args: { message_id: "$t" },
  });
});

test("alreadyAnswered: a tool reply to this room, a thread reply, or the principal", () => {
  assert.equal(alreadyAnswered(base, new Set()), false);
  assert.equal(alreadyAnswered(base, new Set(["!room:x"])), true);
  assert.equal(alreadyAnswered(base, new Set(["!other:x"])), false);
  assert.equal(alreadyAnswered(base, new Set(["*"])), true);
  assert.equal(alreadyAnswered(base, new Set(["backchannel"])), false);
  assert.equal(alreadyAnswered({ ...base, isBackchannel: true }, new Set(["backchannel"])), true);
});
