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

test("resolveMcpSettings: the transport defaults to fcm; poll only by name", () => {
  assert.equal(resolveMcpSettings({}, {}).transport, "fcm");
  assert.equal(resolveMcpSettings({ transport: "poll" }, {}).transport, "poll");
  assert.equal(resolveMcpSettings({ transport: "POLL" }, {}).transport, "poll");
  assert.equal(resolveMcpSettings({ transport: "carrier-pigeon" }, {}).transport, "fcm");
  assert.equal(resolveMcpSettings({}, { FILAMENT_TRANSPORT: "poll" }).transport, "poll");
  assert.equal(
    resolveMcpSettings({ transport: "fcm" }, { FILAMENT_TRANSPORT: "poll" }).transport,
    "fcm",
  );
});

test("resolveMcpSettings: firebase is config, then FILAMENT_FIREBASE_*, then production", () => {
  assert.equal(resolveMcpSettings({}, {}).firebase.projectId, "filament-8ce44");
  const custom = resolveMcpSettings(
    { firebase: { appId: "1:1:android:abc" } },
    { FILAMENT_FIREBASE_PROJECT_ID: "test-project" },
  ).firebase;
  assert.equal(custom.projectId, "test-project");
  assert.equal(custom.appId, "1:1:android:abc");
  assert.equal(custom.messagingSenderId, "143821144946");
});
