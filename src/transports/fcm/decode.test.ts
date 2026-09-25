import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeDirectPusher, isChatMessage, isInvite, isVouch } from "./decode.js";

const envelope = (data: Record<string, unknown>) => ({ message: { data } });

test("decodes a direct message payload", () => {
  const decoded = decodeDirectPusher(
    envelope({
      from_directpusher: "true",
      room_name: "Ada",
      message_text: "hello",
      body: JSON.stringify({
        event_id: "$evt1",
        room_id: "!room:server",
        is_direct: true,
        branch: {
          type: "direct_message",
          sender: "Ada Lovelace",
          sender_id: "@ada:server",
          content: { text: "hello there" },
          channel: "Ada",
          thread_id: null,
          is_mention_of_recipient: true,
          is_everyone_mention: false,
        },
      }),
    }),
  );
  assert.ok(decoded);
  assert.equal(decoded.branchType, "direct_message");
  assert.equal(decoded.eventId, "$evt1");
  assert.equal(decoded.roomId, "!room:server");
  assert.equal(decoded.isDirect, true);
  assert.equal(decoded.sender, "Ada Lovelace");
  assert.equal(decoded.senderId, "@ada:server");
  assert.equal(decoded.text, "hello there");
  assert.equal(decoded.isMentionOfRecipient, true);
  assert.equal(isChatMessage(decoded.branchType), true);
});

test("decodes a media-only message as text: null", () => {
  const decoded = decodeDirectPusher(
    envelope({
      body: JSON.stringify({
        event_id: "$evt2",
        room_id: "!room:server",
        branch: { type: "channel_message", sender_id: "@bob:server", content: null },
      }),
    }),
  );
  assert.ok(decoded);
  assert.equal(decoded.branchType, "channel_message");
  assert.equal(decoded.text, null);
  assert.equal(isChatMessage(decoded.branchType), true);
});

test("decodes a liveness ping (top-level type, no branch)", () => {
  const decoded = decodeDirectPusher(
    envelope({ body: JSON.stringify({ type: "io.filament.ping", nonce: "abc123" }) }),
  );
  assert.ok(decoded);
  assert.equal(decoded.branchType, "io.filament.ping");
  assert.equal(decoded.nonce, "abc123");
  assert.equal(isChatMessage(decoded.branchType), false);
});

test("skips badge-only refreshes", () => {
  assert.equal(decodeDirectPusher(envelope({ badge_only: "true", badge_count: "3" })), null);
});

test("returns null for an unparseable / typeless payload", () => {
  assert.equal(decodeDirectPusher(envelope({ body: "{not json" })), null);
  assert.equal(decodeDirectPusher(envelope({ body: JSON.stringify({ foo: 1 }) })), null);
  assert.equal(decodeDirectPusher({ message: {} }), null);
});

test("unwraps a nested data dict", () => {
  const decoded = decodeDirectPusher(
    envelope({ data: { body: JSON.stringify({ type: "io.filament.ping", nonce: "n" }) } }),
  );
  assert.ok(decoded);
  assert.equal(decoded.branchType, "io.filament.ping");
  assert.equal(decoded.nonce, "n");
});

test("decodes an invite (add_to_space) — room_id is the accept target", () => {
  const decoded = decodeDirectPusher(
    envelope({
      body: JSON.stringify({
        room_id: "!space:server",
        branch: { type: "add_to_space", sender_id: "@ada:server" },
      }),
    }),
  );
  assert.ok(decoded);
  assert.equal(decoded.branchType, "add_to_space");
  assert.equal(decoded.roomId, "!space:server");
  assert.equal(isInvite(decoded.branchType), true);
  assert.equal(isVouch(decoded.branchType), false);
});

test("decodes a vouch (knock_invite_received) — loop_id is on the branch", () => {
  const decoded = decodeDirectPusher(
    envelope({
      body: JSON.stringify({
        room_id: "!fallback:server",
        branch: { type: "knock_invite_received", loop_id: "!loop:server" },
      }),
    }),
  );
  assert.ok(decoded);
  assert.equal(decoded.branchType, "knock_invite_received");
  assert.equal(decoded.loopId, "!loop:server");
  assert.equal(isVouch(decoded.branchType), true);
  assert.equal(isChatMessage(decoded.branchType), false);
});

test("decodes the branch fields DirectPusher added after the first plugin", () => {
  const decoded = decodeDirectPusher(
    envelope({
      body: JSON.stringify({
        room_id: "!room:server",
        branch: {
          type: "channel_message",
          event_id: "$branchevt",
          sender_id: "@bot:server",
          content: { text: "hi" },
          thread_id: "$root",
          is_reply_to_recipient: true,
          sender_is_agent: true,
          has_media: false,
        },
      }),
    }),
  );
  assert.ok(decoded);
  assert.equal(decoded.eventId, "$branchevt");
  assert.equal(decoded.threadId, "$root");
  assert.equal(decoded.isReplyToRecipient, true);
  assert.equal(decoded.senderIsAgent, true);
  assert.equal(decoded.hasMedia, false);
});
