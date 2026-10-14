import assert from "node:assert/strict";
import { test } from "node:test";

import { FALLBACK_HELLO, helloDue, helloPrompt, sayFirstHello } from "./hello.js";
import type { TurnResult } from "./transports/types.js";
import type { WorkItem } from "./work-item.js";

const IDENTITY = { mxid: "@carl:filament.dm", principal: "@owner:filament.dm", ccRoomId: "!cc:x" };

test("helloDue: on the server's first contact, or as a Filament agent new to this account", () => {
  const base = { mxid: "@carl:x", helloSentAs: undefined };
  // A sign-in the gateway finished: nothing known about the account yet.
  assert.equal(helloDue({ ...base, instructions: "", previousMxid: undefined }), true);
  // A reconnect of an agent that already spoke: no.
  assert.equal(helloDue({ ...base, instructions: "Hi.", previousMxid: "@carl:x" }), false);
  // The server says it has not posted in its backchannel yet: yes.
  assert.equal(
    helloDue({ ...base, instructions: "Hi.\n\nFirst contact: say hi.", previousMxid: "@carl:x" }),
    true,
  );
  // A new login made the account a different Filament agent: yes.
  assert.equal(helloDue({ ...base, instructions: "", previousMxid: "@old:x" }), true);
  // Never twice for the same account and agent.
  assert.equal(
    helloDue({
      instructions: "First contact: hi.",
      mxid: "@carl:x",
      previousMxid: undefined,
      helloSentAs: "@carl:x",
    }),
    false,
  );
});

function turnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    finalText: "Hi! I'm Carl, your raccoon familiar. I'm listening here.",
    mediaUrls: [],
    agentId: "main",
    sawFinal: true,
    sawSkip: false,
    sawError: false,
    repliedTo: new Set(),
    mediaLocalRoots: [],
    ...overrides,
  };
}

async function hello(result: TurnResult | Error | "hang", sayOk = true) {
  const turns: WorkItem[] = [];
  const said: string[] = [];
  const logs: string[] = [];
  const outcome = await sayFirstHello({
    identity: IDENTITY,
    runTurn: async (item) => {
      turns.push(item);
      if (result === "hang") return new Promise<TurnResult>(() => {});
      if (result instanceof Error) throw result;
      return result;
    },
    say: async (body) => {
      said.push(body);
      return sayOk;
    },
    log: (line) => void logs.push(line),
    now: () => 42,
    timeoutMs: 20,
  });
  return { outcome, turns, said, logs };
}

test("sayFirstHello: one backchannel turn in the agent's voice, its reply posted there", async () => {
  const run = await hello(turnResult());
  assert.equal(run.outcome, "turn");
  assert.deepEqual(run.turns, [
    {
      channel_id: "!cc:x",
      thread_id: null,
      is_backchannel: true,
      messages: [
        {
          event_id: "first-hello:@carl:filament.dm",
          sender: "@owner:filament.dm",
          body: helloPrompt(),
          ts: 42,
        },
      ],
    },
  ]);
  assert.deepEqual(run.said, ["Hi! I'm Carl, your raccoon familiar. I'm listening here."]);
  assert.match(helloPrompt(), /name your owner knows you by/);
  // The profile is seeded in code: the agent is told its name, not asked to set it.
  assert.doesNotMatch(helloPrompt(), /set_profile|profile name is/);
  assert.match(helloPrompt("Carl"), /Your Filament profile name is now "Carl"\./);
});

test("sayFirstHello: an agent that posted the hello itself is not echoed", async () => {
  const run = await hello(turnResult({ repliedTo: new Set(["backchannel"]) }));
  assert.equal(run.outcome, "tool");
  assert.deepEqual(run.said, []);
});

test("sayFirstHello: a turn that fails, says nothing or hangs falls back to the fixed hello", async () => {
  for (const result of [
    new Error("model down"),
    turnResult({ sawError: true }),
    turnResult({ finalText: "  ", sawFinal: false, sawSkip: true }),
    "hang" as const,
  ]) {
    const run = await hello(result);
    assert.equal(run.outcome, "fallback");
    assert.deepEqual(run.said, [FALLBACK_HELLO]);
  }
});

test("sayFirstHello: nothing landed is a failure, tried again next connect; no backchannel skips", async () => {
  const run = await hello(turnResult(), false);
  assert.equal(run.outcome, "failed");
  assert.equal(run.said.length, 2);

  const turns: WorkItem[] = [];
  const skipped = await sayFirstHello({
    identity: { mxid: "@carl:x", principal: "@o:x" },
    runTurn: async (item) => (turns.push(item), turnResult()),
    say: async () => true,
    log: () => {},
  });
  assert.equal(skipped, "skipped");
  assert.equal(turns.length, 0);
});
