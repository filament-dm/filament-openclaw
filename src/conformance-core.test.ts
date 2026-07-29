import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchOp,
  EXPECTED_PROJECT_ID,
  fingerprint,
  manifest,
  type TokenSnapshot,
} from "./conformance-core.js";

const snap: TokenSnapshot = {
  token: "example-fcm-token",
  projectId: EXPECTED_PROJECT_ID,
  senderId: "143821144946",
  connected: true,
  source: "live",
};

test("fingerprint is 12 lowercase hex and deterministic", () => {
  const fp = fingerprint("example-fcm-token");
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(fingerprint("example-fcm-token"), fp);
  assert.notEqual(fingerprint("other"), fp);
});

test("manifest advertises fcm.token", () => {
  assert.deepEqual(manifest(), { target: "openclaw", protocol: "1", ops: ["fcm.token"] });
});

test("fcm.token returns a fingerprint result when a token is cached", () => {
  const env = dispatchOp("fcm.token", { getTokenSnapshot: () => snap });
  assert.equal(env.ok, true);
  const result = env.result as Record<string, unknown>;
  assert.match(result.token_fingerprint as string, /^[0-9a-f]{12}$/);
  assert.equal(result.project_id, EXPECTED_PROJECT_ID);
  assert.equal(result.connected, true);
  assert.equal(result.source, "live");
});

test("fcm.token returns no_cached_token when nothing is cached", () => {
  const env = dispatchOp("fcm.token", { getTokenSnapshot: () => null });
  assert.equal(env.ok, false);
  assert.equal(env.error?.code, "no_cached_token");
});

test("an unknown op returns unsupported_op", () => {
  const env = dispatchOp("does.not.exist", { getTokenSnapshot: () => snap });
  assert.equal(env.ok, false);
  assert.equal(env.error?.code, "unsupported_op");
});
