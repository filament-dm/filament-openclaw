import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCallResult } from "./mcp-client.js";
import { type InviteSweepClient, runInviteSweep, startInviteSweeper } from "./invite-sweep.js";

function okResult(data: unknown): ToolCallResult {
  return { ok: true, httpStatus: 200, data };
}
function errResult(kind: ToolCallResult["kind"] = "tool", message = "x"): ToolCallResult {
  return { ok: false, httpStatus: 500, kind, error: { code: -1, message } };
}

/** Flush the microtask queue (real macrotask, so it works alongside mocked timers). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A fake client whose calls are all recorded, with per-method behavior overridable. */
function fakeClient(overrides: Partial<InviteSweepClient> = {}): {
  client: InviteSweepClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client: InviteSweepClient = {
    listPendingInvites: async () => {
      calls.push("listPendingInvites");
      return okResult({ invites: [] });
    },
    acceptInvite: async (loopId) => {
      calls.push(`acceptInvite:${loopId}`);
      return okResult({ loop_id: loopId });
    },
    listVouches: async () => {
      calls.push("listVouches");
      return okResult({ vouches: [] });
    },
    acceptVouch: async (loopId) => {
      calls.push(`acceptVouch:${loopId}`);
      return okResult({ loop_id: loopId });
    },
    ...overrides,
  };
  return { client, calls };
}

test("runInviteSweep: accepts each listed invite and vouch", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const client: InviteSweepClient = {
    listPendingInvites: async () => {
      calls.push("listPendingInvites");
      return okResult({ invites: [{ loop_id: "!inv1:s" }, { loop_id: "!inv2:s" }] });
    },
    acceptInvite: async (loopId) => {
      calls.push(`acceptInvite:${loopId}`);
      return okResult({ loop_id: loopId });
    },
    listVouches: async () => {
      calls.push("listVouches");
      return okResult({ vouches: [{ loop_id: "!vch1:s" }] });
    },
    acceptVouch: async (loopId) => {
      calls.push(`acceptVouch:${loopId}`);
      return okResult({ loop_id: loopId });
    },
  };
  await runInviteSweep(client, (m) => logs.push(m), undefined);

  assert.deepEqual(calls, [
    "listPendingInvites",
    "acceptInvite:!inv1:s",
    "acceptInvite:!inv2:s",
    "listVouches",
    "acceptVouch:!vch1:s",
  ]);
  assert.ok(logs.some((l) => l === "filament-invites: accept_invite !inv1:s ok"));
  assert.ok(logs.some((l) => l === "filament-invites: accept_invite !inv2:s ok"));
  assert.ok(logs.some((l) => l === "filament-invites: accept_vouch !vch1:s ok"));
});

test("runInviteSweep: tolerates a failing accept and a failing list", async () => {
  const logs: string[] = [];
  const { client, calls } = fakeClient({
    listPendingInvites: async () => {
      calls.push("listPendingInvites");
      return okResult({ invites: [{ loop_id: "!ok:s" }, { loop_id: "!bad:s" }] });
    },
    acceptInvite: async (loopId) => {
      calls.push(`acceptInvite:${loopId}`);
      if (loopId === "!bad:s") return errResult("tool", "already a member");
      return okResult({ loop_id: loopId });
    },
    listVouches: async () => {
      calls.push("listVouches");
      throw new Error("network down");
    },
  });

  // Never throws, even though list_vouches rejects.
  await runInviteSweep(client, (m) => logs.push(m), undefined);

  assert.deepEqual(calls, [
    "listPendingInvites",
    "acceptInvite:!ok:s",
    "acceptInvite:!bad:s",
    "listVouches",
  ]);
  assert.ok(logs.some((l) => l === "filament-invites: accept_invite !ok:s ok"));
  assert.ok(logs.some((l) => l.startsWith("filament-invites: accept_invite !bad:s failed")));
  assert.ok(logs.some((l) => l.includes("list_vouches failed (continuing)")));
});

test("runInviteSweep: an aborted signal short-circuits without calling the client", async () => {
  const controller = new AbortController();
  controller.abort();
  const { client, calls } = fakeClient();
  await runInviteSweep(client, () => {}, controller.signal);
  assert.deepEqual(calls, []);
});

test("startInviteSweeper: sweeps once immediately", async () => {
  const controller = new AbortController();
  const { client, calls } = fakeClient();
  const handle = startInviteSweeper({
    client,
    log: () => {},
    abortSignal: controller.signal,
    intervalSeconds: 60,
  });
  await flush();
  assert.deepEqual(calls, ["listPendingInvites", "listVouches"]);
  handle.stop();
  controller.abort();
});

test("startInviteSweeper: a tick is skipped while the previous sweep is still running", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const controller = new AbortController();

  const state: { resolveFirstList: (() => void) | null } = { resolveFirstList: null };
  let listCalls = 0;
  const { client } = fakeClient({
    listPendingInvites: async () => {
      listCalls += 1;
      if (listCalls === 1) {
        await new Promise<void>((resolve) => {
          state.resolveFirstList = resolve;
        });
      }
      return okResult({ invites: [] });
    },
  });

  const handle = startInviteSweeper({
    client,
    log: () => {},
    abortSignal: controller.signal,
    intervalSeconds: 5,
  });
  await flush();
  assert.equal(listCalls, 1); // the immediate sweep, still in flight

  // A tick lands while the first sweep hasn't resolved yet: skipped.
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(listCalls, 1);

  // Let the first sweep finish, then the next tick runs a fresh sweep.
  state.resolveFirstList?.();
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(listCalls, 2);

  handle.stop();
  controller.abort();
});

test("startInviteSweeper: abort clears the interval, no further sweeps", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const controller = new AbortController();
  const { client, calls } = fakeClient();

  const handle = startInviteSweeper({
    client,
    log: () => {},
    abortSignal: controller.signal,
    intervalSeconds: 5,
  });
  await flush();
  assert.equal(calls.length, 2); // the immediate sweep (list invites + list vouches)

  controller.abort();
  t.mock.timers.tick(5_000);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls.length, 2); // no additional sweeps after abort

  handle.stop();
});
