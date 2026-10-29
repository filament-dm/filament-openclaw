import assert from "node:assert/strict";
import { test } from "node:test";

import { listConfiguredAccountIds, resolveToolAccountId, retiredAccountKind } from "./accounts.js";
import { connectTokenConfigPath, resolveAccountSettings } from "./settings.js";

const binding = (agentId: string, accountId: string) => ({
  agentId,
  match: { channel: "filament", accountId },
});

test("listConfiguredAccountIds: nothing configured lists the idle default account", () => {
  assert.deepEqual(listConfiguredAccountIds({}, {}), ["default"]);
});

test("listConfiguredAccountIds: accounts entries, plus default only with a legacy token", () => {
  const accounts = { researcher: { connectToken: "fmcp_a" }, writer: { connectToken: "fmcp_b" } };
  assert.deepEqual(listConfiguredAccountIds({ accounts }, {}), ["researcher", "writer"]);
  assert.deepEqual(listConfiguredAccountIds({ accounts, connectToken: "fmcp_x" }, {}), [
    "default",
    "researcher",
    "writer",
  ]);
  assert.deepEqual(listConfiguredAccountIds({ accounts: { empty: {} } }, {}), ["default"]);
});

test("resolveAccountSettings: an account's token, the shared mcpUrl, never the env token", () => {
  const cfg = {
    mcpUrl: "http://local/mcp/agents",
    connectToken: "fmcp_legacy",
    accounts: { writer: { connectToken: "fmcp_writer" } },
  };
  const env = { FILAMENT_MCP_TOKEN: "fmcp_env" };
  const writer = resolveAccountSettings(cfg, "writer", env);
  assert.equal(writer.tokenInput, "fmcp_writer");
  assert.equal(writer.mcpUrl, "http://local/mcp/agents");
  assert.equal(resolveAccountSettings(cfg, "default", env).tokenInput, "fmcp_legacy");
  assert.equal(resolveAccountSettings(cfg, "ghost", env).tokenInput, undefined);
});

test("connectTokenConfigPath: legacy default vs per-account path", () => {
  assert.equal(
    connectTokenConfigPath("filament-openclaw", "default", { connectToken: "x" }),
    "plugins.entries.filament-openclaw.config.connectToken",
  );
  assert.equal(
    connectTokenConfigPath("filament-openclaw", "writer", {}),
    "plugins.entries.filament-openclaw.config.accounts.writer.connectToken",
  );
});

test("resolveToolAccountId: a Filament turn's own account wins", () => {
  assert.equal(
    resolveToolAccountId({ messageChannel: "filament", agentAccountId: "writer", agentId: "x" }),
    "writer",
  );
});

test("resolveToolAccountId: other turns follow the agent's binding", () => {
  const config = { bindings: [binding("researcher", "researcher"), binding("writer", "writer")] };
  assert.equal(resolveToolAccountId({ agentId: "writer", config }), "writer");
  assert.equal(resolveToolAccountId({ agentId: "coordinator", config }), null);
});

test("resolveToolAccountId: an unbound single-account install gets that account", () => {
  const config = {
    plugins: { entries: { "filament-openclaw": { config: { connectToken: "fmcp_x" } } } },
  };
  assert.equal(resolveToolAccountId({ agentId: "main", config }, undefined, {}), "default");
  const two = {
    plugins: {
      entries: {
        "filament-openclaw": {
          config: { accounts: { a: { connectToken: "x" }, b: { connectToken: "y" } } },
        },
      },
    },
  };
  assert.equal(resolveToolAccountId({ agentId: "main", config: two }, undefined, {}), null);
});

test("resolveAccountSettings: an account with a retired transport still resolves its own token", () => {
  const cfg = {
    transport: "fcm",
    accounts: { reviewer: { connectToken: "fmcp_r", transport: "fcm" } },
  };
  assert.equal(resolveAccountSettings(cfg, "reviewer", {}).tokenInput, "fmcp_r");
});

test("retiredAccountKind: gateway control and agent-choice accounts are retired, never a tool's", () => {
  const cfg = {
    accounts: {
      gateway: { connectToken: "fmcp_g", control: true },
      "pending-abc": { connectToken: "fmcp_p", pending: true },
      writer: { connectToken: "fmcp_w" },
    },
  };
  assert.equal(retiredAccountKind(cfg, "gateway"), "control");
  assert.equal(retiredAccountKind(cfg, "pending-abc"), "pending");
  assert.equal(retiredAccountKind(cfg, "writer"), undefined);
  // Unbound, the one live account is the only candidate for a tool call.
  const gatewayConfig = { plugins: { entries: { "filament-openclaw": { config: cfg } } } };
  assert.equal(resolveToolAccountId({ config: gatewayConfig }, undefined, {}), "writer");
});
