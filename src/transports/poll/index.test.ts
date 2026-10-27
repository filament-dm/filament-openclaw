import assert from "node:assert/strict";
import { test } from "node:test";

import type { FilamentMcpClient, ToolCallResult } from "../../mcp-client.js";
import type { McpSettings } from "../../settings.js";
import { clearInterruptedIn, loadInFlight, releaseInterruptedIn } from "../../state/in-flight.js";
import { loadPendingReplies } from "../../state/pending-replies.js";
import { useMemoryState } from "../../state/store.js";
import type { WorkItem } from "../../work-item.js";
import type { TransportContext, TurnResult } from "../types.js";
import {
  classifyPublish,
  type PollTransportDeps,
  RECOVERY_HOLD_MS,
  runPollTransport,
} from "./index.js";

// The poll transport saves its cursor; keep it out of a real gateway's state.
useMemoryState();

const SELF = "@a_test1.1:example.test";
const PRINCIPAL = "@u_test1:example.test";
const CC = "!cc:example.test";
const ROOM = "!general:example.test";
const HUMAN = "@u_test2:example.test";
const BOT = "@a_test3.1:example.test";

const ok = (data: unknown): ToolCallResult => ({ ok: true, httpStatus: 200, data });

function msg(overrides: Record<string, unknown> = {}) {
  return { event_id: "$e1", sender: HUMAN, body: "hi", timestamp: 1, ...overrides };
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
  opts: {
    publish?: ToolCallResult | ((n: number) => ToolCallResult);
    turn?: Partial<TurnResult>;
    deps?: PollTransportDeps;
    accountId?: string;
    /** As if the gateway began shutting down while the turn ran. */
    abortDuringTurn?: boolean;
  } = {},
) {
  const controller = new AbortController();
  const pollArgs: Array<{ ack?: string[] }> = [];
  const publishes: unknown[] = [];
  const turns: WorkItem[] = [];
  const turnMedia: unknown[] = [];
  const events: string[] = [];
  const notes: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client = {
    callTool: async (tool: string, args: Record<string, unknown> = {}) => {
      notes.push({ tool, args });
      return ok({ event_id: "$note" });
    },
    pollWork: async (args: { ack?: string[] }) => {
      pollArgs.push(args);
      events.push("poll");
      const shifted = polls.shift();
      const next = typeof shifted === "function" ? (shifted as () => unknown)() : shifted;
      if (next === undefined) {
        controller.abort();
        return ok({ work: [], cursor: "c:end" });
      }
      return ok(next);
    },
    replyWith: async (spec: unknown, body: string, _opts: unknown, attachments: unknown = []) => {
      publishes.push({ spec, body, attachments });
      const p = opts.publish;
      return (typeof p === "function" ? p(publishes.length) : p) ?? ok({ event_id: "$reply" });
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
    accountId: opts.accountId ?? "writer",
    client: client as unknown as FilamentMcpClient,
    identity: { mxid: SELF, principal: PRINCIPAL, ccRoomId: CC },
    settings: { pollWaitSeconds: 30 } as unknown as McpSettings,
    abortSignal: controller.signal,
    log: () => {},
    runTurn: async (workItem, media) => {
      turns.push(workItem);
      turnMedia.push(media);
      if (opts.abortDuringTurn) controller.abort();
      return {
        finalText: "the reply",
        mediaUrls: [],
        agentId: "writer",
        mediaLocalRoots: [],
        sawFinal: true,
        sawSkip: false,
        sawError: false,
        repliedTo: new Set(),
        ...opts.turn,
      };
    },
  };
  const result = await runPollTransport(ctx, opts.deps);
  return { result, pollArgs, publishes, turns, turnMedia, events, notes };
}

const offer = (work: unknown) => ({ work: [work], cursor: "c:1" });

test("poll: accepts pending invites at start, before the first poll", async () => {
  const h = await run([]);
  assert.deepEqual(h.events.slice(0, 3), ["list_invites", "accept !loop:example.test", "poll"]);
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
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.tool, "message_principal");
});

test("poll: OpenClaw's error reply in a group posts nothing there; the principal hears instead", async () => {
  const error = "⚠️ The AI service returned an empty reply. Please try again.";
  const h = await run([offer(item({ channel_name: "Design review" }))], {
    turn: {
      sawError: true,
      sawFinal: false,
      finalText: "",
      errorReplyText: error,
      errorDetail: `OpenClaw error reply: ${error}`,
    },
  });
  assert.equal(h.result.fatal, undefined);
  assert.equal(h.publishes.length, 0);
  assert.deepEqual(h.pollArgs[1]!.ack, ["$e1"]);
  assert.deepEqual(h.notes, [
    {
      tool: "message_principal",
      args: {
        markdown_body: `I couldn't answer a message in Design review, so I posted nothing there. OpenClaw said: ${error}`,
      },
    },
  ]);
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
  const h = await run([offer(item({ messages: [msg({ sender: BOT, is_from_agent: true })] }))]);
  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.pollArgs[1]!.ack, ["$e1"]);
});

test("poll: another agent's message that mentions the agent runs a turn", async () => {
  const h = await run([
    offer(item({ messages: [msg({ sender: BOT, is_from_agent: true, is_mention: true })] })),
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
            is_from_agent: true,
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
            is_from_agent: true,
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
          msg({ event_id: "$a", sender: BOT, is_from_agent: true }),
          msg({ event_id: "$h", sender: HUMAN }),
        ],
      }),
    ),
  ]);
  assert.equal(h.turns.length, 1);
});

test("poll: a DM from another agent without a mention is ack'd without a turn", async () => {
  const h = await run([
    offer(item({ is_direct: true, messages: [msg({ sender: BOT, is_from_agent: true })] })),
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

test("poll: an item's attachments are fetched and handed to the turn", async () => {
  const fetched: unknown[] = [];
  const saved = [{ path: "/media/cat.png", contentType: "image/png", messageId: "$e1" }];
  const h = await run(
    [offer(item({ messages: [msg({ body: "", media: [{ mxc_url: "mxc://s/cat" }] })] }))],
    {
      deps: {
        fetchInboundMedia: async (_client, messages) => {
          fetched.push(messages.map((m) => m.media));
          return saved;
        },
      },
    },
  );
  assert.deepEqual(fetched, [[[{ mxc_url: "mxc://s/cat" }]]]);
  assert.deepEqual(h.turnMedia, [saved]);
});

test("poll: media in the reply is uploaded and sent as attachments", async () => {
  const uploaded: unknown[] = [];
  const h = await run([offer(item())], {
    turn: { mediaUrls: ["/work/chart.png"], mediaLocalRoots: ["/work"] },
    deps: {
      uploadOutboundMedia: async (_client, urls, opts) => {
        uploaded.push({ urls, roots: opts.mediaLocalRoots });
        return [{ mxc_url: "mxc://s/chart", filename: "chart.png" }];
      },
    },
  });
  assert.deepEqual(uploaded, [{ urls: ["/work/chart.png"], roots: ["/work"] }]);
  assert.deepEqual(h.publishes, [
    {
      spec: { tool: "reply_in_thread", args: { message_id: "$e1" } },
      body: "the reply",
      attachments: [{ mxc_url: "mxc://s/chart", filename: "chart.png" }],
    },
  ]);
});

test("poll: a media-only reply whose media all fails to send is dropped, not posted empty", async () => {
  const h = await run([offer(item())], {
    turn: { finalText: "", mediaUrls: ["/elsewhere/x.png"] },
    deps: { uploadOutboundMedia: async () => [] },
  });
  assert.deepEqual(h.publishes, []);
  assert.deepEqual(h.pollArgs[1]?.ack, ["$e1"]);
});

const transient: ToolCallResult = {
  ok: false,
  httpStatus: 0,
  kind: "transient",
  error: { code: -1, message: "timed out" },
};

test("poll: an answer ready as the gateway shuts down is still posted, on its own short clock", async () => {
  const h = await run([offer(item())], { accountId: "shutdown-ok", abortDuringTurn: true });
  assert.equal(h.publishes.length, 1);
  assert.equal((h.publishes[0] as { body: string }).body, "the reply");
  assert.deepEqual(loadPendingReplies("shutdown-ok", SELF), []);
});

test("poll: an answer that can't be posted at shutdown is kept, and posted on the next start", async () => {
  const first = await run([offer(item())], {
    accountId: "shutdown-kept",
    abortDuringTurn: true,
    publish: transient,
  });
  assert.equal(first.publishes.length, 1);
  const kept = loadPendingReplies("shutdown-kept", SELF);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.text, "the reply");
  assert.deepEqual(kept[0]!.eventIds, ["$e1"]);

  // The restarted gateway posts it before its first poll, and forgets it.
  const second = await run([], { accountId: "shutdown-kept" });
  assert.equal(second.publishes.length, 1);
  assert.equal(second.turns.length, 0);
  assert.deepEqual(loadPendingReplies("shutdown-kept", SELF), []);
});

test("poll: a redelivered item whose answer was kept is answered from the kept reply, no turn", async () => {
  await run([offer(item())], {
    accountId: "kept-redelivered",
    abortDuringTurn: true,
    publish: transient,
  });
  assert.equal(loadPendingReplies("kept-redelivered", SELF).length, 1);
  // The start-up post fails again; the item comes back and is answered from the store.
  const h = await run([offer(item())], {
    accountId: "kept-redelivered",
    publish: (n) => (n === 1 ? transient : ok({ event_id: "$reply" })),
  });
  assert.equal(h.turns.length, 0);
  assert.equal(h.publishes.length, 2);
  assert.deepEqual(loadPendingReplies("kept-redelivered", SELF), []);
});

test("poll: a kept reply is per agent: another agent on the account never posts it", async () => {
  await run([offer(item())], {
    accountId: "kept-other",
    abortDuringTurn: true,
    publish: transient,
  });
  assert.equal(loadPendingReplies("kept-other", "@someone-else:example.test").length, 0);
});

const nothing: Partial<TurnResult> = { finalText: "", sawFinal: false };

test("poll: a turn that produced nothing leaves its marker; one that answered leaves none", async () => {
  await run([offer(item())], { accountId: "marker-answered" });
  assert.deepEqual(loadInFlight("marker-answered", SELF), []);
  await run([offer(item())], { accountId: "marker-nothing", turn: nothing });
  assert.deepEqual(
    loadInFlight("marker-nothing", SELF).map((t) => t.eventId),
    ["$e1"],
  );
});

test("poll: after a restart, a cut-short turn is held for OpenClaw's recovery; its answer ends the hold", async () => {
  // The last gateway's turn produced nothing as it went down: its marker survives.
  await run([offer(item())], { accountId: "recovering", turn: nothing });
  // The new gateway is offered the message again. Nothing runs while OpenClaw recovers the turn;
  // the recovered answer (the outbound send) names the message, which ends the hold.
  const h = await run(
    [
      offer(item()),
      offer(item()),
      () => {
        clearInterruptedIn("recovering", ROOM);
        return { work: [], cursor: "c:2" };
      },
    ],
    { accountId: "recovering", deps: { holdPollMs: 0 } },
  );
  assert.equal(h.turns.length, 0);
  assert.equal(h.publishes.length, 0);
  // Held, not acked.
  assert.equal(
    h.pollArgs.some((a) => a.ack?.length),
    false,
  );
  assert.deepEqual(loadInFlight("recovering", SELF), []);
});

test("poll: with no recovered answer in time, the held message is dispatched after all", async () => {
  await run([offer(item())], { accountId: "unrecovered", turn: nothing });
  let clock = Date.now();
  const h = await run(
    [
      offer(item()),
      () => {
        clock += RECOVERY_HOLD_MS + 1;
        return offer(item());
      },
    ],
    { accountId: "unrecovered", deps: { holdPollMs: 0, now: () => clock } },
  );
  assert.equal(h.turns.length, 1);
  assert.equal(h.publishes.length, 1);
  assert.deepEqual(loadInFlight("unrecovered", SELF), []);
});

test("poll: a held restart blocks other messages too, so nothing races the recovery claim", async () => {
  await run([offer(item())], { accountId: "blocks-others", turn: nothing });
  const h = await run(
    [
      offer(item({ messages: [msg({ event_id: "$other" })] })),
      () => {
        clearInterruptedIn("blocks-others", ROOM);
        return offer(item({ messages: [msg({ event_id: "$other" })] }));
      },
    ],
    { accountId: "blocks-others", deps: { holdPollMs: 0 } },
  );
  // Held on the first offer; dispatched once the recovered answer landed.
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0]!.messages[0]!.event_id, "$other");
});

test("poll: once OpenClaw's recovery has posted to the room, held work goes ahead after the grace", async () => {
  await run([offer(item())], { accountId: "released", turn: nothing });
  let clock = Date.now();
  const other = item({ messages: [msg({ event_id: "$other" })] });
  const h = await run(
    [
      offer(other),
      () => {
        // The recovery's first post (its announce) names the interrupted message and releases it.
        releaseInterruptedIn("released", ROOM, clock + 5_000);
        return offer(other);
      },
      () => {
        clock += 5_001;
        return offer(other);
      },
    ],
    { accountId: "released", deps: { holdPollMs: 0, now: () => clock } },
  );
  // Held twice (before the post, and inside the grace), then dispatched.
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0]!.messages[0]!.event_id, "$other");
  assert.deepEqual(loadInFlight("released", SELF), []);
});
