import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCallResult } from "../../mcp-client.js";
import { ATTACHMENT_ONLY_BODY } from "../../work-item.js";
import {
  type DispatchOutcome,
  MAX_REPLY_ATTEMPTS,
  parsePollWorkResponse,
  PENDING_SWEEP_INTERVAL_MS,
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

test("fatal outcome: no ack, no further polling — the loop reports it", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient([
    okResult({ work: [itemFixture()], cursor: "c:1", truncated: false, acknowledged: 0 }),
  ]);
  const result = await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "fatal", diagnostic: "auth: token revoked" }),
  });
  assert.equal(result.fatal, "auth: token revoked");
  assert.equal(calls.length, 1); // no second poll — the loop stopped, not retried
});

test("dropped outcome (a refused reply or a failed turn): ack'd on the next poll, the loop goes on", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient([
    okResult({ work: [itemFixture()], cursor: "c:1", truncated: false, acknowledged: 0 }),
    okResult({ work: [], cursor: "c:2", truncated: false, acknowledged: 1 }),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:3", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  const result = await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "dropped", diagnostic: "This agent is paused" }),
  });
  assert.deepEqual(result, {});
  assert.deepEqual((calls[1] as { ack?: string[] }).ack, ["$e1"]);
  assert.equal(calls.length, 3);
});

test("retry outcome: left un-ack'd with a backoff while re-offered, ack'd on the third attempt", async () => {
  const controller = new AbortController();
  const offer = () =>
    okResult({ work: [itemFixture()], cursor: "c:1", truncated: false, acknowledged: 0 });
  const { client, calls } = fakeClient([
    offer(),
    offer(),
    offer(),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:2", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  const backoffCalls: number[] = [];
  let dispatches = 0;
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => {
      dispatches += 1;
      return { kind: "retry", diagnostic: "transient: HTTP 502" };
    },
    backoffMs: (attempt) => {
      backoffCalls.push(attempt);
      return 0;
    },
  });
  assert.equal(dispatches, MAX_REPLY_ATTEMPTS);
  assert.deepEqual(backoffCalls, [1, 2]);
  assert.equal((calls[1] as { ack?: string[] }).ack, undefined);
  assert.equal((calls[2] as { ack?: string[] }).ack, undefined);
  assert.deepEqual((calls[3] as { ack?: string[] }).ack, ["$e1"]);
});

test("busy: waits next_poll_ms, then re-polls with the same cursor and the acks still pending", async () => {
  const controller = new AbortController();
  const stamps: number[] = [];
  const { client, calls } = fakeClient([
    okResult({ work: [itemFixture()], cursor: "c:1", truncated: false, acknowledged: 0 }),
    okResult({ work: [], busy: true, next_poll_ms: 30 }),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:2", truncated: false, acknowledged: 1 }),
      );
    },
  ]);
  const originalPoll = client.pollWork;
  client.pollWork = (args, opts) => {
    stamps.push(Date.now());
    return originalPoll(args, opts);
  };
  const result = await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "silent" }),
  });
  assert.deepEqual(result, {});
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], { cursor: "c:1", ack: ["$e1"], wait_seconds: 30, max_items: 1 });
  assert.deepEqual(calls[2], { cursor: "c:1", ack: ["$e1"], wait_seconds: 30, max_items: 1 });
  assert.ok(stamps[2]! - stamps[1]! >= 25, `waited ${stamps[2]! - stamps[1]!}ms`);
});

test("a poll_work call that throws without an abort backs off and polls again", async () => {
  const controller = new AbortController();
  const backoffCalls: number[] = [];
  const { client, calls } = fakeClient([
    () => Promise.reject(new TypeError("fetch failed")),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:1", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  const result = await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
    backoffMs: (attempt) => {
      backoffCalls.push(attempt);
      return 0;
    },
  });
  assert.deepEqual(result, {});
  assert.deepEqual(backoffCalls, [1]);
  assert.equal(calls.length, 2);
});

test("pending sweep: once at start, before the first poll", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const { client } = fakeClient([
    () => {
      events.push("poll");
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:1", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
    sweepPending: async () => {
      events.push("sweep");
    },
  });
  assert.deepEqual(events, ["sweep", "poll"]);
});

test("pending sweep: a poll carrying invites triggers one, an empty invites list does not", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const poll = (data: unknown) => () => {
    events.push("poll");
    return Promise.resolve(okResult(data));
  };
  const { client } = fakeClient([
    poll({ work: [], cursor: "c:1", truncated: false, acknowledged: 0, invites: [] }),
    poll({
      work: [],
      cursor: "c:2",
      truncated: false,
      acknowledged: 0,
      invites: [{ room_id: "!loop:server", event_id: "$i1", inviter: "@ada:server" }],
    }),
    () => {
      events.push("poll");
      controller.abort();
      return Promise.resolve(okResult({ work: [], cursor: "c:3" }));
    },
  ]);
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
    sweepPending: async () => {
      events.push("sweep");
    },
  });
  assert.deepEqual(events, ["sweep", "poll", "poll", "sweep", "poll"]);
});

test("pending sweep: the backstop runs once the interval has passed, with no invites hint", async () => {
  const controller = new AbortController();
  let clock = 0;
  let sweeps = 0;
  const empty = () => okResult({ work: [], cursor: "c:1", truncated: false, acknowledged: 0 });
  const { client } = fakeClient([
    () => {
      clock += PENDING_SWEEP_INTERVAL_MS - 1;
      return Promise.resolve(empty());
    },
    () => {
      clock += 1;
      return Promise.resolve(empty());
    },
    () => {
      controller.abort();
      return Promise.resolve(empty());
    },
  ]);
  const sweepsAtPoll: number[] = [];
  const originalPoll = client.pollWork;
  client.pollWork = (args, opts) => {
    sweepsAtPoll.push(sweeps);
    return originalPoll(args, opts);
  };
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
    sweepPending: async () => {
      sweeps += 1;
    },
    now: () => clock,
  });
  assert.deepEqual(sweepsAtPoll, [1, 1, 2]);
});

test("parsePollWorkResponse: flags an older server omits default to false, invites to []", () => {
  const parsed = parsePollWorkResponse({
    work: [
      {
        channel_id: "!room:server",
        thread_id: null,
        messages: [{ event_id: "$e1", sender: "@ada:server", body: "hi", ts: 1 }],
        reply_with: null,
      },
    ],
    cursor: "c:1",
  });
  assert.ok(parsed);
  assert.equal(parsed.busy, false);
  assert.deepEqual(parsed.invites, []);
  assert.equal(parsed.work[0]!.is_direct, false);
  assert.deepEqual(parsed.work[0]!.messages[0], {
    event_id: "$e1",
    sender: "@ada:server",
    body: "hi",
    ts: 1,
    is_mention: false,
    sender_is_agent: false,
  });
});

test("parsePollWorkResponse: reads the new flags, and a media-only message still says what it is", () => {
  const parsed = parsePollWorkResponse({
    work: [
      {
        channel_id: "!dm:server",
        thread_id: null,
        is_backchannel: false,
        is_direct: true,
        messages: [
          {
            event_id: "$e1",
            sender: "@bot:server",
            body: "",
            ts: 1,
            is_mention: true,
            is_reply_to_recipient: false,
            sender_is_agent: true,
            has_media: true,
          },
        ],
        reply_with: { tool: "post_message", args: { channel: "!dm:server" } },
      },
    ],
    cursor: "c:1",
    invites: [{ room_id: "!loop:server", event_id: "$i", inviter: "@ada:server" }, { bogus: 1 }],
  });
  assert.ok(parsed);
  assert.equal(parsed.work[0]!.is_direct, true);
  assert.equal(parsed.work[0]!.messages[0]!.is_mention, true);
  assert.equal(parsed.work[0]!.messages[0]!.sender_is_agent, true);
  assert.equal(parsed.work[0]!.messages[0]!.body, ATTACHMENT_ONLY_BODY);
  assert.deepEqual(parsed.invites, [{ room_id: "!loop:server" }]);
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
