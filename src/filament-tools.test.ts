import assert from "node:assert/strict";
import { test } from "node:test";

import pluginManifest from "../openclaw.plugin.json" with { type: "json" };
import type { ListToolsResult, McpToolDescriptor, ToolCallResult } from "./mcp-client.js";
import {
  _getActiveFilamentTurnForTest,
  beginFilamentTurn,
  checkFilamentToolDrift,
  classifyToolTier,
  endFilamentTurn,
  getFilamentClient,
  KNOWN_TOOL_NAMES,
  logToolDrift,
  registerFilamentToolsFromSnapshot,
  setFilamentClient,
  TOOL_NAME_PREFIX,
  TOOL_SNAPSHOT,
  type FilamentToolClient,
  type FilamentToolsApi,
} from "./filament-tools.js";

function okResult(data: unknown): ToolCallResult {
  return { ok: true, httpStatus: 200, data };
}
function errResult(kind: ToolCallResult["kind"], message = "x"): ToolCallResult {
  return { ok: false, httpStatus: 502, kind, error: { code: -1, message } };
}

function readDescriptor(name: string): McpToolDescriptor {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  };
}
function writeDescriptor(name: string): McpToolDescriptor {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: {},
    annotations: { readOnlyHint: false },
  };
}

/** A fake registry that captures every registered tool, keyed by name. */
function fakeApi(): {
  api: FilamentToolsApi;
  tools: Map<string, Parameters<FilamentToolsApi["registerTool"]>[0]>;
} {
  const tools = new Map<string, Parameters<FilamentToolsApi["registerTool"]>[0]>();
  return {
    api: { registerTool: (tool) => tools.set(tool.name, tool) },
    tools,
  };
}

function fakeLog(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

test.afterEach(() => {
  endFilamentTurn();
  setFilamentClient(null);
});

test("classifyToolTier: readOnlyHint true is read, false is write, set_profile is always ring0", () => {
  assert.equal(classifyToolTier(readDescriptor("list_channels")), "read");
  assert.equal(classifyToolTier(writeDescriptor("post_message")), "write");
  assert.equal(classifyToolTier(writeDescriptor("set_profile")), "ring0");
  assert.equal(classifyToolTier(readDescriptor("set_profile")), "ring0");
});

test("classifyToolTier: missing/malformed annotations fail closed to ring0", () => {
  assert.equal(classifyToolTier({ name: "mystery_tool" }), "ring0");
  assert.equal(
    classifyToolTier({
      name: "mystery_tool",
      annotations: { readOnlyHint: "yes" as unknown as boolean },
    }),
    "ring0",
  );
});

test("KNOWN_TOOL_NAMES never contains poll_work", () => {
  assert.ok(!KNOWN_TOOL_NAMES.includes("poll_work"));
});

test("contracts/snapshot equality: openclaw.plugin.json's contracts.tools matches TOOL_SNAPSHOT exactly", () => {
  const manifestTools = [...(pluginManifest as { contracts: { tools: string[] } }).contracts.tools]
    .slice()
    .sort();
  const snapshotTools = TOOL_SNAPSHOT.map((t) => `${TOOL_NAME_PREFIX}${t.name}`)
    .slice()
    .sort();
  assert.deepEqual(
    manifestTools,
    snapshotTools,
    "openclaw.plugin.json's contracts.tools has drifted from src/filament-tools.snapshot.json — " +
      "regenerate the snapshot (npm run snapshot:tools) and update the manifest to match",
  );
});

// ── registerFilamentToolsFromSnapshot ───────────────────────────────────────

test("registerFilamentToolsFromSnapshot: registers every snapshot tool, prefixed, synchronously", () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  const result = registerFilamentToolsFromSnapshot(api, getFilamentClient, log);

  assert.equal(tools.size, TOOL_SNAPSHOT.length);
  assert.equal(result.registered.length, TOOL_SNAPSHOT.length);
  assert.deepEqual(result.skipped, []);
  for (const descriptor of TOOL_SNAPSHOT) {
    assert.ok(tools.has(`${TOOL_NAME_PREFIX}${descriptor.name}`), `missing ${descriptor.name}`);
  }
  assert.ok(
    lines.some((l) => l.includes(`registered ${TOOL_SNAPSHOT.length} tool(s) from snapshot`)),
  );
});

test("execute: before connect (no client set) throws 'Filament is not connected yet'", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}list_channels`)!;

  // getFilamentClient() returns null until setFilamentClient() is called.
  assert.equal(getFilamentClient(), null);
  await assert.rejects(
    () => tool.execute("call-1", {}, undefined, undefined, {}),
    /Filament is not connected yet/,
  );
});

test("execute: after setFilamentClient(client) calls the live client", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}list_channels`)!;

  const calls: Array<{ name: string; args: unknown }> = [];
  const client: FilamentToolClient = {
    callTool: async (name, args) => {
      calls.push({ name, args: args ?? {} });
      return okResult({ channels: ["!a:server"] });
    },
  };
  setFilamentClient(client);

  const result = await tool.execute("call-1", { loop_id: "!x" }, undefined, undefined, {});
  assert.deepEqual(calls, [{ name: "list_channels", args: { loop_id: "!x" } }]);
  assert.deepEqual(result.details, { channels: ["!a:server"] });
});

test("ring0 write tool (set_profile): denied outside a backchannel turn, allowed inside one", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}set_profile`)!;
  setFilamentClient({ callTool: async () => okResult({ ok: true }) });

  await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, {}), /denied/);

  beginFilamentTurn(false); // group item, not backchannel
  await assert.rejects(() => tool.execute("call-2", {}, undefined, undefined, {}), /denied/);
  endFilamentTurn();
  assert.ok(
    lines.filter((l) => l === `filament-tools: ${TOOL_NAME_PREFIX}set_profile denied`).length === 2,
  );

  beginFilamentTurn(true); // backchannel
  const result = await tool.execute("call-3", {}, undefined, undefined, {});
  endFilamentTurn();
  assert.deepEqual(result.details, { ok: true });
});

test("ordinary write tool (accept_invite): denied with no active turn, allowed inside any Filament turn", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}accept_invite`)!;
  setFilamentClient({ callTool: async () => okResult({ event_id: "$x" }) });

  await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, {}), /denied/);

  beginFilamentTurn(false);
  const groupResult = await tool.execute("call-2", { loop_id: "!x" }, undefined, undefined, {});
  endFilamentTurn();
  assert.deepEqual(groupResult.details, { event_id: "$x" });

  beginFilamentTurn(true);
  const backchannelResult = await tool.execute(
    "call-3",
    { loop_id: "!x" },
    undefined,
    undefined,
    {},
  );
  endFilamentTurn();
  assert.deepEqual(backchannelResult.details, { event_id: "$x" });
});

test("read tool (list_channels): allowed with no active turn at all", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}list_channels`)!;
  setFilamentClient({ callTool: async () => okResult({ channels: [] }) });

  const result = await tool.execute("call-1", {}, undefined, undefined, {});
  assert.deepEqual(result.details, { channels: [] });
});

test("execute: an upstream tool-call failure surfaces as a thrown error, logged as failed", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}list_channels`)!;
  setFilamentClient({ callTool: async () => errResult("transient", "HTTP 503") });

  await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, {}), /transient/);
  assert.ok(lines.some((l) => l === `filament-tools: ${TOOL_NAME_PREFIX}list_channels failed`));
});

test("beginFilamentTurn/endFilamentTurn: tracks and clears the active turn", () => {
  assert.equal(_getActiveFilamentTurnForTest(), null);
  beginFilamentTurn(true);
  assert.deepEqual(_getActiveFilamentTurnForTest(), { backchannel: true });
  endFilamentTurn();
  assert.equal(_getActiveFilamentTurnForTest(), null);
});

test("setFilamentClient/getFilamentClient: holds and clears the current connection", () => {
  assert.equal(getFilamentClient(), null);
  const client: FilamentToolClient = { callTool: async () => okResult(null) };
  setFilamentClient(client);
  assert.equal(getFilamentClient(), client);
  setFilamentClient(null);
  assert.equal(getFilamentClient(), null);
});

// ── drift check (runtime, log-only) ─────────────────────────────────────────

test("logToolDrift: logs server-only and snapshot-only tool names, not the known exclusions", () => {
  const { log, lines } = fakeLog();
  const liveTools: McpToolDescriptor[] = [
    ...TOOL_SNAPSHOT.slice(1).map((t) => readDescriptor(t.name)), // drop one snapshot tool
    writeDescriptor("poll_work"), // expected exclusion: must not be reported as drift
    readDescriptor("some_brand_new_tool"),
  ];
  logToolDrift(liveTools, log);

  const missingName = TOOL_SNAPSHOT[0]!.name;
  assert.ok(
    lines.some(
      (l) =>
        l.includes("server exposes 1 tool(s) not in the snapshot") &&
        l.includes("some_brand_new_tool"),
    ),
  );
  assert.ok(
    lines.some(
      (l) =>
        l.includes("snapshot has 1 tool(s) the server no longer serves") && l.includes(missingName),
    ),
  );
  assert.ok(!lines.some((l) => l.includes("poll_work")));
});

test("logToolDrift: logs a match message when the live set equals the snapshot", () => {
  const { log, lines } = fakeLog();
  const liveTools: McpToolDescriptor[] = TOOL_SNAPSHOT.map((t) => readDescriptor(t.name));
  logToolDrift(liveTools, log);
  assert.ok(lines.some((l) => l.includes("snapshot matches the live server's tool surface")));
});

test("checkFilamentToolDrift: fetches tools/list and delegates to logToolDrift", async () => {
  const { log, lines } = fakeLog();
  const client: { listTools: () => Promise<ListToolsResult> } = {
    listTools: async () => ({ ok: true, tools: TOOL_SNAPSHOT.map((t) => readDescriptor(t.name)) }),
  };
  await checkFilamentToolDrift(client, log);
  assert.ok(lines.some((l) => l.includes("snapshot matches the live server's tool surface")));
});

test("checkFilamentToolDrift: a failed tools/list is logged and does not throw", async () => {
  const { log, lines } = fakeLog();
  const client: { listTools: () => Promise<ListToolsResult> } = {
    listTools: async () => ({ ok: false, kind: "transient", error: { code: -1, message: "x" } }),
  };
  await checkFilamentToolDrift(client, log);
  assert.ok(lines.some((l) => l.includes("drift check skipped")));
});
