import assert from "node:assert/strict";
import { test } from "node:test";

import type { CliResult } from "./config-write.js";
import { removeRetiredSettings, retiredSettings } from "./retired-settings.js";

function cli(result: CliResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run = async (args: string[], stdin?: string): Promise<CliResult> => {
    calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
    return result;
  };
  return { run, calls };
}

test("retiredSettings: a config without them needs nothing", () => {
  assert.equal(retiredSettings(undefined), null);
  assert.equal(
    retiredSettings({ mcpUrl: "https://x", accounts: { main: { connectToken: "fmcp_m" } } }),
    null,
  );
});

test("retiredSettings: removes them at the top level and per account, and nothing else", () => {
  const retired = retiredSettings({
    transport: "fcm",
    firebase: { projectId: "p" },
    mcpUrl: "https://x",
    accounts: {
      main: { connectToken: "fmcp_m", transport: "poll" },
      other: { connectToken: "fmcp_o" },
    },
  });
  assert.deepEqual(retired, {
    patch: {
      plugins: {
        entries: {
          "filament-openclaw": {
            config: { transport: null, firebase: null, accounts: { main: { transport: null } } },
          },
        },
      },
    },
    paths: ["transport", "firebase", "accounts.main.transport"],
  });
});

test("removeRetiredSettings: writes one patch and says what it removed", async () => {
  const logs: string[] = [];
  const h = cli();
  const outcome = await removeRetiredSettings({ transport: "poll" }, (m) => logs.push(m), h.run);
  assert.equal(outcome, "removed");
  assert.deepEqual(h.calls[0]!.args, ["config", "patch", "--stdin"]);
  assert.deepEqual(JSON.parse(h.calls[0]!.stdin!), {
    plugins: { entries: { "filament-openclaw": { config: { transport: null } } } },
  });
  assert.match(logs[0]!, /removed retired settings .*: transport$/);
});

test("removeRetiredSettings: nothing to remove calls nothing", async () => {
  const h = cli();
  assert.equal(await removeRetiredSettings({}, () => {}, h.run), "none");
  assert.equal(h.calls.length, 0);
});

test("removeRetiredSettings: a rejected write is logged, not thrown", async () => {
  const logs: string[] = [];
  const h = cli({ code: 1, stdout: "", stderr: "config is locked" });
  assert.equal(await removeRetiredSettings({ firebase: {} }, (m) => logs.push(m), h.run), "failed");
  assert.match(logs[0]!, /could not remove retired settings \(firebase\): config is locked/);
});
