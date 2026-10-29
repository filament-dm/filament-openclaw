import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveMcpSettings } from "./settings.js";

test("resolveMcpSettings: pollWaitSeconds is undefined when not configured", () => {
  const settings = resolveMcpSettings({}, {});
  assert.equal(settings.pollWaitSeconds, undefined);
});

test("resolveMcpSettings: an in-range pollWaitSeconds passes through unchanged", () => {
  const settings = resolveMcpSettings({ pollWaitSeconds: 45 }, {});
  assert.equal(settings.pollWaitSeconds, 45);
});

test("resolveMcpSettings: pollWaitSeconds is clamped to the [1, 60] range", () => {
  assert.equal(resolveMcpSettings({ pollWaitSeconds: 0 }, {}).pollWaitSeconds, 1);
  assert.equal(resolveMcpSettings({ pollWaitSeconds: -5 }, {}).pollWaitSeconds, 1);
  assert.equal(resolveMcpSettings({ pollWaitSeconds: 61 }, {}).pollWaitSeconds, 60);
  assert.equal(resolveMcpSettings({ pollWaitSeconds: 999 }, {}).pollWaitSeconds, 60);
});

test("resolveMcpSettings: a non-numeric pollWaitSeconds is ignored (falls back to undefined)", () => {
  assert.equal(
    resolveMcpSettings({ pollWaitSeconds: "not-a-number" }, {}).pollWaitSeconds,
    undefined,
  );
  assert.equal(resolveMcpSettings({ pollWaitSeconds: null }, {}).pollWaitSeconds, undefined);
});

test("resolveMcpSettings: a numeric string pollWaitSeconds is parsed and clamped", () => {
  assert.equal(resolveMcpSettings({ pollWaitSeconds: "45" }, {}).pollWaitSeconds, 45);
  assert.equal(resolveMcpSettings({ pollWaitSeconds: "500" }, {}).pollWaitSeconds, 60);
});

test("resolveMcpSettings: retired settings are ignored", () => {
  const settings = resolveMcpSettings(
    { transport: "fcm", firebase: { projectId: "p" }, connectToken: "fmcp_x" },
    { FILAMENT_TRANSPORT: "fcm", FILAMENT_FIREBASE_PROJECT_ID: "q" },
  );
  assert.deepEqual(Object.keys(settings).sort(), ["mcpUrl", "pollWaitSeconds", "tokenInput"]);
  assert.equal(settings.tokenInput, "fmcp_x");
});

test("resolveMcpSettings: a bare server means its agents endpoint", () => {
  assert.equal(
    resolveMcpSettings({ mcpUrl: "http://filament-dev.local:8448/" }, {}).mcpUrl,
    "http://filament-dev.local:8448/mcp/agents",
  );
  assert.equal(
    resolveMcpSettings({}, { FILAMENT_MCP_URL: "https://x/custom" }).mcpUrl,
    "https://x/custom",
  );
});
