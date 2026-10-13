import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchWorkItemTurn, type DispatchWorkItemParams } from "./turn.js";
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
