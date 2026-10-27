import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchWorkItemTurn,
  hostReplyKind,
  inboundMessageFields,
  type DispatchWorkItemParams,
} from "./turn.js";
import { turnPeerKind } from "./work-item.js";

/** Stands in for the gateway: OpenClaw's default dmScope ("main") and groupScope ("per-group"). */
function fakeRuntime(finals: unknown[] = [{ text: "hello back" }]) {
  const contexts: Array<Record<string, unknown>> = [];
  const runtime = {
    routing: {
      resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
        agentId: "main",
        accountId: "main",
        sessionKey:
          peer.kind === "direct" ? "agent:main:main" : `agent:main:filament:group:${peer.id}`,
      }),
    },
    session: {
      resolveStorePath: () => "/tmp/filament-turn-test-store",
      readSessionUpdatedAt: () => undefined,
      recordInboundSession: async () => {},
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }: { body: string }) => body,
      finalizeInboundContext: (ctx: Record<string, unknown>) => {
        contexts.push(ctx);
        return ctx;
      },
      dispatchReplyWithBufferedBlockDispatcher: async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: { deliver: (p: unknown, i: { kind: string }) => Promise<void> };
      }) => {
        for (const payload of finals) await dispatcherOptions.deliver(payload, { kind: "final" });
      },
    },
  };
  return { runtime, contexts };
}

function params(
  overrides: Partial<DispatchWorkItemParams>,
  runtime: unknown,
): DispatchWorkItemParams {
  return {
    cfg: {},
    channelRuntime: runtime,
    channel: "filament",
    channelLabel: "Filament",
    accountId: "main",
    peerKind: "direct",
    channelId: "!cc:x",
    threadId: null,
    messages: [{ event_id: "$e1", sender: "@owner:x", body: "hi", ts: 1 }],
    recipientAddress: "@agent:x",
    conversationLabel: "!cc:x",
    commandAuthorized: true,
    log: () => {},
    ...overrides,
  };
}

test("turnPeerKind: only the principal's backchannel is direct; another person's DM is a group", () => {
  assert.equal(turnPeerKind({ is_backchannel: true }), "direct");
  assert.equal(turnPeerKind({ is_backchannel: false }), "group");
});

test("dispatchWorkItemTurn: the backchannel follows dmScope; others' rooms get their own session", async () => {
  const { runtime, contexts } = fakeRuntime();
  await dispatchWorkItemTurn(params({}, runtime));
  await dispatchWorkItemTurn(
    params(
      { peerKind: "group", channelId: "!dm-from-stranger:x", commandAuthorized: false },
      runtime,
    ),
  );
  assert.equal(contexts[0]!.SessionKey, "agent:main:main");
  assert.equal(contexts[0]!.ChatType, "direct");
  assert.equal(contexts[1]!.SessionKey, "agent:main:filament:group:!dm-from-stranger:x");
  assert.equal(contexts[1]!.ChatType, "group");
});

test("dispatchWorkItemTurn: a side session keeps a gateway-written prompt out of the main one", async () => {
  const { runtime, contexts } = fakeRuntime();
  const result = await dispatchWorkItemTurn(
    params({ sideSession: "filament-first-hello" }, runtime),
  );
  assert.equal(result.finalText, "hello back");
  assert.notEqual(contexts[0]!.SessionKey, "agent:main:main");
  assert.match(String(contexts[0]!.SessionKey), /^agent:main:main.*filament-first-hello$/);
  assert.deepEqual(contexts[0]!.InputProvenance, {
    kind: "internal_system",
    sourceTool: "filament:filament-first-hello",
  });
  // An ordinary turn carries no provenance of its own.
  await dispatchWorkItemTurn(params({}, runtime));
  assert.equal(contexts[1]!.InputProvenance, undefined);
});

test("inboundMessageFields: the last message is the turn's; earlier ones are history with ids", () => {
  const messages = [
    { event_id: "$a1", sender: "@alice:x", body: "ship it?", ts: 1 },
    { event_id: "$b2", sender: "@bob:x", body: "not yet", ts: 2 },
    { event_id: "$c3", sender: "@owner:x", body: "react 👍 to Alice", ts: 3 },
  ];
  assert.deepEqual(inboundMessageFields(messages), {
    body: "react 👍 to Alice",
    current: messages[2],
    history: [
      { sender: "@alice:x", body: "ship it?", timestamp: 1, messageId: "$a1" },
      { sender: "@bob:x", body: "not yet", timestamp: 2, messageId: "$b2" },
    ],
  });
  assert.deepEqual(inboundMessageFields([]), { body: "", current: undefined, history: [] });
  // Known names lead, with the id kept for mentions.
  assert.deepEqual(inboundMessageFields(messages, { "@alice:x": "Alice" }).history, [
    { sender: "Alice (@alice:x)", body: "ship it?", timestamp: 1, messageId: "$a1" },
    { sender: "@bob:x", body: "not yet", timestamp: 2, messageId: "$b2" },
  ]);
});

test("dispatchWorkItemTurn: an item's room facts become the sender's name and the group's channel and loop", async () => {
  const { runtime, contexts } = fakeRuntime();
  const facts = {
    senderNames: { "@owner:x": "Test One", "@alice:x": "Alice" },
    channelName: "Design review",
    loopName: "Acme",
  };
  await dispatchWorkItemTurn(
    params(
      {
        ...facts,
        peerKind: "group",
        channelId: "!room:x",
        messages: [
          { event_id: "$a1", sender: "@alice:x", body: "ship it?", ts: 10 },
          { event_id: "$c3", sender: "@owner:x", body: "quote Alice", ts: 20 },
        ],
      },
      runtime,
    ),
  );
  await dispatchWorkItemTurn(params(facts, runtime));
  const group = contexts[0]!;
  assert.equal(group.SenderName, "Test One");
  assert.equal(group.SenderId, "@owner:x");
  assert.equal(group.GroupChannel, "Design review");
  assert.equal(group.GroupSpace, "Acme");
  assert.deepEqual(group.InboundHistory, [
    { sender: "Alice (@alice:x)", body: "ship it?", timestamp: 10, messageId: "$a1" },
  ]);
  // The backchannel is direct: a sender name, but no group channel or loop.
  assert.equal(contexts[1]!.SenderName, "Test One");
  assert.equal(contexts[1]!.GroupChannel, undefined);
  assert.equal(contexts[1]!.GroupSpace, undefined);
});

test("dispatchWorkItemTurn: plain text in the body, ids and senders in OpenClaw's context fields", async () => {
  const { runtime, contexts } = fakeRuntime();
  await dispatchWorkItemTurn(
    params(
      {
        peerKind: "group",
        channelId: "!room:x",
        messages: [
          { event_id: "$a1", sender: "@alice:x", body: "ship it?", ts: 10 },
          { event_id: "$c3", sender: "@owner:x", body: "quote Alice", ts: 20 },
        ],
      },
      runtime,
    ),
  );
  const ctx = contexts[0]!;
  // What the owner sees: the words alone, no `[sender event]` prefix.
  for (const key of ["Body", "BodyForAgent", "RawBody", "CommandBody"]) {
    assert.equal(ctx[key], "quote Alice", key);
  }
  // What OpenClaw puts in the model's `Conversation info` and history blocks.
  assert.equal(ctx.MessageSid, "$c3");
  assert.equal(ctx.SenderId, "@owner:x");
  assert.equal(ctx.From, "@owner:x");
  assert.equal(ctx.OriginatingTo, "!room:x");
  assert.equal(ctx.Timestamp, 20);
  assert.deepEqual(ctx.InboundHistory, [
    { sender: "@alice:x", body: "ship it?", timestamp: 10, messageId: "$a1" },
  ]);
  // A one-message item carries no history.
  await dispatchWorkItemTurn(params({}, runtime));
  assert.equal(contexts[1]!.InboundHistory, undefined);
  assert.equal(contexts[1]!.Body, "hi");
});

test("dispatchWorkItemTurn: the session is titled by its label; a group also gets its subject", async () => {
  const { runtime, contexts } = fakeRuntime();
  await dispatchWorkItemTurn(
    params({ conversationLabel: "Filament · Test One", groupSubject: "x" }, runtime),
  );
  await dispatchWorkItemTurn(
    params(
      {
        peerKind: "group",
        channelId: "!room:x",
        conversationLabel: "Filament · Design review",
        groupSubject: "Design review",
      },
      runtime,
    ),
  );
  assert.equal(contexts[0]!.ConversationLabel, "Filament · Test One");
  // The backchannel is direct: no group subject.
  assert.equal(contexts[0]!.GroupSubject, undefined);
  assert.equal(contexts[1]!.ConversationLabel, "Filament · Design review");
  assert.equal(contexts[1]!.GroupSubject, "Design review");
});

test("hostReplyKind: OpenClaw's failures and notices, read off the payload as delivered", () => {
  assert.equal(hostReplyKind({ text: "x", isError: true }), "error");
  assert.equal(hostReplyKind({ text: "x", isFallbackNotice: true }), "notice");
  assert.equal(hostReplyKind({ text: "x", isStatusNotice: true }), "notice");
  assert.equal(hostReplyKind({ text: "x", isCompactionNotice: true }), "notice");
  assert.equal(hostReplyKind({ text: "x" }), null);
  assert.equal(hostReplyKind({ text: "x", isError: false }), null);
  assert.equal(hostReplyKind(undefined), null);
});

test("dispatchWorkItemTurn: an error OpenClaw delivers as the final reply is an error, not an answer", async () => {
  // What OpenClaw sends when it refuses a model's silence and has no fallback model.
  const { runtime } = fakeRuntime([
    { text: "⚠️ The AI service returned an empty reply. Please try again.", isError: true },
  ]);
  const result = await dispatchWorkItemTurn(
    params({ peerKind: "group", channelId: "!room:x" }, runtime),
  );
  assert.equal(result.sawError, true);
  assert.equal(result.sawFinal, false);
  assert.equal(result.finalText, "");
  assert.equal(
    result.errorReplyText,
    "⚠️ The AI service returned an empty reply. Please try again.",
  );
  assert.match(result.errorDetail ?? "", /OpenClaw error reply: ⚠️ The AI service/);
});

test("dispatchWorkItemTurn: an OpenClaw notice is left out; the agent's own answer still counts", async () => {
  const { runtime } = fakeRuntime([
    { text: "Fallback used other/model.", isFallbackNotice: true },
    { text: "the real answer" },
  ]);
  const result = await dispatchWorkItemTurn(params({}, runtime));
  assert.equal(result.sawError, false);
  assert.equal(result.sawFinal, true);
  assert.equal(result.finalText, "the real answer");
  assert.equal(result.errorReplyText, undefined);
});
