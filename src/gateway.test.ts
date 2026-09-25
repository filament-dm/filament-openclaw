import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveToolAccountId } from "./accounts.js";
import {
  applyAgentConnect,
  handleGatewayItem,
  inventoryEntries,
  listGatewayAgents,
  applyAgentDisconnect,
  applyUnpair,
  parseGatewayCommand,
  wouldChange,
  type GatewayItemContext,
  type GatewayStatus,
} from "./gateway.js";
import type { WorkItem } from "./work-item.js";

const PRINCIPAL = "@u_test1:filament-dev.local";
const CC_ROOM = "!gateway-cc:filament-dev.local";
const TOKEN = "fmcp_abc123";

const gatewayConfig = {
  agents: {
    entries: {
      coordinator: { identity: { name: "Chief of Staff" } },
      writer: { name: "writer", identity: { name: "Writer", emoji: "✍️" } },
      reviewer: {},
    },
  },
  bindings: [{ agentId: "reviewer", match: { channel: "filament", accountId: "reviewer" } }],
};

function item(body: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    channel_id: CC_ROOM,
    thread_id: null,
    is_backchannel: true,
    messages: [{ event_id: "$e1", sender: PRINCIPAL, body, ts: 1 }],
    ...overrides,
  };
}

function harness(body: string, overrides: Partial<WorkItem> = {}) {
  const consumed: string[] = [];
  const statuses: GatewayStatus[] = [];
  const drafts: Record<string, unknown>[] = [];
  const ctx: GatewayItemContext = {
    item: item(body, overrides),
    principal: PRINCIPAL,
    ccRoomId: CC_ROOM,
    gatewayConfig,
    consume: async (eventId) => {
      consumed.push(eventId);
    },
    mutateConfig: async (mutate) => {
      const draft: Record<string, unknown> = structuredClone({ bindings: gatewayConfig.bindings });
      mutate(draft);
      drafts.push(draft);
    },
    report: async (entries) => {
      statuses.push(...entries);
    },
    log: () => {},
  };
  return { ctx, consumed, statuses, drafts };
}

// ── inventory ────────────────────────────────────────────────────────────────

test("listGatewayAgents: identity name/emoji, falls back to entry name then id, marks bound", () => {
  assert.deepEqual(listGatewayAgents(gatewayConfig), [
    { id: "coordinator", name: "Chief of Staff" },
    { id: "writer", name: "Writer", emoji: "✍️" },
    { id: "reviewer", name: "reviewer", boundAccount: "reviewer" },
  ]);
});

test("listGatewayAgents: no entries is OpenClaw's implicit 'main' agent", () => {
  assert.deepEqual(listGatewayAgents({}), [{ id: "main", name: "main" }]);
});

test("inventoryEntries: only the four keys the server's tool inventory accepts, all strings", () => {
  const entries = inventoryEntries(listGatewayAgents(gatewayConfig));
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["description", "health", "name", "origin"]);
    for (const value of Object.values(entry)) assert.equal(typeof value, "string");
    assert.equal(entry.origin, "openclaw-agent");
    assert.equal(JSON.parse(entry.description).id, entry.name);
  }
});

// ── commands ─────────────────────────────────────────────────────────────────

test("parseGatewayCommand: every verb, the request id, and the rejections", () => {
  assert.deepEqual(parseGatewayCommand(`  /filament connect writer ${TOKEN} req-1 `, "$e"), {
    kind: "connect",
    agentId: "writer",
    token: TOKEN,
    requestId: "req-1",
  });
  assert.deepEqual(parseGatewayCommand(`/filament connect writer ${TOKEN}`, "e1"), {
    kind: "connect",
    agentId: "writer",
    token: TOKEN,
    requestId: "e1",
  });
  assert.deepEqual(parseGatewayCommand("/filament disconnect writer r2", "e"), {
    kind: "disconnect",
    agentId: "writer",
    requestId: "r2",
  });
  assert.deepEqual(parseGatewayCommand("/filament unpair r3", "e"), {
    kind: "unpair",
    requestId: "r3",
  });
  assert.deepEqual(parseGatewayCommand("/filament agents", "e"), {
    kind: "agents",
    requestId: "e",
  });
  assert.equal(parseGatewayCommand("hello there", "e"), null);
  for (const bad of [
    "/filament connect writer",
    `/filament connect Writer ${TOKEN}`,
    `/filament connect gateway ${TOKEN}`,
    `/filament connect default ${TOKEN}`,
    "/filament connect writer not-a-token",
    `/filament connect writer ${TOKEN} r1 extra`,
    "/filament disconnect",
    "/filament unpair now please",
    "/filament frobnicate",
  ]) {
    assert.equal(parseGatewayCommand(bad, "e")?.kind, "invalid", bad);
  }
});

// ── config mutation ──────────────────────────────────────────────────────────

test("applyAgentConnect: creates the account and binding on an empty draft", () => {
  const draft: Record<string, unknown> = {};
  const { displaced } = applyAgentConnect(draft, "writer", TOKEN);
  assert.deepEqual(displaced, []);
  assert.deepEqual(draft, {
    plugins: {
      entries: { "filament-fcm": { config: { accounts: { writer: { connectToken: TOKEN } } } } },
    },
    bindings: [{ agentId: "writer", match: { channel: "filament", accountId: "writer" } }],
  });
});

test("applyAgentConnect: keeps other channels and accounts, the gateway account untouched", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: {
        "filament-fcm": {
          enabled: true,
          config: {
            mcpUrl: "http://x/mcp/agents",
            accounts: {
              gateway: { connectToken: "fmcp_g", control: true },
              reviewer: { connectToken: "fmcp_r" },
            },
          },
        },
      },
    },
    bindings: [
      { agentId: "reviewer", match: { channel: "filament", accountId: "reviewer" } },
      { agentId: "writer", match: { channel: "telegram" } },
    ],
  };
  applyAgentConnect(draft, "writer", TOKEN);
  const config = (draft.plugins as any).entries["filament-fcm"].config;
  assert.equal(config.mcpUrl, "http://x/mcp/agents");
  assert.deepEqual(config.accounts.gateway, { connectToken: "fmcp_g", control: true });
  assert.deepEqual(config.accounts.reviewer, { connectToken: "fmcp_r" });
  assert.deepEqual(config.accounts.writer, { connectToken: TOKEN });
  assert.equal((draft.bindings as unknown[]).length, 3);
});

test("applyAgentConnect: one Filament account per agent — the displaced one is removed", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: { "filament-fcm": { config: { connectToken: "fmcp_legacy", accounts: {} } } },
    },
    bindings: [{ agentId: "researcher", match: { channel: "filament", accountId: "default" } }],
  };
  const { displaced } = applyAgentConnect(draft, "researcher", TOKEN);
  assert.deepEqual(displaced, ["default"]);
  const config = (draft.plugins as any).entries["filament-fcm"].config;
  assert.equal(config.connectToken, undefined);
  assert.deepEqual(draft.bindings, [
    { agentId: "researcher", match: { channel: "filament", accountId: "researcher" } },
  ]);
});

test("applyAgentConnect: idempotent — the same command twice yields the same draft", () => {
  const once: Record<string, unknown> = {};
  applyAgentConnect(once, "writer", TOKEN);
  const twice = structuredClone(once);
  applyAgentConnect(twice, "writer", TOKEN);
  assert.deepEqual(twice, once);
});

test("after a connect, the tools of the new agent resolve to its own account, never the gateway's", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: {
        "filament-fcm": {
          config: { accounts: { gateway: { connectToken: "fmcp_g", control: true } } },
        },
      },
    },
  };
  // Before any connect: only the control account exists; no agent gets tools.
  assert.equal(
    resolveToolAccountId({ agentId: "coordinator", config: draft }, undefined, {}),
    null,
  );
  applyAgentConnect(draft, "writer", TOKEN);
  assert.equal(resolveToolAccountId({ agentId: "writer", config: draft }, undefined, {}), "writer");
  assert.equal(
    resolveToolAccountId({ agentId: "coordinator", config: draft }, undefined, {}),
    null,
  );
});

// ── disconnect / unpair ─────────────────────────────────────────────────────

test("applyAgentDisconnect removes the account and its binding, nothing else", () => {
  const draft: Record<string, unknown> = {};
  applyAgentConnect(draft, "writer", TOKEN);
  applyAgentConnect(draft, "reviewer", "fmcp_r");
  applyAgentDisconnect(draft, "writer");
  const accounts = (draft.plugins as any).entries["filament-fcm"].config.accounts;
  assert.deepEqual(Object.keys(accounts), ["reviewer"]);
  assert.deepEqual(draft.bindings, [
    { agentId: "reviewer", match: { channel: "filament", accountId: "reviewer" } },
  ]);
});

test("applyUnpair removes only the control account", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: {
        "filament-fcm": {
          config: {
            accounts: {
              gateway: { connectToken: "g", control: true },
              writer: { connectToken: "w" },
            },
          },
        },
      },
    },
  };
  applyUnpair(draft);
  assert.deepEqual(Object.keys((draft.plugins as any).entries["filament-fcm"].config.accounts), [
    "writer",
  ]);
});

test("wouldChange: a repeated connect is a no-op, so it never triggers a reload", () => {
  const cfg: Record<string, unknown> = {};
  applyAgentConnect(cfg, "writer", TOKEN);
  assert.equal(
    wouldChange(cfg, (d) => applyAgentConnect(d, "writer", TOKEN)),
    false,
  );
  assert.equal(
    wouldChange(cfg, (d) => applyAgentConnect(d, "writer", "fmcp_other")),
    true,
  );
  assert.equal(
    wouldChange(cfg, (d) => applyAgentDisconnect(d, "ghost")),
    false,
  );
});

// ── the control handler ──────────────────────────────────────────────────────

test("handleGatewayItem: connect consumes, reports applied, then writes — and never chats", async () => {
  const h = harness(`/filament connect writer ${TOKEN} req-9`);
  assert.deepEqual(await handleGatewayItem(h.ctx), { kind: "silent" });
  assert.deepEqual(h.consumed, ["$e1"]);
  assert.deepEqual(h.statuses, [
    { requestId: "req-9", command: "connect", agentId: "writer", state: "applied" },
  ]);
  assert.ok(!JSON.stringify(h.statuses).includes(TOKEN), "the token must never be reported");
  assert.equal(h.drafts.length, 1);
  const accounts = (h.drafts[0]!.plugins as any).entries["filament-fcm"].config.accounts;
  assert.deepEqual(accounts.writer, { connectToken: TOKEN });
});

test("handleGatewayItem: an unknown agent is rejected with a status, no write", async () => {
  const h = harness(`/filament connect ghost ${TOKEN} r1`);
  await handleGatewayItem(h.ctx);
  assert.equal(h.drafts.length, 0);
  assert.equal(h.statuses[0]!.state, "rejected");
  assert.match(h.statuses[0]!.message!, /no OpenClaw agent "ghost"/);
});

test("handleGatewayItem: disconnect and unpair write; agents only reports", async () => {
  const d = harness("/filament disconnect reviewer r2");
  await handleGatewayItem(d.ctx);
  assert.equal(d.drafts.length, 1);
  assert.deepEqual(d.drafts[0]!.bindings, []);

  const a = harness("/filament agents r4");
  await handleGatewayItem(a.ctx);
  assert.equal(a.drafts.length, 0);
  assert.deepEqual(a.statuses, [{ requestId: "r4", command: "agents", state: "applied" }]);
});

test("handleGatewayItem: commands from anyone but the principal, or outside the backchannel, are ignored", async () => {
  for (const overrides of [
    {
      messages: [
        { event_id: "$x", sender: "@mallory:x", body: `/filament connect writer ${TOKEN}`, ts: 1 },
      ],
    },
    { is_backchannel: false },
    { channel_id: "!other:x" },
  ] satisfies Partial<WorkItem>[]) {
    const h = harness(`/filament connect writer ${TOKEN}`, overrides);
    assert.deepEqual(await handleGatewayItem(h.ctx), { kind: "silent" });
    assert.equal(h.drafts.length, 0);
    assert.equal(h.statuses.length, 0);
    assert.equal(h.consumed.length, 0);
  }
});

test("handleGatewayItem: a config write failure is reported as failed, and the account never pauses", async () => {
  const h = harness(`/filament connect writer ${TOKEN} r5`);
  h.ctx.mutateConfig = async () => {
    throw new Error("disk full");
  };
  assert.deepEqual(await handleGatewayItem(h.ctx), { kind: "silent" });
  assert.deepEqual(
    h.statuses.map((s) => s.state),
    ["applied", "failed"],
  );
  assert.match(h.statuses[1]!.message!, /disk full/);
});

test("handleGatewayItem: plain chatter is consumed and ignored", async () => {
  const h = harness("hi, who are you?");
  assert.deepEqual(await handleGatewayItem(h.ctx), { kind: "silent" });
  assert.deepEqual(h.consumed, ["$e1"]);
  assert.equal(h.statuses.length, 0);
  assert.equal(h.drafts.length, 0);
});

test("listGatewayAgents: a bound account carries its Filament agent", () => {
  const agents = listGatewayAgents(gatewayConfig, (id) =>
    id === "reviewer" ? "@rev:x" : undefined,
  );
  assert.equal(agents.find((a) => a.id === "reviewer")?.filamentUserId, "@rev:x");
  assert.equal(agents.find((a) => a.id === "writer")?.filamentUserId, undefined);
});

test("inventoryEntries: statuses ride along under their own origin", () => {
  const entries = inventoryEntries(
    [],
    [{ requestId: "r1", command: "connect", agentId: "writer", state: "rejected", message: "x" }],
  );
  assert.deepEqual(entries[0]!.name, "status:r1");
  assert.equal(entries[0]!.origin, "openclaw-gateway-status");
});

test("handleGatewayItem: several commands in one item are written as one mutation, in order", async () => {
  const h = harness("");
  h.ctx.item = item("", {
    messages: [
      { event_id: "$a", sender: PRINCIPAL, body: "/filament disconnect reviewer r1", ts: 1 },
      { event_id: "$b", sender: PRINCIPAL, body: "/filament unpair r2", ts: 2 },
    ],
  });
  await handleGatewayItem(h.ctx);
  assert.deepEqual(h.consumed, ["$b"]);
  assert.equal(
    h.drafts.length,
    1,
    "one write, or the reload after the first would drop the second",
  );
  assert.deepEqual(h.drafts[0]!.bindings, []);
  assert.deepEqual(
    h.statuses.map((s) => `${s.command}:${s.state}`),
    ["disconnect:applied", "unpair:applied"],
  );
});

test("applyAgentDisconnect: unbinds by agent, deleting whatever account it pointed at", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: {
        "filament-fcm": {
          config: { connectToken: "fmcp_legacy", accounts: { writer: { connectToken: "w" } } },
        },
      },
    },
    bindings: [
      { agentId: "researcher", match: { channel: "filament", accountId: "default" } },
      { agentId: "writer", match: { channel: "filament", accountId: "writer" } },
      { agentId: "researcher", match: { channel: "telegram" } },
    ],
  };
  applyAgentDisconnect(draft, "researcher");
  const config = (draft.plugins as any).entries["filament-fcm"].config;
  assert.equal(config.connectToken, undefined, "the legacy default account goes with its binding");
  assert.deepEqual(Object.keys(config.accounts), ["writer"]);
  assert.deepEqual(
    (draft.bindings as any[]).map((b) => `${b.agentId}:${b.match.channel}`),
    ["writer:filament", "researcher:telegram"],
  );
});
