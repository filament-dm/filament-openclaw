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
  ...overrides,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});
const quick = { abortSignal: new AbortController().signal, startTimeoutMs: 20, settleMs: 20 };

test("turn deadline: a turn that finishes in time gives its result", async () => {
  const watched = await runTurnWithStartDeadline(async () => answer(), quick);
  assert.equal(watched.kind, "result");
});

test("turn deadline: once the agent's run starts, the turn may take longer than the deadline", async () => {
  for (const step of ["run:start", "model:selected"]) {
    const watched = await runTurnWithStartDeadline(async (opts: TurnOptions) => {
      opts.onProgress?.(step);
      await sleep(60);
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
  assert.deepEqual(watched, { kind: "stuck", lastStep: "record:done", settled: false });
  assert.equal(aborted, true);
});

test("turn deadline: a stuck turn that ends on the abort is stuck, and settled", async () => {
  const watched = await runTurnWithStartDeadline(
    (opts) =>
      new Promise<TurnResult>((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    quick,
  );
  assert.deepEqual(watched, { kind: "stuck", lastStep: undefined, settled: true });
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
