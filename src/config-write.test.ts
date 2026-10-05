import assert from "node:assert/strict";
import { test } from "node:test";

import {
  awaitConfigApplied,
  configPatch,
  openclawCliArgv,
  writeGatewayConfig,
  type CliResult,
} from "./config-write.js";

test("openclawCliArgv: inside the gateway it is node plus the gateway's own entry", () => {
  assert.deepEqual(
    openclawCliArgv(["/usr/bin/node", "/x/node_modules/openclaw/dist/index.js", "gateway"], "/n"),
    ["/n", "/x/node_modules/openclaw/dist/index.js"],
  );
  assert.deepEqual(openclawCliArgv(["/usr/bin/node", "/x/tests.mjs"], "/n"), ["openclaw"]);
});

test("configPatch: changed keys only, removed keys as null, arrays whole, nothing when equal", () => {
  assert.equal(configPatch({ a: 1, b: [1] }, { a: 1, b: [1] }), undefined);
  assert.deepEqual(configPatch({ a: { x: 1, y: 2 }, b: [1] }, { a: { x: 1, z: 3 }, b: [1, 2] }), {
    a: { y: null, z: 3 },
    b: [1, 2],
  });
  assert.deepEqual(configPatch({ a: { x: 1 } }, { a: "s" }), { a: "s" });
});

function fakeCli(file: { pluginConfig: unknown; bindings: unknown }) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: "" });
  const run = async (args: string[], stdin?: string): Promise<CliResult> => {
    calls.push({ args, stdin });
    if (args[1] === "get" && args[2] === "bindings") return ok(JSON.stringify(file.bindings));
    if (args[1] === "get") return ok(JSON.stringify(file.pluginConfig));
    if (args[1] === "patch") return ok("");
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { run, calls };
}

test("writeGatewayConfig: reads the file's values, patches only what the mutation changed", async () => {
  const cli = fakeCli({
    pluginConfig: {
      mcpUrl: "https://x/mcp/agents",
      accounts: { "pending-abc": { connectToken: "fmcp_x", pending: true } },
    },
    bindings: [{ agentId: "other", match: { channel: "slack" } }],
  });
  const wrote = await writeGatewayConfig((draft) => {
    const cfg = (draft as any).plugins.entries["filament-openclaw"].config;
    delete cfg.accounts["pending-abc"];
    cfg.accounts.writer = { connectToken: "fmcp_x" };
    (draft as any).bindings.push({
      agentId: "writer",
      match: { channel: "filament", accountId: "writer" },
    });
  }, cli.run);
  assert.equal(wrote, true);
  const patchCall = cli.calls.find((c) => c.args[1] === "patch")!;
  assert.deepEqual(patchCall.args, ["config", "patch", "--stdin"]);
  assert.deepEqual(JSON.parse(patchCall.stdin!), {
    plugins: {
      entries: {
        "filament-openclaw": {
          config: { accounts: { "pending-abc": null, writer: { connectToken: "fmcp_x" } } },
        },
      },
    },
    bindings: [
      { agentId: "other", match: { channel: "slack" } },
      { agentId: "writer", match: { channel: "filament", accountId: "writer" } },
    ],
  });
  // The token reaches the CLI on stdin, never in argv.
  for (const call of cli.calls) assert.ok(!call.args.join(" ").includes("fmcp_x"));
});

test("writeGatewayConfig: a mutation that changes nothing writes nothing", async () => {
  const cli = fakeCli({
    pluginConfig: { accounts: { writer: { connectToken: "t" } } },
    bindings: [],
  });
  assert.equal(await writeGatewayConfig(() => {}, cli.run), false);
  assert.equal(
    cli.calls.some((c) => c.args[1] === "patch"),
    false,
  );
});

test("writeGatewayConfig: a failed patch surfaces the CLI's stderr", async () => {
  const run = async (args: string[]): Promise<CliResult> =>
    args[1] === "patch"
      ? { code: 2, stdout: "", stderr: "schema: nope" }
      : { code: 0, stdout: "{}", stderr: "" };
  await assert.rejects(
    writeGatewayConfig((draft) => {
      (draft as any).bindings = [{ agentId: "w", match: { channel: "filament" } }];
    }, run),
    /openclaw config patch failed \(exit 2\): schema: nope/,
  );
});

test("awaitConfigApplied: applied once the predicate holds, timeout at the deadline, aborted on abort", async () => {
  let n = 0;
  const idle = new AbortController();
  assert.equal(
    await awaitConfigApplied({ applied: () => ++n >= 3, abortSignal: idle.signal, intervalMs: 1 }),
    "applied",
  );
  assert.equal(
    await awaitConfigApplied({
      applied: () => false,
      abortSignal: idle.signal,
      timeoutMs: 5,
      intervalMs: 1,
    }),
    "timeout",
  );
  const aborted = new AbortController();
  const waiting = awaitConfigApplied({
    applied: () => false,
    abortSignal: aborted.signal,
    timeoutMs: 10_000,
    intervalMs: 1_000,
  });
  aborted.abort();
  assert.equal(await waiting, "aborted");
});
