import assert from "node:assert/strict";
import { test } from "node:test";

import type { TurnOptions, TurnResult } from "../types.js";
import { runTurnWithStartDeadline } from "./turn-deadline.js";

const answer = (overrides: Partial<TurnResult> = {}): TurnResult => ({
  finalText: "the reply",
  mediaUrls: [],
  agentId: "main",
  mediaLocalRoots: [],
  sawFinal: true,
  sawSkip: false,
  sawError: false,
  repliedTo: new Set(),
  reacted: false,
  posted: [],
  ...overrides,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});
const quick = {
  abortSignal: new AbortController().signal,
  startTimeoutMs: 30,
  idleTimeoutMs: 60,
  settleMs: 20,
  heartbeatMs: 10_000,
};

test("turn deadline: a turn that finishes in time gives its result and its steps", async () => {
  const watched = await runTurnWithStartDeadline(async (opts) => {
    opts.onProgress?.("record:done");
    opts.onProgress?.("run:start");
    opts.onProgress?.("deliver:final");
    return answer();
  }, quick);
  assert.equal(watched.kind, "result");
  assert.match(watched.trail, /^record:done@\S+s run:start@\S+s deliver:final@\S+s$/);
});

test("turn deadline: after its run starts, a turn that keeps moving may outlast both deadlines", async () => {
  for (const step of ["run:start", "model:selected"]) {
    const watched = await runTurnWithStartDeadline(async (opts: TurnOptions) => {
      opts.onProgress?.(step);
      for (let i = 0; i < 5; i++) {
        await sleep(25);
        opts.onProgress?.("deliver:tool");
      }
      return answer();
    }, quick);
    assert.equal(watched.kind, "result", step);
  }
});

test("turn deadline: an error thrown in time is thrown", async () => {
  await assert.rejects(
    runTurnWithStartDeadline(async () => {
      throw new Error("Agent main has not completed startup inspection");
    }, quick),
    /startup inspection/,
  );
});

test("turn deadline: a turn that never starts is aborted and reported stuck with its last step", async () => {
  let aborted = false;
  const watched = await runTurnWithStartDeadline((opts) => {
    opts.onProgress?.("record:start");
    opts.onProgress?.("record:done");
    opts.abortSignal?.addEventListener("abort", () => (aborted = true));
    return never();
  }, quick);
  assert.equal(watched.kind, "stuck");
  assert.ok(watched.kind === "stuck");
  assert.equal(watched.started, false);
  assert.equal(watched.lastStep, "record:done");
  assert.equal(watched.settled, false);
  assert.equal(aborted, true);
});

test("turn deadline: a run that starts and then goes quiet is aborted and reported stuck", async () => {
  let aborted = false;
  const lines: string[] = [];
  const watched = await runTurnWithStartDeadline(
    (opts) => {
      opts.onProgress?.("dispatch:start");
      opts.onProgress?.("model:selected");
      opts.abortSignal?.addEventListener("abort", () => (aborted = true));
      return never();
    },
    { ...quick, log: (line) => lines.push(line) },
  );
  assert.ok(watched.kind === "stuck");
  assert.equal(watched.started, true);
  assert.equal(watched.lastStep, "model:selected");
  assert.equal(aborted, true);
  assert.match(lines[0]!, /the agent's run started after .* s \(model:selected\)/);
});

test("turn deadline: a turn still running is reported on each heartbeat", async () => {
  const lines: string[] = [];
  await runTurnWithStartDeadline(
    async (opts) => {
      opts.onProgress?.("record:done");
      await sleep(25);
      return answer();
    },
    { ...quick, heartbeatMs: 8, log: (line) => lines.push(line) },
  );
  assert.ok(
    lines.some((l) =>
      /turn still running after .* s \(run not started; last step: record:done\)/.test(l),
    ),
  );
});

test("turn deadline: a stuck turn that ends on the abort is stuck, and settled", async () => {
  const watched = await runTurnWithStartDeadline(
    (opts) =>
      new Promise<TurnResult>((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    quick,
  );
  assert.ok(watched.kind === "stuck");
  assert.equal(watched.settled, true);
  assert.equal(watched.trail, "no steps");
});

test("turn deadline: an answer that lands while the stuck turn settles is still used", async () => {
  const watched = await runTurnWithStartDeadline(
    (opts) =>
      new Promise<TurnResult>((resolve) => {
        opts.abortSignal?.addEventListener("abort", () => resolve(answer()));
      }),
    quick,
  );
  assert.equal(watched.kind, "result");
});

test("turn deadline: the transport's own abort reaches the turn", async () => {
  const shutdown = new AbortController();
  let seen: AbortSignal | undefined;
  const watched = runTurnWithStartDeadline(
    async (opts) => {
      seen = opts.abortSignal;
      opts.onProgress?.("run:start");
      await sleep(10);
      return answer();
    },
    { ...quick, abortSignal: shutdown.signal },
  );
  shutdown.abort();
  assert.equal(seen?.aborted, true);
  assert.equal((await watched).kind, "result");
});
