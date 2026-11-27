import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BearerRejectedError,
  ConnectAbortedError,
  reportRuntime,
  retryConnect,
} from "./connect.js";
import type { ToolCallResult } from "./mcp-client.js";
import { PLUGIN_VERSION } from "./version.js";

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

test("reportRuntime: reports the plugin version and the machine as harness openclaw", async () => {
  const calls: unknown[] = [];
  const logs: string[] = [];
  const client = {
    reportRuntime: async (args: unknown): Promise<ToolCallResult> => {
      calls.push(args);
      return { ok: true, httpStatus: 200, data: {} };
    },
  };
  await reportRuntime(client, (m) => logs.push(m), undefined, "gateway-1");
  assert.deepEqual(calls, [{ harness: "openclaw", version: PLUGIN_VERSION, machine: "gateway-1" }]);
  assert.deepEqual(logs, []);
});

test("reportRuntime: a server without the tool, or a network error, is logged and never thrown", async () => {
  const logs: string[] = [];
  const refused = {
    reportRuntime: async (): Promise<ToolCallResult> => ({
      ok: false,
      httpStatus: 200,
      error: { code: -32601, message: "Unknown tool: report_runtime" },
    }),
  };
  await reportRuntime(refused, (m) => logs.push(m), undefined, "");
  const down = {
    reportRuntime: async (): Promise<ToolCallResult> => {
      throw new TypeError("fetch failed");
    },
  };
  await reportRuntime(down, (m) => logs.push(m));
  assert.deepEqual(logs, [
    "filament-connect: report_runtime failed: Unknown tool: report_runtime",
    "filament-connect: report_runtime threw: TypeError: fetch failed",
  ]);
});
