import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkForUpdate,
  isNewerVersion,
  runUpdateChecks,
  startPluginUpdate,
  UPDATE_CHECK_URL,
  UPDATE_COMMAND,
  UPDATE_NOW_LABEL,
  type UpdateCheckContext,
  type UpdateCheckState,
  updatedBody,
  updateFailureMessage,
  updateNoticeBody,
} from "./update-check.js";
import pkg from "../package.json" with { type: "json" };

const DAY = 24 * 60 * 60 * 1000;

// The shape of ClawHub's GET /api/v1/packages/<name>, trimmed to what the check reads.
function manifest(version: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        package: {
          name: "@filament-dm/filament-openclaw",
          latestVersion: version,
          scanStatus: "clean",
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

function harness(overrides: Partial<UpdateCheckContext> = {}) {
  let state: UpdateCheckState = {};
  const said: string[] = [];
  const ctx: UpdateCheckContext = {
    installed: "0.1.0",
    url: "https://example.test/api/v1/packages/x",
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

test("checkForUpdate: a newer version is announced once, with the button and nothing to type", async () => {
  const h = harness();
  assert.equal(await checkForUpdate(h.ctx), "notified");
  assert.equal(h.said.length, 1);
  assert.match(h.said[0]!, /v0\.2\.0/);
  assert.match(h.said[0]!, /v0\.1\.0/);
  assert.ok(h.said[0]!.includes(`[${UPDATE_NOW_LABEL}](filament:message-send)`));
  assert.ok(!h.said[0]!.includes(UPDATE_COMMAND));
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

test("isNewerVersion: numeric per part, short versions pad, garbage is never newer", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerVersion("0.10.0", "0.9.9"), true);
  assert.equal(isNewerVersion("1.0", "0.9.9"), true);
  assert.equal(isNewerVersion("v0.1.1", "0.1.0"), true);
  assert.equal(isNewerVersion("0.1.1", "0.1.1"), false);
  assert.equal(isNewerVersion("0.2", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.1.1"), false);
  assert.equal(isNewerVersion("unknown", "0.1.1"), false);
  assert.equal(isNewerVersion("0.2.0", "unknown"), false);
});

test("updatedBody: says the new version, or that it already was the latest", () => {
  assert.match(updatedBody("0.1.0", "0.2.0"), /Updated .* v0\.2\.0 \(from v0\.1\.0\)/);
  assert.match(updatedBody("0.2.0", "0.2.0"), /already on the latest version, v0\.2\.0/);
});

test("startPluginUpdate: starts the CLI update at once; the result is read later, never thrown", async () => {
  const calls: string[][] = [];
  let started = false;
  const finished = startPluginUpdate(async (args) => {
    started = true;
    calls.push(args);
    return { code: 0, stdout: "Updated filament-openclaw: 0.1.0 -> 0.2.0", stderr: "" };
  });
  assert.equal(started, true);
  assert.deepEqual(calls, [["plugins", "update", "filament-openclaw", "--accept-capabilities"]]);
  assert.equal((await finished).code, 0);
  const failed = await startPluginUpdate(async () => ({
    code: 1,
    stdout: "",
    stderr: "not installed",
  }));
  assert.match(updateFailureMessage(failed), /failed \(exit 1\): not installed/);
});

test("runUpdateChecks: an abort during the check ends the loop without a sleep", async () => {
  const aborted = new AbortController();
  const h = harness({
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      aborted.abort();
      return manifest("0.1.0")(...args);
    }) as typeof fetch,
  });
  const started = Date.now();
  await runUpdateChecks(h.ctx, aborted.signal, 60 * 60 * 1000);
  assert.ok(Date.now() - started < 1000);
});

test("updateNoticeBody: the button's label is the exact text the gateway reads as the command", () => {
  assert.ok(updateNoticeBody("0.2.0", "0.1.0").includes(`[${UPDATE_NOW_LABEL}]`));
});

test("checkForUpdate: reads ClawHub's latestVersion and ignores a body without one", async () => {
  const logs: string[] = [];
  const h = harness({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ id: "filament-openclaw", version: "9.9.9" }), {
        status: 200,
      })) as unknown as typeof fetch,
    log: (m) => {
      logs.push(m);
    },
  });
  assert.equal(await checkForUpdate(h.ctx), "failed");
  assert.deepEqual(h.said, []);
  assert.match(logs[0]!, /no latest version/);
});

test("UPDATE_CHECK_URL: the ClawHub package this plugin is published as", () => {
  assert.equal(
    UPDATE_CHECK_URL,
    `https://clawhub.ai/api/v1/packages/${encodeURIComponent(pkg.name)}`,
  );
});
