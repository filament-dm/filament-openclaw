import assert from "node:assert/strict";
import { test } from "node:test";

import { listConfiguredAccountIds } from "./accounts.js";
import { DEVICE_GRANT } from "./oauth-login.js";
import {
  applySignInResult,
  finishPendingSignIn,
  parsePendingSignIn,
  toPendingSignIn,
  type FinishSignInParams,
} from "./sign-in.js";
import type { SignInEnd } from "./state/sign-in.js";
import { fakeHttp, ISSUER, MCP, type Answer } from "./testing/fake-oauth.js";

const T0 = Date.parse("2026-10-13T12:00:00.000Z");

const AUTH = {
  deviceCode: "dev_1",
  clientId: "client-1",
  tokenEndpoint: `${ISSUER}/token`,
  resource: MCP,
  interval: 5,
  expiresAt: T0 + 600_000,
};

const STORED = { ...AUTH, expiresAt: "2026-10-13T12:10:00.000Z" };

test("toPendingSignIn / parsePendingSignIn: round trip, with an ISO expiry in the config", () => {
  assert.deepEqual(toPendingSignIn(AUTH), STORED);
  assert.deepEqual(parsePendingSignIn(STORED), AUTH);
  assert.equal(parsePendingSignIn({ ...STORED, interval: undefined })?.interval, 5);
  assert.equal(parsePendingSignIn({ ...STORED, deviceCode: "" }), undefined);
  assert.equal(parsePendingSignIn({ ...STORED, expiresAt: "soon" }), undefined);
  assert.equal(parsePendingSignIn(undefined), undefined);
});

test("listConfiguredAccountIds: an account with only a pending sign-in starts, to finish it", () => {
  const cfg = { accounts: { main: { pendingSignIn: STORED }, idle: {} } };
  assert.deepEqual(listConfiguredAccountIds(cfg, {}), ["main"]);
});

function draftWith(account: Record<string, unknown>) {
  return {
    plugins: { entries: { "filament-openclaw": { config: { accounts: { main: account } } } } },
  } as Record<string, unknown>;
}

const accountOf = (draft: Record<string, unknown>) =>
  (draft as any).plugins.entries["filament-openclaw"].config.accounts.main;

test("applySignInResult: the token replaces this pending sign-in, never a newer one", () => {
  const draft = draftWith({ pendingSignIn: STORED, mcpUrl: MCP });
  assert.equal(applySignInResult(draft, "main", "dev_1", "fmcp_ok"), true);
  assert.deepEqual(accountOf(draft), { mcpUrl: MCP, connectToken: "fmcp_ok" });

  const newer = draftWith({ pendingSignIn: { ...STORED, deviceCode: "dev_2" } });
  assert.equal(applySignInResult(newer, "main", "dev_1", "fmcp_ok"), false);
  assert.equal(accountOf(newer).pendingSignIn.deviceCode, "dev_2");

  const ended = draftWith({ pendingSignIn: STORED });
  ended.bindings = [
    { agentId: "main", match: { channel: "filament", accountId: "main" } },
    { agentId: "main", match: { channel: "slack" } },
  ];
  assert.equal(applySignInResult(ended, "main", "dev_1"), true);
  assert.equal(accountOf(ended), undefined);
  assert.deepEqual(ended.bindings, [{ agentId: "main", match: { channel: "slack" } }]);
});

/** A gateway account finishing a sign-in against a fake server and a fake config. */
async function finish(tokenAnswers: Answer[], overrides: Partial<FinishSignInParams> = {}) {
  const http = fakeHttp({}, tokenAnswers);
  const draft = draftWith({ pendingSignIn: STORED });
  const logs: string[] = [];
  const ends: Array<[string, SignInEnd]> = [];
  const cleared: string[] = [];
  let writes = 0;
  let clock = T0;
  const outcome = await finishPendingSignIn({
    accountId: "main",
    pending: AUTH,
    abortSignal: new AbortController().signal,
    log: (line) => void logs.push(line),
    fetch: http.fetch,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    writeConfig: async (mutate) => {
      writes++;
      mutate(draft);
      return true;
    },
    saveEnd: (id, end) => void ends.push([id, end]),
    clearEnd: (id) => void cleared.push(id),
    ...overrides,
  });
  return { outcome, account: accountOf(draft), logs, ends, cleared, writes, http };
}

test("finishPendingSignIn: waits out pending and slow_down, then saves the token", async () => {
  const run = await finish([
    [400, { error: "authorization_pending" }],
    [400, { error: "slow_down" }],
    [200, { access_token: "fmcp_ok", agent_user_id: "@a:x" }],
  ]);
  assert.equal(run.outcome, "signed-in");
  assert.deepEqual(run.account, { connectToken: "fmcp_ok" });
  assert.deepEqual(run.logs, [
    "filament: waiting for sign-in approval",
    "filament: sign-in approved; saving the token",
  ]);
  assert.deepEqual(run.cleared, ["main"]);
  const form = run.http.calls.at(-1)!.form;
  assert.deepEqual(form, {
    grant_type: DEVICE_GRANT,
    device_code: "dev_1",
    client_id: "client-1",
    resource: MCP,
  });
  // Neither the device code nor the token reaches the log.
  for (const line of run.logs) assert.ok(!/dev_1|fmcp_ok/.test(line));
});

test("finishPendingSignIn: expiry and denial drop the pending sign-in and say so once", async () => {
  const expired = await finish(
    Array.from({ length: 200 }, () => [400, { error: "authorization_pending" }] as Answer),
  );
  assert.equal(expired.outcome, "expired");
  assert.equal(expired.account, undefined);
  assert.equal(
    expired.logs.at(-1),
    "filament: sign-in link expired; run openclaw filament login again",
  );
  assert.deepEqual(expired.ends, [["main", { reason: "expired", at: T0 + 600_000 }]]);

  const tokenExpired = await finish([[400, { error: "expired_token" }]]);
  assert.equal(tokenExpired.outcome, "expired");

  const denied = await finish([[400, { error: "access_denied" }]]);
  assert.equal(denied.outcome, "denied");
  assert.equal(denied.account, undefined);
  assert.equal(
    denied.logs.at(-1),
    "filament: sign-in was declined; run openclaw filament login again",
  );

  const failed = await finish([[400, { error: "invalid_grant", error_description: "bad" }]]);
  assert.equal(failed.outcome, "failed");
  assert.match(failed.logs.at(-1)!, /sign-in failed \(.*bad\); run openclaw filament login again/);
});

test("finishPendingSignIn: an unreachable or failing server is retried, said once", async () => {
  const run = await finish([
    new TypeError("fetch failed"),
    [502, { error: "bad gateway" }],
    [200, { access_token: "fmcp_ok" }],
  ]);
  assert.equal(run.outcome, "signed-in");
  assert.equal(run.logs.filter((line) => line.includes("retrying")).length, 1);
});

test("finishPendingSignIn: an abort stops the wait and leaves the pending sign-in", async () => {
  const controller = new AbortController();
  const run = await finish([[400, { error: "authorization_pending" }]], {
    abortSignal: controller.signal,
    sleep: async () => controller.abort(),
  });
  assert.equal(run.outcome, "aborted");
  assert.equal(run.writes, 0);
  assert.equal(run.account.pendingSignIn.deviceCode, "dev_1");
});

test("finishPendingSignIn: a newer login wins; a failed save is retried", async () => {
  const http = fakeHttp({}, [[200, { access_token: "fmcp_ok" }]]);
  const newer = draftWith({ pendingSignIn: { ...STORED, deviceCode: "dev_2" } });
  const logs: string[] = [];
  const outcome = await finishPendingSignIn({
    accountId: "main",
    pending: AUTH,
    abortSignal: new AbortController().signal,
    log: (line) => void logs.push(line),
    fetch: http.fetch,
    sleep: async () => {},
    now: () => T0,
    writeConfig: async (mutate) => {
      mutate(newer);
      return true;
    },
  });
  assert.equal(outcome, "superseded");
  assert.equal(accountOf(newer).pendingSignIn.deviceCode, "dev_2");

  let attempts = 0;
  const retried = await finish([[200, { access_token: "fmcp_ok" }]], {
    retryWriteMs: 1,
    writeConfig: async (mutate) => {
      if (++attempts < 3) throw new Error("openclaw config patch failed (exit 1)");
      mutate(draftWith({ pendingSignIn: STORED }));
      return true;
    },
  });
  assert.equal(retried.outcome, "signed-in");
  assert.equal(attempts, 3);
});
