import assert from "node:assert/strict";
import { test } from "node:test";

import type { CliResult } from "./config-write.js";
import { ensurePrincipalOwner, OWNER_ALLOW_FROM_PATH, withPrincipalOwner } from "./owner-policy.js";

const UNSET = JSON.stringify({
  ok: false,
  error: { message: "Config path is valid but unset: commands.ownerAllowFrom." },
});
const PRINCIPAL = "@u_owner:filament.dm";

function memory(recorded: string[] = []) {
  const seen = new Map(recorded.map((p) => [p, 1]));
  return {
    recordedAt: (p: string) => seen.get(p),
    markRecorded: (p: string) => void seen.set(p, 2),
    seen,
  };
}

function cli(get: CliResult, patch: CliResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run = async (args: string[], stdin?: string): Promise<CliResult> => {
    calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
    return args[1] === "get" ? get : patch;
  };
  return { run, calls };
}

test("withPrincipalOwner: adds the principal beside other channels' owners", () => {
  assert.deepEqual(withPrincipalOwner(undefined, PRINCIPAL), {
    list: ["filament:@u_owner:filament.dm"],
  });
  assert.deepEqual(withPrincipalOwner(["telegram:123"], PRINCIPAL), {
    list: ["telegram:123", "filament:@u_owner:filament.dm"],
  });
});

test("withPrincipalOwner: never adds a second Filament owner or repeats one", () => {
  assert.deepEqual(withPrincipalOwner(["filament:@u_owner:filament.dm"], PRINCIPAL), {
    outcome: "present",
  });
  assert.deepEqual(withPrincipalOwner(["filament:@u_other:filament.dm"], PRINCIPAL), {
    outcome: "other-owner",
  });
});

test("ensurePrincipalOwner: an unset list gets the principal, written as the whole list", async () => {
  const h = cli({ code: 1, stdout: UNSET, stderr: "" });
  const mem = memory();
  assert.equal(await ensurePrincipalOwner(PRINCIPAL, () => {}, h.run, mem), "set");
  assert.ok(mem.seen.has(PRINCIPAL));
  assert.deepEqual(h.calls[0]!.args, ["config", "get", OWNER_ALLOW_FROM_PATH, "--json"]);
  assert.deepEqual(h.calls[1]!.args, ["config", "patch", "--stdin"]);
  assert.deepEqual(JSON.parse(h.calls[1]!.stdin!), {
    commands: { ownerAllowFrom: ["filament:@u_owner:filament.dm"] },
  });
});

test("ensurePrincipalOwner: an existing Filament owner is left alone", async () => {
  const logs: string[] = [];
  const h = cli({ code: 0, stdout: '["filament:@u_other:filament.dm"]', stderr: "" });
  assert.equal(
    await ensurePrincipalOwner(PRINCIPAL, (m) => logs.push(m), h.run, memory()),
    "other-owner",
  );
  assert.equal(h.calls.length, 1);
  assert.match(logs[0]!, /already names a Filament owner/);
});

test("ensurePrincipalOwner: a failed read or write changes nothing more", async () => {
  const unreadable = cli({ code: 2, stdout: "boom", stderr: "" });
  assert.equal(await ensurePrincipalOwner(PRINCIPAL, () => {}, unreadable.run, memory()), "failed");
  assert.equal(unreadable.calls.length, 1);
  const refused = cli(
    { code: 1, stdout: UNSET, stderr: "" },
    { code: 1, stdout: "", stderr: "no" },
  );
  assert.equal(await ensurePrincipalOwner(PRINCIPAL, () => {}, refused.run, memory()), "failed");
});

test("ensurePrincipalOwner: something that is not a Matrix id is never written", async () => {
  const h = cli({ code: 1, stdout: UNSET, stderr: "" });
  assert.equal(await ensurePrincipalOwner("", () => {}, h.run, memory()), "failed");
  assert.equal(h.calls.length, 0);
});

test("ensurePrincipalOwner: an entry the owner removed is never added back", async () => {
  const removed = cli({ code: 1, stdout: UNSET, stderr: "" });
  assert.equal(
    await ensurePrincipalOwner(PRINCIPAL, () => {}, removed.run, memory([PRINCIPAL])),
    "removed-by-owner",
  );
  assert.equal(removed.calls.filter((c) => c.args[1] === "patch").length, 0);
  const kept = cli({ code: 0, stdout: '["filament:@u_owner:filament.dm"]', stderr: "" });
  assert.equal(
    await ensurePrincipalOwner(PRINCIPAL, () => {}, kept.run, memory([PRINCIPAL])),
    "present",
  );
});
