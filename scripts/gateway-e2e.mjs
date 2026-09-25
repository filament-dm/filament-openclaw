// Offline end-to-end check (`npm run build && node scripts/gateway-e2e.mjs`) of the gateway control account, against the real
// compiled plugin (dist/), a fake Filament MCP server and a fake gateway API.
// State dir is isolated to the scratchpad so the user's ~/.openclaw is untouched.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated state, so a run never touches the operator's ~/.openclaw.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "filament-gateway-e2e-"));
process.env.OPENCLAW_STATE_DIR = path.join(SCRATCH, "oc-state");
process.env.OPENCLAW_HOME = path.join(SCRATCH, "oc-home");

const PRINCIPAL = "@u_test1:filament-dev.local";
const CC = "!gwcc:filament-dev.local";
const NEW_TOKEN = "fmcp_newagenttoken123";

const seen = { tools: [], posts: [], polls: 0 };
let delivered = false;

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : null;
  const send = (obj) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.url === "/mcp/agents/heartbeat") return send({});
  if (req.url === "/mcp/agents/tools") {
    seen.tools.push(json.tools);
    return send({ ok: true });
  }
  if (req.url !== "/mcp/agents") {
    res.writeHead(404);
    return res.end();
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: json.id, result });
  const toolResult = (data) =>
    reply({ content: [{ type: "text", text: JSON.stringify(data) }] });
  if (json.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {} });
  if (json.method?.startsWith("notifications/")) {
    res.writeHead(202);
    return res.end();
  }
  if (json.method === "tools/list") return reply({ tools: [] });
  const { name, arguments: args } = json.params;
  if (name === "get_self") {
    return toolResult({ user_id: "@gw:filament-dev.local", owner: { user_id: PRINCIPAL }, cc_room_id: CC });
  }
  if (name === "poll_work") {
    seen.polls += 1;
    if (!delivered) {
      delivered = true;
      return toolResult({
        work: [
          {
            channel_id: CC,
            thread_id: null,
            is_backchannel: true,
            messages: [
              { event_id: "$cmd", sender: PRINCIPAL, body: `/filament connect writer ${NEW_TOKEN}`, ts: 1 },
            ],
            reply_with: { tool: "post_message", args: { channel: CC } },
          },
        ],
        cursor: "c:1",
        next_poll_ms: 0,
        truncated: false,
        acknowledged: 0,
      });
    }
    await new Promise((r) => setTimeout(r, 200));
    return toolResult({ work: [], cursor: "c:1", next_poll_ms: 1000, truncated: false, acknowledged: 0 });
  }
  if (name === "post_message") {
    seen.posts.push(args);
    return toolResult({ event_id: `$r${seen.posts.length}`, timestamp: 1 });
  }
  return toolResult({ error: `unexpected tool ${name}` });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp/agents`;

// The gateway config, as the fake runtime holds it.
let gatewayConfig = {
  agents: { entries: { coordinator: {}, writer: { identity: { name: "Writer", emoji: "✍️" } } } },
  bindings: [],
  plugins: {
    entries: {
      "filament-fcm": {
        config: { mcpUrl, accounts: { gateway: { connectToken: "bearer-not-fmcp", control: true } } },
      },
    },
  },
};
const writes = [];
let registeredPlugin;
const toolFactories = [];
const api = {
  config: gatewayConfig,
  pluginConfig: gatewayConfig.plugins.entries["filament-fcm"].config,
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  registerChannel: ({ plugin }) => {
    registeredPlugin = plugin;
  },
  registerTool: (factory, opts) => toolFactories.push({ factory, opts }),
  runtime: {
    config: {
      current: () => gatewayConfig,
      mutateConfigFile: async ({ afterWrite, mutate }) => {
        const draft = structuredClone(gatewayConfig);
        mutate(draft);
        gatewayConfig = draft;
        writes.push({ afterWrite, draft });
        return { ok: true };
      },
    },
  },
};
const logs = [];

const { registerFilamentChannel } = await import(
  new URL("../dist/src/channel.js", import.meta.url).href
);
registerFilamentChannel(api);

assert.equal(typeof registeredPlugin?.gateway?.startAccount, "function");
assert.deepEqual(registeredPlugin.config.listAccountIds(gatewayConfig), ["gateway"]);

// Tool factories: nothing is bound yet and only a control account exists → no tools.
assert.ok(toolFactories.length > 0);
assert.ok(toolFactories.every(({ opts }) => Array.isArray(opts.names) && opts.names.length === 1));
assert.equal(toolFactories[0].factory({ agentId: "coordinator", config: gatewayConfig }), null);

const abort = new AbortController();
const run = registeredPlugin.gateway.startAccount({
  accountId: "gateway",
  cfg: gatewayConfig,
  abortSignal: abort.signal,
  channelRuntime: {},
  setStatus: () => {},
});

const deadline = Date.now() + 15000;
while (writes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 300));
abort.abort();
await run;
server.close();

// 1. Inventory reported, with the four allowed keys.
assert.ok(seen.tools.length >= 1, "inventory was reported");
const names = seen.tools[0].map((t) => t.name).sort();
assert.deepEqual(names, ["coordinator", "writer"]);
assert.equal(JSON.parse(seen.tools[0].find((t) => t.name === "writer").description).emoji, "✍️");

// 2. Reply first, token never echoed.
assert.ok(seen.posts.length >= 1, "a reply was posted");
assert.equal(seen.posts[0].channel, CC);
assert.ok(!JSON.stringify(seen.posts).includes(NEW_TOKEN), "token must not be echoed");

// 3. Exactly one config write: account + binding, gateway account intact.
assert.equal(writes.length, 1);
assert.deepEqual(writes[0].afterWrite, { mode: "auto" });
const cfg = writes[0].draft.plugins.entries["filament-fcm"].config;
assert.deepEqual(cfg.accounts.writer, { connectToken: NEW_TOKEN });
assert.deepEqual(cfg.accounts.gateway, { connectToken: "bearer-not-fmcp", control: true });
assert.deepEqual(writes[0].draft.bindings, [
  { agentId: "writer", match: { channel: "filament", accountId: "writer" } },
]);

// 4. After the write: listAccountIds sees the new account; writer's tools resolve to it.
assert.deepEqual(registeredPlugin.config.listAccountIds(gatewayConfig), ["gateway", "writer"]);
assert.notEqual(toolFactories[0].factory({ agentId: "writer", config: gatewayConfig }), null);
assert.equal(toolFactories[0].factory({ agentId: "coordinator", config: gatewayConfig }), null);

// 5. No token in any log line.
assert.ok(!logs.join("\n").includes(NEW_TOKEN), "token must not be logged");

console.log("gateway e2e OK", { polls: seen.polls, posts: seen.posts.length, writes: writes.length });
console.log(logs.filter((l) => l.includes("gateway")).join("\n"));
