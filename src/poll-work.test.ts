import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCallResult } from "./mcp-client.js";
import {
  type DispatchOutcome,
  type PollClient,
  type PollWorkItem,
  runPollLoop,
} from "./poll-work.js";

function okResult(data: unknown): ToolCallResult {
  return { ok: true, httpStatus: 200, data };
}
function errResult(kind: ToolCallResult["kind"], message = "x"): ToolCallResult {
  return { ok: false, httpStatus: kind === "auth" ? 401 : 502, kind, error: { code: -1, message } };
}

function itemFixture(overrides: Partial<PollWorkItem> = {}): PollWorkItem {
  return {
    channel_id: "!room:server",
    thread_id: null,
    is_backchannel: false,
    messages: [{ event_id: "$e1", sender: "@ada:server", body: "hi", ts: 1 }],
    reply_with: { tool: "post_message", args: { channel: "!room:server" } },
    ...overrides,
  };
}

/** A fake client whose pollWork responses are supplied one call at a time. */
function fakeClient(
  responses: Array<ToolCallResult | ((signal: AbortSignal | undefined) => Promise<ToolCallResult>)>,
): { client: PollClient; calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  const client: PollClient = {
    pollWork: async (args, opts) => {
      calls.push(args);
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (typeof next === "function") return next(opts?.signal);
      return next;
    },
  };
  return { client, calls };
}

test("empty poll result: re-polls immediately with the returned cursor, no dispatch", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient([
    okResult({ work: [], cursor: "c:1", next_poll_ms: 1000, truncated: false, acknowledged: 0 }),
    okResult({ work: [], cursor: "c:2", next_poll_ms: 1000, truncated: false, acknowledged: 0 }),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:3", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  let dispatchCalls = 0;
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => {
      dispatchCalls += 1;
      return { kind: "published" };
    },
  });
  assert.equal(dispatchCalls, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], { cursor: "c:1", ack: undefined, wait_seconds: 30, max_items: 1 });
  assert.deepEqual(calls[2], { cursor: "c:2", ack: undefined, wait_seconds: 30, max_items: 1 });
});

test("one item, dispatch published: no ack is sent on the next poll", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient([
    okResult({ work: [itemFixture()], cursor: "c:1", truncated: false, acknowledged: 0 }),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:2", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  const outcomes: DispatchOutcome[] = [];
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => {
      const outcome: DispatchOutcome = { kind: "published" };
      outcomes.push(outcome);
      return outcome;
    },
  });
  assert.equal(outcomes.length, 1);
  assert.deepEqual(calls[1], { cursor: "c:1", ack: undefined, wait_seconds: 30, max_items: 1 });
});

test("deliberate silence: the item's event_ids are ack'd on the next poll", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient([
    okResult({
      work: [itemFixture({ messages: [{ event_id: "$e1", sender: "@a:s", body: "b", ts: 1 }] })],
      cursor: "c:1",
      truncated: false,
      acknowledged: 0,
    }),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:2", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "silent" }),
  });
  assert.deepEqual(calls[1], { cursor: "c:1", ack: ["$e1"], wait_seconds: 30, max_items: 1 });
});

test("item dispatch error: no ack, no further polling — the loop reports fatal", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient([
    okResult({ work: [itemFixture()], cursor: "c:1", truncated: false, acknowledged: 0 }),
  ]);
  const result = await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "error", diagnostic: "model blew up" }),
  });
  assert.equal(result.fatal, "dispatch: model blew up");
  assert.equal(calls.length, 1); // no second poll — the loop stopped, not retried
});

test("auth error from poll_work stops the loop without retry", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient([errResult("auth", "token revoked")]);
  const result = await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
  });
  assert.match(result.fatal ?? "", /auth/);
  assert.equal(calls.length, 1);
});

test("transient 502 backs off (via injected backoffMs) rather than hot-looping, then recovers", async () => {
  const controller = new AbortController();
  const backoffCalls: number[] = [];
  const { client, calls } = fakeClient([
    errResult("transient", "HTTP 502"),
    errResult("transient", "HTTP 502"),
    okResult({ work: [], cursor: "c:1", truncated: false, acknowledged: 0 }),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:2", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
    backoffMs: (attempt) => {
      backoffCalls.push(attempt);
      return 0; // keep the test fast; we only assert backoff was consulted with increasing attempts
    },
  });
  assert.deepEqual(backoffCalls, [1, 2]);
  assert.equal(calls.length, 4);
});

test("abort during the long-poll call exits promptly without a fatal result", async () => {
  const controller = new AbortController();
  const { client } = fakeClient([
    (signal) =>
      new Promise<ToolCallResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  ]);
  const loopPromise = runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
  });
  controller.abort();
  const result = await loopPromise;
  assert.deepEqual(result, {});
});

test("an item with no reply_with is skipped (not dispatched, not ack'd)", async () => {
  const controller = new AbortController();
  const { client } = fakeClient([
    okResult({
      work: [itemFixture({ reply_with: null })],
      cursor: "c:1",
      truncated: false,
      acknowledged: 0,
    }),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:2", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  let dispatchCalls = 0;
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => {
      dispatchCalls += 1;
      return { kind: "published" };
    },
  });
  assert.equal(dispatchCalls, 0);
});

test("ambiguous outcome: re-offered item is left alone once, then ack'd the second time", async () => {
  const controller = new AbortController();
  const item = itemFixture({ messages: [{ event_id: "$e1", sender: "@a:s", body: "b", ts: 1 }] });
  const offer = () => okResult({ work: [item], cursor: "c:1", truncated: false, acknowledged: 0 });
  const { client, calls } = fakeClient([
    offer(),
    offer(),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:2", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  let dispatches = 0;
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => {
      dispatches += 1;
      return { kind: "ambiguous" };
    },
  });
  assert.equal(dispatches, 2);
  assert.equal((calls[1] as { ack?: string[] }).ack, undefined);
  assert.deepEqual((calls[2] as { ack?: string[] }).ack, ["$e1"]);
});
