import assert from "node:assert/strict";
import { test } from "node:test";

import type { FilamentMcpClient, ToolCallResult } from "../../mcp-client.js";
import type { McpSettings } from "../../settings.js";
import type { WorkItem } from "../../work-item.js";
import type { TransportContext, TurnResult } from "../types.js";
import { classifyPublish, runPollTransport } from "./index.js";

const SELF = "@a_test1.1:example.test";
const PRINCIPAL = "@u_test1:example.test";
const CC = "!cc:example.test";
const ROOM = "!general:example.test";
const HUMAN = "@u_test2:example.test";
const BOT = "@a_test3.1:example.test";

const ok = (data: unknown): ToolCallResult => ({ ok: true, httpStatus: 200, data });

function msg(overrides: Record<string, unknown> = {}) {
  return { event_id: "$e1", sender: HUMAN, body: "hi", ts: 1, ...overrides };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    channel_id: ROOM,
    thread_id: null,
    is_backchannel: false,
    is_direct: false,
    messages: [msg()],
    reply_with: { tool: "reply_in_thread", args: { message_id: "$e1" } },
    ...overrides,
  };
}

async function run(
  polls: unknown[],
  opts: { control?: boolean; publish?: ToolCallResult; turn?: Partial<TurnResult> } = {},
) {
  const controller = new AbortController();
  const pollArgs: Array<{ ack?: string[] }> = [];
  const publishes: unknown[] = [];
  const turns: WorkItem[] = [];
  const events: string[] = [];
  const client = {
    pollWork: async (args: { ack?: string[] }) => {
      pollArgs.push(args);
      events.push("poll");
      const next = polls.shift();
      if (next === undefined) {
        controller.abort();
        return ok({ work: [], cursor: "c:end" });
      }
      return ok(next);
    },
    replyWith: async (spec: unknown, body: string) => {
      publishes.push({ spec, body });
      return opts.publish ?? ok({ event_id: "$reply" });
    },
    listPendingInvites: async () => {
      events.push("list_invites");
      return ok({ invites: [{ loop_id: "!loop:example.test" }] });
    },
    listVouches: async () => ok({ vouches: [] }),
    acceptInvite: async (id: string) => {
      events.push(`accept ${id}`);
      return ok({});
    },
    acceptVouch: async () => ok({}),
  };
  const ctx: TransportContext = {
    accountId: "writer",
    client: client as unknown as FilamentMcpClient,
    identity: { mxid: SELF, principal: PRINCIPAL, ccRoomId: CC },
    settings: { pollWaitSeconds: 30 } as unknown as McpSettings,
    control: opts.control ?? false,
    abortSignal: controller.signal,
    log: () => {},
    runTurn: async (workItem) => {
      turns.push(workItem);
      return {
        finalText: "the reply",
        sawFinal: true,
        sawSkip: false,
        sawError: false,
        repliedTo: new Set(),
        ...opts.turn,
      };
    },
    handleControl: async () => {},
  };
  const result = await runPollTransport(ctx);
  return { result, pollArgs, publishes, turns, events };
}

const offer = (work: unknown) => ({ work: [work], cursor: "c:1" });

test("poll: accepts pending invites at start, before the first poll", async () => {
  const h = await run([]);
  assert.deepEqual(h.events.slice(0, 3), ["list_invites", "accept !loop:example.test", "poll"]);
});

test("poll: a control account never sweeps invites", async () => {
  const h = await run([], { control: true });
  assert.equal(h.events.includes("list_invites"), false);
});

test("poll: an invites hint in a poll result triggers a sweep", async () => {
  const h = await run([{ work: [], cursor: "c:1", invites: [{ room_id: "!loop:x" }] }]);
  assert.deepEqual(h.events, [
    "list_invites",
    "accept !loop:example.test",
    "poll",
    "list_invites",
    "accept !loop:example.test",
    "poll",
  ]);
});

test("poll: a reply the server refuses is ack'd and the loop goes on", async () => {
  const refused: ToolCallResult = {
    ok: false,
    httpStatus: 200,
    kind: "tool",
    error: { code: -32004, message: "This agent is paused by its principal" },
  };
  const h = await run([offer(item()), { work: [], cursor: "c:2" }], { publish: refused });
  assert.equal(h.result.fatal, undefined);
  assert.equal(h.publishes.length, 1);
  assert.deepEqual(h.pollArgs[1]!.ack, ["$e1"]);
  assert.equal(h.pollArgs.length, 3);
});

test("poll: a turn that fails is ack'd without a publish, as over FCM", async () => {
  const h = await run([offer(item())], {
    turn: { sawError: true, sawFinal: false, errorDetail: "model: 500" },
  });
  assert.equal(h.result.fatal, undefined);
  assert.equal(h.publishes.length, 0);
  assert.deepEqual(h.pollArgs[1]!.ack, ["$e1"]);
});

test("poll: a publish that rejects the bearer stops the account", async () => {
  const revoked: ToolCallResult = {
    ok: false,
    httpStatus: 401,
    kind: "auth",
    error: { code: -32001, message: "HTTP 401" },
  };
  const h = await run([offer(item())], { publish: revoked });
  assert.equal(h.result.fatal, "auth: HTTP 401");
  assert.equal(h.pollArgs.length, 1);
});

test("poll: another agent's message without a mention is ack'd without a turn", async () => {
  const h = await run([offer(item({ messages: [msg({ sender: BOT, sender_is_agent: true })] }))]);
  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.pollArgs[1]!.ack, ["$e1"]);
});

test("poll: another agent's message that mentions the agent runs a turn", async () => {
  const h = await run([
    offer(item({ messages: [msg({ sender: BOT, sender_is_agent: true, is_mention: true })] })),
  ]);
  assert.equal(h.turns.length, 1);
  assert.equal(h.publishes.length, 1);
});

test("poll: another agent's message the server judged aimed here and wanting a reply runs a turn", async () => {
  const h = await run([
    offer(
      item({
        messages: [
          msg({
            sender: BOT,
            sender_is_agent: true,
            is_implicitly_mentioned: true,
            reply_expected: true,
          }),
        ],
      }),
    ),
  ]);
  assert.equal(h.turns.length, 1);
});

test("poll: another agent's message judged aimed here but wanting no reply is ack'd", async () => {
  const h = await run([
    offer(
      item({
        messages: [
          msg({
            sender: BOT,
            sender_is_agent: true,
            is_implicitly_mentioned: true,
            reply_expected: false,
          }),
        ],
      }),
    ),
  ]);
  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.pollArgs[1]!.ack, ["$e1"]);
});

test("poll: a system notice is ack'd without a turn", async () => {
  const h = await run([offer(item({ messages: [msg({ sender: "@filament_god:example.test" })] }))]);
  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.pollArgs[1]!.ack, ["$e1"]);
});

test("poll: an item with a human and an agent message runs a turn", async () => {
  const h = await run([
    offer(
      item({
        messages: [
          msg({ event_id: "$a", sender: BOT, sender_is_agent: true }),
          msg({ event_id: "$h", sender: HUMAN }),
        ],
      }),
    ),
  ]);
  assert.equal(h.turns.length, 1);
});

test("poll: a DM from another agent without a mention is ack'd without a turn", async () => {
  const h = await run([
    offer(item({ is_direct: true, messages: [msg({ sender: BOT, sender_is_agent: true })] })),
  ]);
  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.pollArgs[1]!.ack, ["$e1"]);
});

test("poll: a DM from a person runs a turn, flagged as direct", async () => {
  const h = await run([offer(item({ is_direct: true, messages: [msg()] }))]);
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0]!.is_direct, true);
});

test("classifyPublish: what each publish result means for the item", () => {
  assert.equal(classifyPublish(ok({ event_id: "$r" })).kind, "published");
  assert.equal(classifyPublish(ok({ error: "message_id $x not found" })).kind, "dropped");
  assert.equal(classifyPublish(ok({})).kind, "retry");
  const failed = (kind: ToolCallResult["kind"]): ToolCallResult => ({
    ok: false,
    httpStatus: 502,
    kind,
    error: { code: -1, message: "x" },
  });
  assert.equal(classifyPublish(failed("tool")).kind, "dropped");
  assert.equal(classifyPublish(failed("transient")).kind, "retry");
  assert.equal(classifyPublish(failed("protocol")).kind, "retry");
  assert.equal(classifyPublish(failed("auth")).kind, "fatal");
});
