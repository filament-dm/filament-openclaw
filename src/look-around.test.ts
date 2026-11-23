import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOOK_AROUND_OPENING,
  LOOK_AROUND_STATUS,
  lookAroundDue,
  lookAroundOnce,
  lookAroundPrompt,
  type LookAroundContext,
} from "./look-around.js";
import { lookAroundDueFor, markLookAroundDue, takeLookAroundDue } from "./state/hello.js";
import { useMemoryState } from "./state/store.js";
import type { TurnOptions, TurnResult } from "./transports/types.js";
import type { WorkItem } from "./work-item.js";

useMemoryState();

const IDENTITY = { mxid: "@carl:filament.dm", principal: "@owner:filament.dm", ccRoomId: "!cc:x" };
const WRITE_UP = `${LOOK_AROUND_OPENING} It is a chat where agents are members.\n\n**Owners**: …`;

function turnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    finalText: "Done.",
    mediaUrls: [],
    agentId: "main",
    sawFinal: true,
    sawSkip: false,
    sawError: false,
    repliedTo: new Set(["backchannel"]),
    reacted: false,
    posted: [],
    mediaLocalRoots: [],
    ...overrides,
  };
}

let accounts = 0;

async function look(
  result: TurnResult | Error | "hang",
  overrides: Partial<LookAroundContext> & { owedTo?: string | null; sayOk?: boolean } = {},
) {
  const accountId = `account-${accounts++}`;
  const { owedTo = IDENTITY.mxid, sayOk = true, ...ctx } = overrides;
  if (owedTo !== null) markLookAroundDue(accountId, owedTo);
  const turns: Array<{ item: WorkItem; opts: TurnOptions }> = [];
  const statuses: Array<string | null> = [];
  const said: string[] = [];
  const logs: string[] = [];
  const outcome = await lookAroundOnce({
    identity: IDENTITY,
    due: { peek: () => lookAroundDueFor(accountId), take: () => takeLookAroundDue(accountId) },
    abortSignal: new AbortController().signal,
    runTurn: async (item, opts) => {
      turns.push({ item, opts });
      if (result === "hang") return new Promise<TurnResult>(() => {});
      if (result instanceof Error) throw result;
      opts.onProgress?.("run:start");
      return result;
    },
    setStatus: async (text) => void statuses.push(text),
    say: async (body) => {
      said.push(body);
      return sayOk;
    },
    log: (line) => void logs.push(line),
    now: () => 42,
    startTimeoutMs: 20,
    idleTimeoutMs: 20,
    settleMs: 5,
    reloadGraceMs: 20,
    ...ctx,
  });
  return { outcome, turns, statuses, said, logs, stillDue: lookAroundDueFor(accountId) };
}

test("lookAroundDue: only when the server asks for a first contact", () => {
  assert.equal(lookAroundDue("Hi.\n\nFirst contact: say hi."), true);
  // An agent that already posted in its backchannel: a reconnect, or one new to this gateway.
  assert.equal(lookAroundDue("Hi."), false);
  assert.equal(lookAroundDue(""), false);
  assert.equal(lookAroundDue(undefined), false);
});

test("lookAroundPrompt: the guides' step, with OpenClaw's tool names and the backchannel's id", () => {
  const prompt = lookAroundPrompt("!cc:x");
  assert.match(prompt, /^\[system: This is the gateway, not your owner\./);
  assert.match(prompt, /`filament_set_status` with `channel` = `!cc:x`/);
  assert.match(prompt, /`status_text` = `Looking around Filament…`/);
  assert.match(prompt, /https:\/\/filament\.dm\/llms\.txt/);
  assert.match(prompt, /Call `filament_get_settings` and `filament_list_channels` too\./);
  assert.match(prompt, /with `filament_message_principal`/);
  assert.match(prompt, /Open with "I took a look around Filament\."/);
  assert.match(prompt, /If any step fails, skip the rest and say nothing about it\./);
  // Every tool it names is one the agent has: none without the OpenClaw prefix.
  assert.doesNotMatch(prompt, /`(set_status|message_principal|get_settings|list_channels)`/);
  assert.doesNotMatch(prompt, /—/);
});

test("lookAroundOnce: one side turn in the backchannel, with a status while the agent looks", async () => {
  const run = await look(turnResult());
  assert.equal(run.outcome, "tool");
  assert.deepEqual(
    run.turns.map((t) => t.item),
    [
      {
        channel_id: "!cc:x",
        thread_id: null,
        is_backchannel: true,
        messages: [
          {
            event_id: "look-around:@carl:filament.dm",
            sender: "@owner:filament.dm",
            body: lookAroundPrompt("!cc:x"),
            ts: 42,
          },
        ],
      },
    ],
  );
  assert.ok(run.turns[0]!.opts.abortSignal);
  assert.deepEqual(run.statuses, [LOOK_AROUND_STATUS, null]);
  // The agent posted it with the tool: nothing is posted for it.
  assert.deepEqual(run.said, []);
  assert.equal(run.stillDue, undefined);
});

test("lookAroundOnce: a write-up left as the final reply is posted for the agent", async () => {
  const run = await look(turnResult({ finalText: WRITE_UP, repliedTo: new Set() }));
  assert.equal(run.outcome, "turn");
  assert.deepEqual(run.said, [WRITE_UP]);
});

test("lookAroundOnce: nothing owed runs nothing", async () => {
  const run = await look(turnResult(), { owedTo: null });
  assert.equal(run.outcome, "none");
  assert.equal(run.turns.length, 0);
  assert.deepEqual(run.statuses, []);
});

test("lookAroundOnce: at most once, also when it fails; failures say nothing", async () => {
  for (const result of [
    new Error("model down"),
    "hang" as const,
    turnResult({ sawError: true, finalText: WRITE_UP, repliedTo: new Set() }),
    // A final reply that is not the write-up is never posted.
    turnResult({ finalText: "Sorry, I could not fetch the page.", repliedTo: new Set() }),
    turnResult({ finalText: "", sawFinal: false, sawSkip: true, repliedTo: new Set() }),
  ]) {
    const run = await look(result);
    assert.equal(run.outcome, "failed");
    assert.deepEqual(run.said, []);
    // The status is cleared whatever happened, and the marker is gone: no second try.
    assert.deepEqual(run.statuses, [LOOK_AROUND_STATUS, null]);
    assert.equal(run.stillDue, undefined);
  }

  // The marker is taken as the look starts: a second start finds nothing to do.
  const accountId = "account-twice";
  markLookAroundDue(accountId, IDENTITY.mxid);
  const due = {
    peek: () => lookAroundDueFor(accountId),
    take: () => takeLookAroundDue(accountId),
  };
  const first = await look(turnResult(), { owedTo: null, due });
  const second = await look(turnResult(), { owedTo: null, due });
  assert.deepEqual([first.outcome, second.outcome], ["tool", "none"]);
  assert.equal(second.turns.length, 0);
});

test("lookAroundOnce: a failing status, or a post that does not land, stays quiet", async () => {
  const noStatus = await look(turnResult(), {
    setStatus: async () => {
      throw new Error("set_status: not offered");
    },
  });
  assert.equal(noStatus.outcome, "tool");

  const lost = await look(turnResult({ finalText: WRITE_UP, repliedTo: new Set() }), {
    sayOk: false,
  });
  assert.equal(lost.outcome, "failed");

  const throws = await look(turnResult({ finalText: WRITE_UP, repliedTo: new Set() }), {
    say: async () => {
      throw new Error("network");
    },
  });
  assert.equal(throws.outcome, "failed");
});

test("lookAroundOnce: owed to another agent, or with no backchannel, it is dropped", async () => {
  const other = await look(turnResult(), { owedTo: "@old:filament.dm" });
  assert.equal(other.outcome, "skipped");
  assert.equal(other.turns.length, 0);
  assert.equal(other.stillDue, undefined);

  const noRoom = await look(turnResult(), {
    identity: { mxid: IDENTITY.mxid, principal: IDENTITY.principal },
  });
  assert.equal(noRoom.outcome, "skipped");
  assert.equal(noRoom.turns.length, 0);
});

test("lookAroundOnce: a reload on its way is waited for, and the look stays owed to the next start", async () => {
  // The config write reloads the account: it stops before the look starts, marker untouched.
  const reload = new AbortController();
  setTimeout(() => reload.abort(), 5);
  const cut = await look(turnResult(), {
    reloadExpected: Promise.resolve(true),
    abortSignal: reload.signal,
    reloadGraceMs: 5_000,
  });
  assert.equal(cut.outcome, "deferred");
  assert.equal(cut.turns.length, 0);
  assert.deepEqual(cut.statuses, []);
  assert.equal(cut.stillDue, IDENTITY.mxid);

  // No reload came within the grace: go ahead.
  const stayed = await look(turnResult(), { reloadExpected: Promise.resolve(true) });
  assert.equal(stayed.outcome, "tool");

  // No config write, or one whose outcome is unknown: no wait.
  const none = await look(turnResult(), {
    reloadExpected: Promise.reject(new Error("cli")),
    reloadGraceMs: 60_000,
  });
  assert.equal(none.outcome, "tool");
});
