import assert from "node:assert/strict";
import { test } from "node:test";

import { listConfiguredAccountIds, resolveToolAccountId } from "./accounts.js";
import { connectTokenConfigPath, resolveAccountSettings } from "./connect.js";

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
    connectTokenConfigPath("filament-fcm", "default", { connectToken: "x" }),
    "plugins.entries.filament-fcm.config.connectToken",
  );
  assert.equal(
    connectTokenConfigPath("filament-fcm", "writer", {}),
    "plugins.entries.filament-fcm.config.accounts.writer.connectToken",
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
    plugins: { entries: { "filament-fcm": { config: { connectToken: "fmcp_x" } } } },
  };
  assert.equal(resolveToolAccountId({ agentId: "main", config }, undefined, {}), "default");
  const two = {
    plugins: {
      entries: {
        "filament-fcm": {
          config: { accounts: { a: { connectToken: "x" }, b: { connectToken: "y" } } },
        },
      },
    },
  };
  assert.equal(resolveToolAccountId({ agentId: "main", config: two }, undefined, {}), null);
});
