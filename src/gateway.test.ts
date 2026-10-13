import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveToolAccountId } from "./accounts.js";
import { applyAgentConnect, listGatewayAgents } from "./gateway.js";

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

test("applyAgentConnect: creates the account and binding on an empty draft", () => {
  const draft: Record<string, unknown> = {};
  const { displaced } = applyAgentConnect(draft, "writer", TOKEN);
  assert.deepEqual(displaced, []);
  assert.deepEqual(draft, {
    plugins: {
      entries: {
        "filament-openclaw": { config: { accounts: { writer: { connectToken: TOKEN } } } },
      },
    },
    bindings: [{ agentId: "writer", match: { channel: "filament", accountId: "writer" } }],
  });
});

test("applyAgentConnect: keeps other channels and accounts", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: {
        "filament-openclaw": {
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
  const config = (draft.plugins as any).entries["filament-openclaw"].config;
  assert.equal(config.mcpUrl, "http://x/mcp/agents");
  assert.deepEqual(config.accounts.gateway, { connectToken: "fmcp_g", control: true });
  assert.deepEqual(config.accounts.reviewer, { connectToken: "fmcp_r" });
  assert.deepEqual(config.accounts.writer, { connectToken: TOKEN });
  assert.equal((draft.bindings as unknown[]).length, 3);
});

test("applyAgentConnect: one Filament account per agent — the displaced one is removed", () => {
  const draft: Record<string, unknown> = {
    plugins: {
      entries: { "filament-openclaw": { config: { connectToken: "fmcp_legacy", accounts: {} } } },
    },
    bindings: [{ agentId: "researcher", match: { channel: "filament", accountId: "default" } }],
  };
  const { displaced } = applyAgentConnect(draft, "researcher", TOKEN);
  assert.deepEqual(displaced, ["default"]);
  const config = (draft.plugins as any).entries["filament-openclaw"].config;
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
        "filament-openclaw": {
          config: { accounts: { gateway: { connectToken: "fmcp_g", control: true } } },
        },
      },
    },
  };
  // Before any connect: only a retired control account exists; no agent gets tools.
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
