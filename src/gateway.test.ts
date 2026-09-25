import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveToolAccountId } from "./accounts.js";
import {
  applyAgentConnect,
  handleGatewayItem,
  inventoryEntries,
  listGatewayAgents,
  parseGatewayCommand,
  type GatewayItemContext,
} from "./gateway.js";
import type { PollWorkItem } from "./poll-work.js";

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

function item(body: string, overrides: Partial<PollWorkItem> = {}): PollWorkItem {
  return {
    channel_id: CC_ROOM,
    thread_id: null,
    is_backchannel: true,
    messages: [{ event_id: "$e1", sender: PRINCIPAL, body, ts: 1 }],
    reply_with: { tool: "post_message", args: { channel: CC_ROOM } },
    ...overrides,
  };
}

function harness(body: string, overrides: Partial<PollWorkItem> = {}) {
  const replies: string[] = [];
  const followUps: string[] = [];
  const drafts: Record<string, unknown>[] = [];
  let reported = 0;
  const ctx: GatewayItemContext = {
    item: item(body, overrides),
    principal: PRINCIPAL,
    ccRoomId: CC_ROOM,
    gatewayConfig,
    reply: async (markdown) => {
      replies.push(markdown);
      return true;
    },
    followUp: async (markdown) => {
      followUps.push(markdown);
    },
    mutateConfig: async (mutate) => {
      const draft: Record<string, unknown> = structuredClone({ bindings: gatewayConfig.bindings });
      mutate(draft);
      drafts.push(draft);
    },
    reportInventory: async () => {
      reported += 1;
    },
    log: () => {},
  };
  return { ctx, replies, followUps, drafts, reported: () => reported };
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

test("parseGatewayCommand: connect, agents, and the rejections", () => {
  assert.deepEqual(parseGatewayCommand(`  /filament connect writer ${TOKEN} `), {
    kind: "connect",
    agentId: "writer",
    token: TOKEN,
  });
  assert.deepEqual(parseGatewayCommand("/filament agents"), { kind: "agents" });
  assert.equal(parseGatewayCommand("hello there"), null);
  assert.equal(parseGatewayCommand("/filament connect writer")?.kind, "invalid");
  assert.equal(parseGatewayCommand(`/filament connect Writer ${TOKEN}`)?.kind, "invalid");
  assert.equal(parseGatewayCommand(`/filament connect gateway ${TOKEN}`)?.kind, "invalid");
  assert.equal(parseGatewayCommand(`/filament connect default ${TOKEN}`)?.kind, "invalid");
  assert.equal(parseGatewayCommand("/filament connect writer not-a-token")?.kind, "invalid");
  assert.equal(parseGatewayCommand(`/filament connect writer ${TOKEN} extra`)?.kind, "invalid");
  assert.equal(parseGatewayCommand("/filament frobnicate")?.kind, "invalid");
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

// ── the control handler ──────────────────────────────────────────────────────

test("handleGatewayItem: connect replies first, then writes the account + binding", async () => {
  const h = harness(`/filament connect writer ${TOKEN}`);
  const outcome = await handleGatewayItem(h.ctx);
  assert.deepEqual(outcome, { kind: "published" });
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0]!, /Writer/);
  assert.ok(!h.replies[0]!.includes(TOKEN), "the token must never be echoed back");
  assert.equal(h.drafts.length, 1);
  const accounts = (h.drafts[0]!.plugins as any).entries["filament-fcm"].config.accounts;
  assert.deepEqual(accounts.writer, { connectToken: TOKEN });
});

test("handleGatewayItem: an unknown agent is refused without writing config", async () => {
  const h = harness(`/filament connect ghost ${TOKEN}`);
  await handleGatewayItem(h.ctx);
  assert.equal(h.drafts.length, 0);
  assert.match(h.replies[0]!, /no OpenClaw agent "ghost"/);
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
  ] satisfies Partial<PollWorkItem>[]) {
    const h = harness(`/filament connect writer ${TOKEN}`, overrides);
    assert.deepEqual(await handleGatewayItem(h.ctx), { kind: "silent" });
    assert.equal(h.drafts.length, 0);
    assert.equal(h.replies.length, 0);
  }
});

test("handleGatewayItem: a config write failure is reported, and the account never pauses", async () => {
  const h = harness(`/filament connect writer ${TOKEN}`);
  h.ctx.mutateConfig = async () => {
    throw new Error("disk full");
  };
  assert.deepEqual(await handleGatewayItem(h.ctx), { kind: "published" });
  assert.match(h.followUps[0]!, /disk full/);
});

test("handleGatewayItem: a reply that didn't publish acks the item instead of replaying it", async () => {
  const h = harness("/filament agents");
  h.ctx.reply = async () => false;
  assert.deepEqual(await handleGatewayItem(h.ctx), { kind: "silent" });
  assert.equal(h.reported(), 1);
});

test("handleGatewayItem: plain chatter gets a pointer, never a turn", async () => {
  const h = harness("hi, who are you?");
  assert.deepEqual(await handleGatewayItem(h.ctx), { kind: "published" });
  assert.match(h.replies[0]!, /not an agent/);
  assert.equal(h.drafts.length, 0);
});
