import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCallResult } from "../../mcp-client.js";
import { ATTACHMENT_ONLY_BODY } from "../../work-item.js";
import {
  type DispatchOutcome,
  AMBIGUOUS_HOLD_MS,
  MAX_REPLY_ATTEMPTS,
  parsePollWorkResponse,
  PENDING_SWEEP_INTERVAL_MS,
  type PollClient,
  type PollWorkItem,
  runPollLoop,
} from "./poll-work.js";
import { skipReason } from "./index.js";

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
        messages: [{ event_id: "$e1", sender: "@ada:server", body: "hi", timestamp: 1 }],
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
            timestamp: 1,
            is_mention: true,
            is_from_agent: true,
            media: [{ url: "mxc://server/abc" }],
            is_implicitly_mentioned: true,
            reply_expected: false,
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
  assert.equal(parsed.work[0]!.messages[0]!.is_implicitly_mentioned, true);
  assert.equal(parsed.work[0]!.messages[0]!.reply_expected, false);
  assert.equal(parsed.work[0]!.messages[0]!.body, ATTACHMENT_ONLY_BODY);
  assert.deepEqual(parsed.invites, [{ room_id: "!loop:server" }]);
  // No room facts from this server.
  assert.equal(parsed.work[0]!.sender_names, undefined);
  assert.equal(parsed.work[0]!.channel_name, undefined);
});

// A `poll_work` response in the shape synapse develop sends: rows are `AgentMessage`
// (synapse/plugins/agents_mcp/message_model.py), dumped with exclude_unset, so optional
// fields are absent rather than null.
const SELF = "@agent:server";
function developResponse(messages: Record<string, unknown>[]) {
  return {
    work: [
      {
        kind: "message",
        channel_id: "!group:server",
        thread_id: null,
        is_backchannel: false,
        messages,
        reply_with: {
          tool: "post_message",
          args: { channel: "!group:server", in_reply_to: "$e1" },
        },
      },
    ],
    cursor: "c:1",
    next_poll_ms: 0,
    truncated: false,
    acknowledged: 0,
  };
}
function developRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "$e1",
    sender: "@other-agent:server",
    body: "status update",
    timestamp: 1760000000000,
    type: "m.room.message",
    msgtype: "m.text",
    channel_id: "!group:server",
    is_from_self: false,
    is_from_principal: false,
    is_from_agent: true,
    is_system: false,
    is_mention: false,
    ...overrides,
  };
}

test("parsePollWorkResponse: maps the develop row (is_from_agent, timestamp, media)", () => {
  const parsed = parsePollWorkResponse(
    developResponse([
      developRow(),
      developRow({
        event_id: "$e2",
        sender: "@ada:server",
        body: "",
        is_from_agent: false,
        media: [{ url: "mxc://server/abc", mimetype: "image/png" }],
      }),
    ]),
  );
  assert.ok(parsed);
  const [agentMsg, mediaMsg] = parsed.work[0]!.messages;
  assert.equal(agentMsg!.sender_is_agent, true);
  assert.equal(agentMsg!.ts, 1760000000000);
  assert.equal(mediaMsg!.sender_is_agent, false);
  assert.equal(mediaMsg!.body, ATTACHMENT_ONLY_BODY);
});

test("develop row: another agent's unmentioned message is skipped; one the server judged for us wakes", () => {
  const skipped = parsePollWorkResponse(developResponse([developRow()]));
  assert.ok(skipped);
  assert.equal(skipReason(skipped.work[0]!, SELF), "agent sender, no mention");

  const addressed = parsePollWorkResponse(
    developResponse([developRow({ is_implicitly_mentioned: true, reply_expected: true })]),
  );
  assert.ok(addressed);
  assert.equal(skipReason(addressed.work[0]!, SELF), null);
});

test("parsePollWorkResponse: keeps attachment descriptors with an mxc url", () => {
  const parsed = parsePollWorkResponse(
    developResponse([
      developRow({
        body: "",
        is_from_agent: false,
        media: [
          {
            mxc_url: "mxc://s/1",
            msgtype: "m.image",
            filename: "cat.png",
            mimetype: "image/png",
            size: 12,
          },
          { mxc_url: "https://not-mxc" },
          "junk",
        ],
      }),
    ]),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.work[0]!.messages[0]!.media, [
    { mxc_url: "mxc://s/1", mimetype: "image/png", filename: "cat.png", size: 12 },
  ]);
});

test("parsePollWorkResponse: an empty media list is not an attachment", () => {
  const parsed = parsePollWorkResponse(
    developResponse([developRow({ body: "", is_from_agent: false, media: [] })]),
  );
  assert.ok(parsed);
  assert.equal(parsed.work[0]!.messages[0]!.body, "");
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

test("ambiguous outcome: held under the old cursor, offered again on a schedule, acked after the last", async () => {
  // A restart-recovered turn comes back as a duplicate with no output; its answer arrives through
  // the outbound send. The item is held, not acked on the second empty turn, and no turn runs while
  // it waits.
  const controller = new AbortController();
  let clock = 0;
  const offer = () =>
    okResult({ work: [itemFixture()], cursor: "c:1", truncated: false, acknowledged: 0 });
  const at: number[] = [
    0,
    10_000,
    AMBIGUOUS_HOLD_MS[0]! + 1,
    AMBIGUOUS_HOLD_MS[0]! + AMBIGUOUS_HOLD_MS[1]! + 2,
  ];
  let poll = 0;
  const { client, calls } = fakeClient([
    ...at.map(() => () => {
      clock = at[poll++]!;
      return Promise.resolve(offer());
    }),
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
    now: () => clock,
    holdPollMs: 0,
    initialCursor: "c:0",
  });
  // Offered at 0 (turn), 10s (held: no turn), 30s (turn), 120s (turn, then acked).
  assert.equal(dispatches, 3);
  const cursors = calls.map((c) => (c as { cursor?: string }).cursor);
  assert.deepEqual(cursors, ["c:0", "c:0", "c:0", "c:0", "c:1"]);
  const acks = calls.map((c) => (c as { ack?: string[] }).ack);
  assert.deepEqual(acks, [undefined, undefined, undefined, undefined, ["$e1"]]);
});

test("parsePollWorkResponse: keeps the room facts a newer server sends; blank names are left out", () => {
  const parsed = parsePollWorkResponse({
    work: [
      {
        kind: "message",
        channel_id: "!room:server",
        thread_id: null,
        is_backchannel: false,
        is_direct: false,
        channel_name: "Design review",
        loop_name: "Acme",
        sender_names: { "@ada:server": "Ada", "@bob:server": null, "@cy:server": " " },
        messages: [{ event_id: "$e1", sender: "@ada:server", body: "hi", timestamp: 1 }],
        reply_with: null,
      },
    ],
    cursor: "c:1",
  });
  assert.ok(parsed);
  const item = parsed.work[0]!;
  assert.equal(item.channel_name, "Design review");
  assert.equal(item.loop_name, "Acme");
  assert.deepEqual(item.sender_names, { "@ada:server": "Ada" });
});

test("restart: the first poll resumes from initialCursor, and each sent cursor is reported", async () => {
  // A poll the server was still holding when the gateway stopped can save a position past work
  // the gateway never got; resuming from what the gateway itself sent re-offers that work.
  const controller = new AbortController();
  const { client, calls } = fakeClient([
    okResult({ work: [], cursor: "c:8", truncated: false, acknowledged: 0 }),
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:9", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  const sent: string[] = [];
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
    initialCursor: "c:7",
    onCursorSent: (cursor) => sent.push(cursor),
  });
  assert.deepEqual(calls[0], { cursor: "c:7", ack: undefined, wait_seconds: 30, max_items: 1 });
  assert.deepEqual(calls[1], { cursor: "c:8", ack: undefined, wait_seconds: 30, max_items: 1 });
  assert.deepEqual(sent, ["c:7", "c:8"]);
});

test("no saved cursor: the first poll sends none and nothing is reported for it", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient([
    () => {
      controller.abort();
      return Promise.resolve(
        okResult({ work: [], cursor: "c:1", truncated: false, acknowledged: 0 }),
      );
    },
  ]);
  const sent: string[] = [];
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => ({ kind: "published" }),
    onCursorSent: (cursor) => sent.push(cursor),
  });
  assert.equal((calls[0] as { cursor?: string }).cursor, undefined);
  assert.deepEqual(sent, []);
});

// develop's poll_work: a delivered item is finished by a reply, an ack, or the next poll passing
// its delivery's cursor or a later one. Only the cursor from before its batch brings it back.
async function cursorsAfter(outcomes: DispatchOutcome[]): Promise<Array<string | undefined>> {
  const controller = new AbortController();
  const offer = (n: number) =>
    okResult({ work: [itemFixture()], cursor: `c:${n}`, truncated: false, acknowledged: 0 });
  const { client, calls } = fakeClient([
    ...outcomes.map((_, i) => offer(i + 1)),
    () => {
      controller.abort();
      return Promise.resolve(okResult({ work: [], cursor: "c:end", truncated: false }));
    },
  ]);
  let i = 0;
  await runPollLoop({
    client,
    abortSignal: controller.signal,
    log: () => {},
    dispatchItem: async () => outcomes[i++]!,
    backoffMs: () => 0,
    initialCursor: "c:0",
  });
  return calls.map((c) => (c as { cursor?: string }).cursor);
}

test("cursor: a published item advances it", async () => {
  assert.deepEqual(await cursorsAfter([{ kind: "published" }]), ["c:0", "c:1"]);
});

test("cursor: a reply to retry keeps the cursor from before its batch, so the item comes back", async () => {
  assert.deepEqual(
    await cursorsAfter([
      { kind: "retry", diagnostic: "transient: HTTP 502" },
      { kind: "published" },
    ]),
    ["c:0", "c:0", "c:2"],
  );
});

test("cursor: retries used up are acked and the cursor advances", async () => {
  const retry: DispatchOutcome = { kind: "retry", diagnostic: "transient: HTTP 502" };
  assert.deepEqual(await cursorsAfter(Array.from({ length: MAX_REPLY_ATTEMPTS }, () => retry)), [
    "c:0",
    "c:0",
    "c:0",
    `c:${MAX_REPLY_ATTEMPTS}`,
  ]);
});

test("cursor: silent and dropped items are acked and the cursor advances", async () => {
  assert.deepEqual(
    await cursorsAfter([{ kind: "silent" }, { kind: "dropped", diagnostic: "refused" }]),
    ["c:0", "c:1", "c:2"],
  );
});
