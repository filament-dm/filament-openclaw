import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkForUpdate,
  runPluginUpdate,
  UPDATE_COMMAND,
  UPDATE_NOW_LABEL,
  type UpdateCheckContext,
  type UpdateCheckState,
  updatedBody,
  updateNoticeBody,
} from "./update-check.js";

const DAY = 24 * 60 * 60 * 1000;

function manifest(version: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ id: "filament-openclaw", version }), {
      status: 200,
    })) as unknown as typeof fetch;
}

function harness(overrides: Partial<UpdateCheckContext> = {}) {
  let state: UpdateCheckState = {};
  const said: string[] = [];
  const ctx: UpdateCheckContext = {
    installed: "0.1.0",
    url: "https://example.test/openclaw.plugin.json",
    fetchImpl: manifest("0.2.0"),
    load: () => state,
    save: (next) => {
      state = next;
    },
    say: async (body) => {
      said.push(body);
      return true;
    },
    log: () => {},
    now: () => 1_000_000,
    ...overrides,
  };
  return { ctx, said, state: () => state };
}

test("checkForUpdate: a newer version is announced once, with the button and the command", async () => {
  const h = harness();
  assert.equal(await checkForUpdate(h.ctx), "notified");
  assert.equal(h.said.length, 1);
  assert.match(h.said[0]!, /v0\.2\.0/);
  assert.match(h.said[0]!, /v0\.1\.0/);
  assert.ok(h.said[0]!.includes(`[${UPDATE_NOW_LABEL}](filament:message-send)`));
  assert.ok(h.said[0]!.includes(UPDATE_COMMAND));
  assert.deepEqual(h.state(), { lastCheckedAt: 1_000_000, notifiedVersion: "0.2.0" });
  // A day later, the same version is not announced again.
  h.ctx.now = () => 1_000_000 + DAY;
  assert.equal(await checkForUpdate(h.ctx), "already-notified");
  assert.equal(h.said.length, 1);
});

test("checkForUpdate: at most one fetch a day across the gateway, whichever account asks", async () => {
  let fetches = 0;
  const h = harness({
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      fetches += 1;
      return manifest("0.1.0")(...args);
    }) as typeof fetch,
  });
  assert.equal(await checkForUpdate(h.ctx), "current");
  h.ctx.now = () => 1_000_000 + DAY / 2;
  assert.equal(await checkForUpdate(h.ctx), "skipped");
  assert.equal(fetches, 1);
});

test("checkForUpdate: a failed fetch is logged, counted as a check, and never announced", async () => {
  const logs: string[] = [];
  const h = harness({
    fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    log: (m) => {
      logs.push(m);
    },
  });
  assert.equal(await checkForUpdate(h.ctx), "failed");
  assert.deepEqual(h.said, []);
  assert.equal(h.state().lastCheckedAt, 1_000_000);
  assert.match(logs[0]!, /HTTP 500/);
});

test("updatedBody: says the new version, or that it already was the latest", () => {
  assert.match(updatedBody("0.1.0", "0.2.0"), /Updated .* v0\.2\.0 \(from v0\.1\.0\)/);
  assert.match(updatedBody("0.2.0", "0.2.0"), /already on the latest version, v0\.2\.0/);
});

test("runPluginUpdate: runs the CLI update and surfaces its failure", async () => {
  const calls: string[][] = [];
  await runPluginUpdate(async (args) => {
    calls.push(args);
    return { code: 0, stdout: "Updated filament-openclaw: 0.1.0 -> 0.2.0", stderr: "" };
  });
  assert.deepEqual(calls, [["plugins", "update", "filament-openclaw", "--accept-capabilities"]]);
  await assert.rejects(
    runPluginUpdate(async () => ({ code: 1, stdout: "", stderr: "not installed" })),
    /failed \(exit 1\): not installed/,
  );
});

test("updateNoticeBody: the button's label is the exact text the gateway reads as the command", () => {
  assert.ok(updateNoticeBody("0.2.0", "0.1.0").includes(`[${UPDATE_NOW_LABEL}]`));
});
