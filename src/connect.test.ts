import assert from "node:assert/strict";
import { test } from "node:test";

import { BearerRejectedError, ConnectAbortedError, retryConnect } from "./connect.js";

const noSleep = async () => {};

test("retryConnect: a connect that fails while the server is down is retried until it succeeds", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await retryConnect(
    async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return "connected";
    },
    { sleep: noSleep, backoff: (attempt) => (waits.push(attempt), attempt * 10) },
  );
  assert.equal(result, "connected");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1, 2]);
});

test("retryConnect: a rejected bearer is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    retryConnect(
      async () => {
        calls += 1;
        throw new BearerRejectedError();
      },
      { sleep: noSleep },
    ),
    BearerRejectedError,
  );
  assert.equal(calls, 1);
});

test("retryConnect: an abort during the backoff ends the attempts", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    retryConnect(
      async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
      {
        abortSignal: controller.signal,
        sleep: async () => controller.abort(),
        backoff: () => 1,
      },
    ),
    ConnectAbortedError,
  );
  assert.equal(calls, 1);
});
