import assert from "node:assert/strict";
import { test } from "node:test";

import pluginManifest from "../openclaw.plugin.json" with { type: "json" };
import type { ListToolsResult, McpToolDescriptor, ToolCallResult } from "./mcp-client.js";
import {
  _getActiveFilamentTurnForTest,
  beginFilamentTurn,
  bindFilamentTurnSession,
  checkFilamentToolDrift,
  classifyToolTier,
  endFilamentTurn,
  getFilamentClient,
  KNOWN_TOOL_NAMES,
  logToolDrift,
  normalizeEventIdArgs,
  registerFilamentToolsFromSnapshot,
  REPLIED_UNKNOWN_ROOM,
  setFilamentClient,
  TOOL_NAME_PREFIX,
  TOOL_SNAPSHOT,
  type FilamentAgentTool,
  type FilamentToolClient,
  type FilamentToolsApi,
} from "./filament-tools.js";
import type { ToolAccountContext } from "./accounts.js";

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

/**
 * A fake registry that captures every registered tool factory, keyed by name,
 * and materializes it for `ctx` (default: an unbound single-account agent).
 */
function fakeApi(ctx: ToolAccountContext = {}): {
  api: FilamentToolsApi;
  tools: Map<string, FilamentAgentTool>;
  factories: Map<string, (ctx: ToolAccountContext) => FilamentAgentTool | null>;
} {
  const tools = new Map<string, FilamentAgentTool>();
  const factories = new Map<string, (ctx: ToolAccountContext) => FilamentAgentTool | null>();
  return {
    api: {
      registerTool: (factory, opts) => {
        factories.set(opts.names[0]!, factory);
        const tool = factory(ctx);
        if (tool) tools.set(tool.name, tool);
      },
    },
    tools,
    factories,
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
  // Settings change the agent itself too.
  assert.equal(classifyToolTier(writeDescriptor("declare_settings")), "ring0");
  assert.equal(classifyToolTier(writeDescriptor("set_setting")), "ring0");
  assert.equal(classifyToolTier(readDescriptor("get_settings")), "read");
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

test("execute: a snapshot tool the live server doesn't list is refused without a call", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}get_media_download_url`)!;

  const calls: string[] = [];
  const client: FilamentToolClient = {
    callTool: async (name) => {
      calls.push(name);
      return okResult({ download_url: "https://example.test/x" });
    },
    toolNames: new Set(["list_channels"]),
  };
  setFilamentClient(client);
  await assert.rejects(
    () => tool.execute("call-1", { mxc_url: "mxc://s/1" }, undefined, undefined, {}),
    /this Filament server doesn't offer get_media_download_url yet/,
  );
  assert.deepEqual(calls, []);
  assert.ok(lines.some((l) => l.includes("get_media_download_url not offered by this server")));

  // Listed: the call goes through.
  setFilamentClient({ ...client, toolNames: new Set(["get_media_download_url"]) });
  await tool.execute("call-2", { mxc_url: "mxc://s/1" }, undefined, undefined, {});
  assert.deepEqual(calls, ["get_media_download_url"]);
});

test("the signed-URL media tools are registered; get_wake_url is not", () => {
  for (const name of ["get_media_download_url", "create_media_upload"]) {
    assert.ok(KNOWN_TOOL_NAMES.includes(name), name);
  }
  assert.ok(!KNOWN_TOOL_NAMES.includes("get_wake_url"));
  const { log, lines } = fakeLog();
  logToolDrift(
    [...TOOL_SNAPSHOT.map((t) => readDescriptor(t.name)), readDescriptor("get_wake_url")],
    log,
  );
  assert.ok(lines.some((l) => l.includes("snapshot matches the live server's tool surface")));
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
    lines.filter((l) => l.startsWith(`filament-tools: ${TOOL_NAME_PREFIX}set_profile denied`))
      .length === 2,
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
  assert.deepEqual(_getActiveFilamentTurnForTest(), {
    backchannel: true,
    sessionKey: null,
    repliedTo: new Set(),
    reacted: false,
    posted: [],
  });
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
        l.includes("snapshot has 1 tool(s) the server does not list for this agent") &&
        l.includes(missingName),
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

test("two accounts: each agent's tool calls through its own account's client and turn", async () => {
  const bindings = [
    { agentId: "researcher", match: { channel: "filament", accountId: "researcher" } },
    { agentId: "writer", match: { channel: "filament", accountId: "writer" } },
  ];
  const config = { bindings };
  const researcher = fakeApi({ agentId: "researcher", config });
  const writer = fakeApi({ agentId: "writer", config });
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(researcher.api, getFilamentClient, log);
  registerFilamentToolsFromSnapshot(writer.api, getFilamentClient, log);

  const calls: string[] = [];
  setFilamentClient(
    { callTool: async () => (calls.push("researcher"), okResult({})) },
    "researcher",
  );
  setFilamentClient({ callTool: async () => (calls.push("writer"), okResult({})) }, "writer");

  const name = `${TOOL_NAME_PREFIX}accept_invite`;
  beginFilamentTurn(false, "writer");
  await assert.rejects(
    () => researcher.tools.get(name)!.execute("c1", {}, undefined, undefined, {}),
    /denied/,
  );
  await writer.tools.get(name)!.execute("c2", {}, undefined, undefined, {});
  endFilamentTurn("writer");
  assert.deepEqual(calls, ["writer"]);

  setFilamentClient(null, "researcher");
  setFilamentClient(null, "writer");
});

test("an agent with no Filament account gets no filament_* tools", () => {
  const config = {
    bindings: [{ agentId: "researcher", match: { channel: "filament", accountId: "researcher" } }],
  };
  const { api, tools, factories } = fakeApi({ agentId: "coordinator", config });
  registerFilamentToolsFromSnapshot(api, getFilamentClient, () => {});
  assert.equal(factories.size, TOOL_SNAPSHOT.length);
  assert.equal(tools.size, 0);
});

test("execute: the turn's abort signal reaches the call", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}list_channels`)!;
  let seen: AbortSignal | undefined;
  setFilamentClient({
    callTool: async (_name, _args, opts) => {
      seen = opts?.signal;
      return okResult({ channels: [] });
    },
  });
  const controller = new AbortController();
  await tool.execute("call-1", {}, controller.signal, undefined, {});
  assert.equal(seen, controller.signal);
});

test("a quote counts as the turn's reply", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}post_quote`)!;
  setFilamentClient({ callTool: async () => okResult({ event_id: "$q" }) });
  beginFilamentTurn(false);
  await tool.execute(
    "call-1",
    { message_id: "$m", markdown_body: "this" },
    undefined,
    undefined,
    {},
  );
  assert.ok(endFilamentTurn().repliedTo.has(REPLIED_UNKNOWN_ROOM));
});

test("a post the server refuses in its result is not the turn's reply", async () => {
  const { api, tools } = fakeApi();
  const { log, lines } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}reply_in_thread`)!;
  setFilamentClient({
    callTool: async () => okResult({ error: "message_id $m not found" }),
  });
  beginFilamentTurn(false);
  const result = await tool.execute(
    "call-1",
    { message_id: "$m", markdown_body: "the answer" },
    undefined,
    undefined,
    {},
  );
  const outcome = endFilamentTurn();
  assert.equal(outcome.repliedTo.size, 0);
  assert.deepEqual(outcome.posted, []);
  // The agent still reads why, so it can post another way.
  assert.deepEqual(result.details, { error: "message_id $m not found" });
  assert.ok(lines.some((l) => l.includes("reply_in_thread refused: message_id $m not found")));
});

test("a reaction is recorded on the turn, but is not a reply", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const tool = tools.get(`${TOOL_NAME_PREFIX}react`)!;
  setFilamentClient({ callTool: async () => okResult({ event_id: "$r" }) });
  beginFilamentTurn(false);
  await tool.execute("call-1", { message_id: "$m", key: "✅" }, undefined, undefined, {});
  const outcome = endFilamentTurn();
  assert.equal(outcome.reacted, true);
  assert.equal(outcome.repliedTo.size, 0);
});

test("normalizeEventIdArgs: a `#$event` id from OpenClaw's history lines loses the `#`", () => {
  assert.deepEqual(
    normalizeEventIdArgs({
      message_id: "#$a1:x",
      about_message_id: "#$b2:x",
      up_to: "#$c3",
      key: "👍",
    }),
    { message_id: "$a1:x", about_message_id: "$b2:x", up_to: "$c3", key: "👍" },
  );
  // Only id arguments: a body or a room alias keeps its `#`.
  const same = { message_id: "$a1:x", channel: "#general", markdown_body: "#$ is fine here" };
  assert.equal(normalizeEventIdArgs(same), same);
});

const TURN_SESSION = "agent:main:filament:direct:!Backchannel:Example";

test("a turn's write tools belong to its session: another session of the same agent is denied", async () => {
  const { log, lines } = fakeLog();
  const turnSession = fakeApi({ sessionKey: TURN_SESSION });
  const otherSession = fakeApi({ sessionKey: "agent:main:telegram:direct:12345" });
  registerFilamentToolsFromSnapshot(turnSession.api, getFilamentClient, log);
  registerFilamentToolsFromSnapshot(otherSession.api, getFilamentClient, log);
  const calls: string[] = [];
  setFilamentClient({ callTool: async (name) => (calls.push(name), okResult({ ok: true })) });

  beginFilamentTurn(true); // a backchannel turn: ring0 open to its own session
  bindFilamentTurnSession(TURN_SESSION);
  for (const name of ["set_profile", "post_message"]) {
    await assert.rejects(
      () =>
        otherSession.tools
          .get(`${TOOL_NAME_PREFIX}${name}`)!
          .execute("other", { channel: "!x", markdown_body: "hi" }, undefined, undefined, {}),
      /another session/,
    );
  }
  await turnSession.tools
    .get(`${TOOL_NAME_PREFIX}set_profile`)!
    .execute("own", {}, undefined, undefined, {});
  await turnSession.tools
    .get(`${TOOL_NAME_PREFIX}post_message`)!
    .execute("own", { channel: "!x", markdown_body: "hi" }, undefined, undefined, {});
  const outcome = endFilamentTurn();

  assert.deepEqual(calls, ["set_profile", "post_message"]);
  // The denied post is not counted as the turn's reply.
  assert.deepEqual([...outcome.repliedTo], ["!x"]);
  assert.equal(lines.filter((l) => l.includes("denied")).length, 2);
});

test("a session key compares without case: OpenClaw may store it lowercased", async () => {
  const { api, tools } = fakeApi({ sessionKey: TURN_SESSION.toLowerCase() });
  registerFilamentToolsFromSnapshot(api, getFilamentClient, () => {});
  setFilamentClient({ callTool: async () => okResult({ event_id: "$x" }) });
  beginFilamentTurn(false);
  bindFilamentTurnSession(TURN_SESSION);
  const result = await tools
    .get(`${TOOL_NAME_PREFIX}accept_invite`)!
    .execute("c", { loop_id: "!x" }, undefined, undefined, {});
  endFilamentTurn();
  assert.deepEqual(result.details, { event_id: "$x" });
});

test("a session calling before the turn has its session is denied", async () => {
  const { api, tools } = fakeApi({ sessionKey: TURN_SESSION });
  registerFilamentToolsFromSnapshot(api, getFilamentClient, () => {});
  setFilamentClient({ callTool: async () => okResult({}) });
  beginFilamentTurn(true);
  await assert.rejects(
    () => tools.get(`${TOOL_NAME_PREFIX}set_profile`)!.execute("c", {}, undefined, undefined, {}),
    /another session/,
  );
  endFilamentTurn();
});

test("read tools stay open to every session, with or without a turn", async () => {
  const { api, tools } = fakeApi({ sessionKey: "agent:main:cron:daily:run:1" });
  registerFilamentToolsFromSnapshot(api, getFilamentClient, () => {});
  setFilamentClient({ callTool: async () => okResult({ channels: [] }) });
  beginFilamentTurn(false);
  bindFilamentTurnSession(TURN_SESSION);
  const result = await tools
    .get(`${TOOL_NAME_PREFIX}list_channels`)!
    .execute("c", {}, undefined, undefined, {});
  endFilamentTurn();
  assert.deepEqual(result.details, { channels: [] });
});

test("a call that outlives its turn records its reply on that turn, not the next one", async () => {
  const { api, tools } = fakeApi({ sessionKey: TURN_SESSION });
  registerFilamentToolsFromSnapshot(api, getFilamentClient, () => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  setFilamentClient({ callTool: async () => (await gate, okResult({ event_id: "$x" })) });

  beginFilamentTurn(false);
  bindFilamentTurnSession(TURN_SESSION);
  const pending = tools
    .get(`${TOOL_NAME_PREFIX}post_message`)!
    .execute("c", { channel: "!first", markdown_body: "hi" }, undefined, undefined, {});
  endFilamentTurn();
  beginFilamentTurn(false);
  bindFilamentTurnSession(TURN_SESSION);
  release();
  await pending;
  assert.equal(endFilamentTurn().repliedTo.size, 0);
});

test("a side turn: write tools beside the transport's turn, never ring0, and each end leaves the other", async () => {
  const { api, tools } = fakeApi();
  const { log } = fakeLog();
  registerFilamentToolsFromSnapshot(api, getFilamentClient, log);
  const say = tools.get(`${TOOL_NAME_PREFIX}message_principal`)!;
  const setProfile = tools.get(`${TOOL_NAME_PREFIX}set_profile`)!;
  setFilamentClient({ callTool: async () => okResult({ event_id: "$x" }) });
  const call = (tool: FilamentAgentTool) => tool.execute("call", {}, undefined, undefined, {});

  // Alone, it authorizes writes but not the tools that change the agent itself.
  beginFilamentTurn(true, undefined, true);
  await call(say);
  await assert.rejects(() => call(setProfile), /denied/);

  // A transport turn that starts and ends meanwhile does not end it, and sees the same reply.
  beginFilamentTurn(true);
  await call(setProfile);
  await call(say);
  assert.deepEqual([...endFilamentTurn().repliedTo], ["backchannel"]);
  await call(say);
  assert.deepEqual([...endFilamentTurn(undefined, true).repliedTo], ["backchannel"]);
  await assert.rejects(() => call(say), /denied/);

  // And its own end leaves the transport's turn authorized.
  beginFilamentTurn(false);
  beginFilamentTurn(true, undefined, true);
  endFilamentTurn(undefined, true);
  await call(say);
  endFilamentTurn();
});

test("a side turn in its own session: each session acts under its own turn alone", async () => {
  const SIDE_SESSION = `${TURN_SESSION}:thread:filament-look-around`;
  const transport = fakeApi({ sessionKey: TURN_SESSION });
  const side = fakeApi({ sessionKey: SIDE_SESSION });
  registerFilamentToolsFromSnapshot(transport.api, getFilamentClient, () => {});
  registerFilamentToolsFromSnapshot(side.api, getFilamentClient, () => {});
  setFilamentClient({ callTool: async () => okResult({ event_id: "$x" }) });
  const post = (tools: Map<string, FilamentAgentTool>, channel: string) =>
    tools
      .get(`${TOOL_NAME_PREFIX}post_message`)!
      .execute("c", { channel, markdown_body: "hi" }, undefined, undefined, {});

  beginFilamentTurn(true, undefined, true);
  bindFilamentTurnSession(SIDE_SESSION, undefined, true);
  beginFilamentTurn(true);
  bindFilamentTurnSession(TURN_SESSION);

  // The side session never gets ring0, even while a backchannel turn runs beside it.
  await assert.rejects(
    () =>
      side.tools.get(`${TOOL_NAME_PREFIX}set_profile`)!.execute("c", {}, undefined, undefined, {}),
    /principal-only/,
  );
  await transport.tools
    .get(`${TOOL_NAME_PREFIX}set_profile`)!
    .execute("c", {}, undefined, undefined, {});
  await post(side.tools, "!side");
  await post(transport.tools, "!transport");

  assert.deepEqual([...endFilamentTurn().repliedTo], ["!transport"]);
  assert.deepEqual([...endFilamentTurn(undefined, true).repliedTo], ["!side"]);
});
