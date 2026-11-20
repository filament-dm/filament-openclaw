import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkForUpdate,
  isNewerVersion,
  runUpdateChecks,
  startPluginUpdate,
  UPDATE_FAILURE_BODY,
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

test("checkForUpdate: a newer version is announced once, with the button and nothing to type", async () => {
  const h = harness();
  assert.equal(await checkForUpdate(h.ctx), "notified");
  assert.equal(h.said.length, 1);
  assert.match(h.said[0]!, /v0\.2\.0/);
  assert.match(h.said[0]!, /v0\.1\.0/);
  assert.ok(h.said[0]!.includes(`[${UPDATE_NOW_LABEL}](filament:message-send)`));
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

const officialGit = {
  source: "git",
  gitUrl: "https://github.com/filament-dm/filament-openclaw.git",
  gitRef: "v0.1.6",
};

function inspectOutput(install: unknown) {
  return { code: 0, stdout: JSON.stringify({ install }), stderr: "" };
}

test("startPluginUpdate: records the request before asking the gateway to replace the Git plugin", async () => {
  const steps: (string | string[])[] = [];
  const result = await startPluginUpdate(
    "0.1.6",
    () => steps.push("marked"),
    async (args) => {
      steps.push(args);
      return args[1] === "inspect"
        ? inspectOutput(officialGit)
        : { code: 0, stdout: "", stderr: "" };
    },
    async () => "0.1.7",
  );
  assert.equal(result, "installed");
  assert.deepEqual(steps, [
    ["plugins", "inspect", "filament-openclaw", "--json"],
    "marked",
    [
      "plugins",
      "install",
      "git:https://github.com/filament-dm/filament-openclaw.git@main",
      "--force",
      "--no-enable",
      "--accept-capabilities",
    ],
  ]);
});

test("startPluginUpdate: installs the announced version from ClawHub for a ClawHub install", async () => {
  const result = await startPluginUpdate(
    "0.1.6",
    () => {},
    async (args) => {
      if (args[1] === "inspect") {
        return inspectOutput({
          source: "clawhub",
          clawhubPackage: "@filament-dm/filament-openclaw",
        });
      }
      assert.deepEqual(args, [
        "plugins",
        "install",
        "clawhub:@filament-dm/filament-openclaw@0.1.7",
        "--force",
        "--no-enable",
        "--accept-capabilities",
      ]);
      return { code: 0, stdout: "", stderr: "" };
    },
    async () => "0.1.7",
  );
  assert.equal(result, "installed");
});

test("startPluginUpdate: a stale button cannot reinstall or downgrade a current version", async () => {
  const result = await startPluginUpdate(
    "0.1.7",
    () => assert.fail("should not mark an update"),
    async () => assert.fail("should not run the CLI"),
    async () => "0.1.6",
  );
  assert.equal(result, "current");
});

test("startPluginUpdate: an unrecognized source needs manual recovery", async () => {
  await assert.rejects(
    startPluginUpdate(
      "0.1.6",
      () => assert.fail("should not mark an update"),
      async (args) => {
        assert.equal(args[1], "inspect");
        return inspectOutput({ ...officialGit, gitRef: "development" });
      },
      async () => "0.1.7",
    ),
    /requires a manual update/,
  );
});

test("startPluginUpdate: logs can carry CLI detail while chat gives recovery steps", async () => {
  const privateError = "state root /private/home/.openclaw";
  await assert.rejects(
    startPluginUpdate(
      "0.1.6",
      () => {},
      async (args) =>
        args[1] === "inspect"
          ? inspectOutput(officialGit)
          : { code: 1, stdout: "", stderr: privateError },
      async () => "0.1.7",
    ),
    { message: `Plugin install failed (exit 1): ${privateError}` },
  );
  assert.ok(UPDATE_FAILURE_BODY.includes("Stop the gateway"));
  assert.ok(UPDATE_FAILURE_BODY.includes("Start the gateway again"));
  assert.ok(!UPDATE_FAILURE_BODY.includes(privateError));
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
