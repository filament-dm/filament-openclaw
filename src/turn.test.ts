import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchWorkItemTurn, inboundMessageFields, type DispatchWorkItemParams } from "./turn.js";
import { turnPeerKind } from "./work-item.js";

/** Stands in for the gateway: OpenClaw's default dmScope ("main") and groupScope ("per-group"). */
function fakeRuntime() {
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
        await dispatcherOptions.deliver({ text: "hello back" }, { kind: "final" });
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
