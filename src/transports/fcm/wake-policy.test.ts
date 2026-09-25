import assert from "node:assert/strict";
import { test } from "node:test";

import type { DecodedPush } from "./decode.js";
import { decideWake, EngagedThreads, isSystemSender } from "./wake-policy.js";

const SELF = "@a_test1.1:filament-dev.local";
const CC = "!cc:filament-dev.local";
const ROOM = "!general:filament-dev.local";

function push(overrides: Partial<DecodedPush> = {}): DecodedPush {
  return {
    branchType: "channel_message",
    eventId: "$e1",
    roomId: ROOM,
    senderId: "@u_test2:filament-dev.local",
    text: "hello everyone",
    threadId: null,
    raw: {},
    ...overrides,
  };
}

function decide(p: DecodedPush, engaged = new EngagedThreads()) {
  return decideWake(p, { selfMxid: SELF, ccRoomId: CC, engaged });
}

test("wake: backchannel and direct messages always wake", () => {
  assert.equal(decide(push({ roomId: CC })).wake, true);
  assert.equal(decide(push({ branchType: "direct_message" })).wake, true);
});

test("wake: a channel message wakes only when addressed", () => {
  assert.equal(decide(push()).wake, false);
  assert.equal(decide(push({ isMentionOfRecipient: true })).wake, true);
  assert.equal(decide(push({ text: `hey ${SELF}, look` })).wake, true);
  assert.equal(decide(push({ isReplyToRecipient: true })).wake, true);
});

test("wake: @everyone is not a mention", () => {
  assert.equal(decide(push({ isEveryoneMention: true })).wake, false);
});

test("wake: a follow-up in an engaged thread wakes, from a human only", () => {
  const engaged = new EngagedThreads();
  engaged.record(ROOM, "$root");
  assert.equal(decide(push({ threadId: "$root" }), engaged).wake, true);
  assert.equal(decide(push({ threadId: "$other" }), engaged).wake, false);
  assert.equal(decide(push({ threadId: "$root", senderIsAgent: true }), engaged).wake, false);
});

test("wake: another agent needs an explicit mention", () => {
  assert.equal(decide(push({ senderIsAgent: true, isReplyToRecipient: true })).wake, false);
  assert.equal(decide(push({ senderIsAgent: true, isMentionOfRecipient: true })).wake, true);
});

test("wake: never its own messages or the system user's", () => {
  assert.equal(decide(push({ senderId: SELF, roomId: CC })).wake, false);
  assert.equal(
    decide(push({ senderId: "@filament_god:filament-dev.local", roomId: CC })).wake,
    false,
  );
  assert.equal(isSystemSender("@filament_god:elsewhere.example", SELF), false);
});

test("EngagedThreads: bounded, oldest dropped first", () => {
  const engaged = new EngagedThreads();
  for (let i = 0; i < 501; i++) engaged.record(ROOM, `$t${i}`);
  assert.equal(engaged.isEngaged(ROOM, "$t0"), false);
  assert.equal(engaged.isEngaged(ROOM, "$t500"), true);
  assert.equal(engaged.isEngaged(ROOM, null), false);
});
