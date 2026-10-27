import assert from "node:assert/strict";
import { test } from "node:test";

import type { CliResult } from "./config-write.js";
import { ensureGroupSilenceAllowed, GROUP_SILENCE_PATH } from "./silent-reply-policy.js";

const UNSET = JSON.stringify({
  ok: false,
  error: { message: "Config path is valid but unset; the runtime default applies" },
});

function cli(get: CliResult, patch: CliResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run = async (args: string[], stdin?: string): Promise<CliResult> => {
    calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
    return args[1] === "get" ? get : patch;
  };
  return { run, calls };
}

test("ensureGroupSilenceAllowed: an unset policy is set to allow, on the filament surface only", async () => {
  const h = cli({ code: 1, stdout: UNSET, stderr: "" });
  assert.equal(await ensureGroupSilenceAllowed(() => {}, h.run), "set");
  assert.deepEqual(h.calls[0]!.args, ["config", "get", GROUP_SILENCE_PATH, "--json"]);
  assert.deepEqual(h.calls[1]!.args, ["config", "patch", "--stdin"]);
  assert.deepEqual(JSON.parse(h.calls[1]!.stdin!), {
    surfaces: { filament: { silentReply: { group: "allow" } } },
  });
});

test("ensureGroupSilenceAllowed: a value the owner set is left alone, disallow included", async () => {
  const h = cli({ code: 0, stdout: '"disallow"', stderr: "" });
  assert.equal(await ensureGroupSilenceAllowed(() => {}, h.run), "present");
  assert.equal(h.calls.length, 1);
});

test("ensureGroupSilenceAllowed: a read or write that fails writes nothing more and says why", async () => {
  const logs: string[] = [];
  const unreadable = cli({ code: 2, stdout: "boom", stderr: "" });
  assert.equal(await ensureGroupSilenceAllowed((m) => logs.push(m), unreadable.run), "failed");
  assert.equal(unreadable.calls.length, 1);

  const rejected = cli(
    { code: 1, stdout: UNSET, stderr: "" },
    { code: 1, stdout: "", stderr: "unknown key surfaces" },
  );
  assert.equal(await ensureGroupSilenceAllowed((m) => logs.push(m), rejected.run), "failed");
  assert.match(logs.at(-1)!, /unknown key surfaces/);
});
