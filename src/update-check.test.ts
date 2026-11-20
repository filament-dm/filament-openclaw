import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkForUpdate,
  isNewerVersion,
  runUpdateChecks,
  startPluginUpdate,
  UPDATE_CHECK_URL,
  INSTALL_COMMAND,
  UPDATE_NOW_LABEL,
  type UpdateCheckContext,
  type UpdateCheckState,
  updatedBody,
  updateOutcomeBody,
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
  assert.ok(!h.said[0]!.includes(INSTALL_COMMAND));
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

type Cli = { code: number; stdout: string; stderr: string };

/** A fake `openclaw`: `plugins inspect` reports `source`; every call is recorded. */
function fakeCli(
  source: string | null,
  install: Cli = { code: 0, stdout: "Installed", stderr: "" },
) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<Cli> => {
    calls.push(args);
    if (args[1] === "inspect") {
      const body = source === null ? { plugin: {} } : { plugin: {}, install: { source } };
      // OpenClaw may print log lines before the JSON.
      return {
        code: 0,
        stdout: `[plugins] filament: registered\n${JSON.stringify(body)}`,
        stderr: "",
      };
    }
    return install;
  };
  return { run, calls };
}

const INSTALL_ARGS = [
  "plugins",
  "install",
  "clawhub:@filament-dm/filament-openclaw@0.2.0",
  "--force",
  "--accept-capabilities",
];

test("startPluginUpdate: a ClawHub install behind the latest release reinstalls it from ClawHub", async () => {
  const cli = fakeCli("clawhub");
  let marked = false;
  const outcome = await startPluginUpdate({
    installed: "0.1.0",
    run: cli.run,
    latestVersion: async () => "0.2.0",
    beforeInstall: () => {
      marked = true;
    },
  });
  assert.deepEqual(outcome, { kind: "started", version: "0.2.0" });
  assert.equal(marked, true);
  // Never `plugins update`: OpenClaw 2026.11 refuses it beside a running gateway.
  assert.deepEqual(cli.calls, [
    ["plugins", "inspect", "filament-openclaw", "--json"],
    INSTALL_ARGS,
  ]);
});

test("startPluginUpdate: a GitHub install moves to ClawHub, even on the same version", async () => {
  for (const installed of ["0.1.0", "0.2.0"]) {
    const cli = fakeCli("git");
    const outcome = await startPluginUpdate({
      installed,
      run: cli.run,
      latestVersion: async () => "0.2.0",
    });
    assert.equal(outcome.kind, "started");
    assert.deepEqual(cli.calls[1], INSTALL_ARGS);
  }
});

test("startPluginUpdate: a ClawHub install on the latest release installs nothing", async () => {
  const cli = fakeCli("clawhub");
  const outcome = await startPluginUpdate({
    installed: "0.2.0",
    run: cli.run,
    latestVersion: async () => "0.2.0",
    beforeInstall: () => assert.fail("no marker without an install"),
  });
  assert.deepEqual(outcome, { kind: "current", version: "0.2.0" });
  assert.equal(cli.calls.length, 1);
  assert.match(updateOutcomeBody(outcome)!, /already on the latest version, v0\.2\.0/);
});

test("startPluginUpdate: a linked or unrecorded copy is left to its owner", async () => {
  for (const source of ["path", null]) {
    const cli = fakeCli(source);
    const outcome = await startPluginUpdate({
      installed: "0.1.0",
      run: cli.run,
      latestVersion: async () => "0.2.0",
    });
    assert.equal(outcome.kind, "manual");
    assert.equal(cli.calls.length, 1);
    assert.match(updateOutcomeBody(outcome)!, /local copy/);
  }
});

test("startPluginUpdate: a failed install is reported, never thrown, with the host command", async () => {
  const cli = fakeCli("git", { code: 1, stdout: "", stderr: "registry unreachable" });
  const outcome = await startPluginUpdate({
    installed: "0.1.0",
    run: cli.run,
    latestVersion: async () => "0.2.0",
  });
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.detail : "", /exit 1\): registry unreachable/);
  const body = updateOutcomeBody(outcome)!;
  assert.ok(body.includes(INSTALL_COMMAND));
  assert.ok(!body.includes("registry unreachable"), "CLI details stay in the log");

  const unreachable = await startPluginUpdate({
    installed: "0.1.0",
    run: fakeCli("clawhub").run,
    latestVersion: async () => {
      throw new Error("HTTP 503");
    },
  });
  assert.deepEqual(unreachable, { kind: "failed", detail: "Error: HTTP 503" });
});

test("startPluginUpdate: a latest version that is not a release installs nothing", async () => {
  const cli = fakeCli("clawhub");
  const outcome = await startPluginUpdate({
    installed: "0.1.0",
    run: cli.run,
    latestVersion: async () => "0.2.0 --force",
  });
  assert.equal(outcome.kind, "failed");
  assert.equal(cli.calls.length, 1);
});

test("INSTALL_COMMAND: the published package, replacing any copy, keeping its config", () => {
  assert.equal(
    INSTALL_COMMAND,
    `openclaw plugins install clawhub:${pkg.name} --force --accept-capabilities`,
  );
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
