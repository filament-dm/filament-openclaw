import assert from "node:assert/strict";
import { test } from "node:test";

import type { ListToolsResult, McpToolDescriptor, ToolCallResult } from "./mcp-client.js";
import {
  _getActiveFilamentTurnForTest,
  beginFilamentTurn,
  classifyToolTier,
  endFilamentTurn,
  fetchAndRegisterFilamentTools,
  KNOWN_TOOL_NAMES,
  registerFilamentTools,
  TOOL_NAME_PREFIX,
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

test("registerFilamentTools: registers known tools prefixed, excludes poll_work and push-token tools, skips unknowns", () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  const live: McpToolDescriptor[] = [
    readDescriptor("list_channels"),
    writeDescriptor("post_message"),
    writeDescriptor("poll_work"),
    writeDescriptor("register_push_token"),
    readDescriptor("list_push_tokens"),
    readDescriptor("some_brand_new_tool_not_reviewed_yet"),
  ];
  const result = registerFilamentTools(api, live, () => null, log);

  assert.deepEqual(
    [...tools.keys()].sort(),
    [`${TOOL_NAME_PREFIX}list_channels`, `${TOOL_NAME_PREFIX}post_message`].sort(),
  );
  assert.deepEqual(
    result.registered.sort(),
    [`${TOOL_NAME_PREFIX}list_channels`, `${TOOL_NAME_PREFIX}post_message`].sort(),
  );
  const skippedNames = result.skipped.map((s) => s.name).sort();
  assert.deepEqual(
    skippedNames,
    [
      "poll_work",
      "register_push_token",
      "list_push_tokens",
      "some_brand_new_tool_not_reviewed_yet",
    ].sort(),
  );
  assert.ok(lines.some((l) => l.includes("registered 2 tool(s)")));
});

test("KNOWN_TOOL_NAMES never contains poll_work", () => {
  assert.ok(!KNOWN_TOOL_NAMES.includes("poll_work"));
});

test("read tool: returns data from the live client regardless of turn state", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  const calls: Array<{ name: string; args: unknown }> = [];
  const client: FilamentToolClient = {
    callTool: async (name, args) => {
      calls.push({ name, args: args ?? {} });
      return okResult({ channels: ["!a:server"] });
    },
  };
  registerFilamentTools(api, [readDescriptor("list_channels")], () => client, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}list_channels`)!;

  // No active Filament turn at all — still allowed, because it's a read tool.
  const result = await tool.execute("call-1", { loop_id: "!x" }, undefined, undefined, {});
  assert.deepEqual(calls, [{ name: "list_channels", args: { loop_id: "!x" } }]);
  assert.deepEqual(JSON.parse(result.content[0]!.text), { channels: ["!a:server"] });
  assert.deepEqual(result.details, { channels: ["!a:server"] });
  assert.ok(lines.some((l) => l === `filament-tools: ${TOOL_NAME_PREFIX}list_channels ok`));
});

test("ring0 write tool: denied outside a backchannel turn, allowed inside one", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  const client: FilamentToolClient = {
    callTool: async () => okResult({ ok: true }),
  };
  registerFilamentTools(api, [writeDescriptor("set_profile")], () => client, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}set_profile`)!;

  // No active turn at all.
  await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, {}), /denied/);

  // Active turn, but not the backchannel (a group item).
  beginFilamentTurn(false);
  await assert.rejects(() => tool.execute("call-2", {}, undefined, undefined, {}), /denied/);
  endFilamentTurn();
  assert.ok(
    lines.filter((l) => l === `filament-tools: ${TOOL_NAME_PREFIX}set_profile denied`).length === 2,
  );

  // Active backchannel turn: allowed.
  beginFilamentTurn(true);
  const result = await tool.execute("call-3", {}, undefined, undefined, {});
  endFilamentTurn();
  assert.deepEqual(result.details, { ok: true });
  assert.ok(lines.some((l) => l === `filament-tools: ${TOOL_NAME_PREFIX}set_profile ok`));
});

test("ordinary write tool: denied with no active Filament turn, allowed inside any Filament turn (group or backchannel)", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  const client: FilamentToolClient = {
    callTool: async () => okResult({ event_id: "$x" }),
  };
  registerFilamentTools(api, [writeDescriptor("accept_invite")], () => client, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}accept_invite`)!;

  await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, {}), /denied/);

  beginFilamentTurn(false); // group item
  const groupResult = await tool.execute("call-2", { loop_id: "!x" }, undefined, undefined, {});
  endFilamentTurn();
  assert.deepEqual(groupResult.details, { event_id: "$x" });

  beginFilamentTurn(true); // backchannel item
  const backchannelResult = await tool.execute(
    "call-3",
    { loop_id: "!x" },
    undefined,
    undefined,
    {},
  );
  endFilamentTurn();
  assert.deepEqual(backchannelResult.details, { event_id: "$x" });

  assert.ok(
    lines.filter((l) => l === `filament-tools: ${TOOL_NAME_PREFIX}accept_invite ok`).length === 2,
  );
});

test("execute: not connected surfaces as a thrown error, logged as failed", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  registerFilamentTools(api, [readDescriptor("list_channels")], () => null, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}list_channels`)!;

  await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, {}), /not connected/);
  assert.ok(lines.some((l) => l === `filament-tools: ${TOOL_NAME_PREFIX}list_channels failed`));
});

test("execute: an upstream tool-call failure surfaces as a thrown error, logged as failed", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  const client: FilamentToolClient = {
    callTool: async () => errResult("transient", "HTTP 503"),
  };
  registerFilamentTools(api, [readDescriptor("list_channels")], () => client, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}list_channels`)!;

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

test("fetchAndRegisterFilamentTools: registers from a fake tools/list, poll_work excluded", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  const client: FilamentToolClient & { listTools: () => Promise<ListToolsResult> } = {
    callTool: async () => okResult({}),
    listTools: async () => ({
      ok: true,
      tools: [
        readDescriptor("list_channels"),
        writeDescriptor("poll_work"),
        writeDescriptor("accept_invite"),
      ],
    }),
  };
  const result = await fetchAndRegisterFilamentTools(api, client, () => client, log);
  assert.deepEqual(
    result.registered.sort(),
    [`${TOOL_NAME_PREFIX}list_channels`, `${TOOL_NAME_PREFIX}accept_invite`].sort(),
  );
  assert.ok(!tools.has(`${TOOL_NAME_PREFIX}poll_work`));
});

test("fetchAndRegisterFilamentTools: a failed tools/list registers nothing rather than throwing", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  const client: FilamentToolClient & { listTools: () => Promise<ListToolsResult> } = {
    callTool: async () => okResult({}),
    listTools: async () => ({ ok: false, kind: "transient", error: { code: -1, message: "x" } }),
  };
  const result = await fetchAndRegisterFilamentTools(api, client, () => client, log);
  assert.deepEqual(result, { registered: [], skipped: [] });
  assert.equal(tools.size, 0);
  assert.ok(lines.some((l) => l.includes("tools/list failed")));
});
