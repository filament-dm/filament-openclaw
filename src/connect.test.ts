import assert from "node:assert/strict";
import { test } from "node:test";

import { exchangeConnectToken, resolveBearer } from "./connect.js";

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function makeFetch(handlers: Handler[]): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: RequestInit) => {
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    if (!handler) throw new Error("no more mock responses queued");
    return handler(String(url), init);
  }) as unknown as typeof fetch;
}

function memoryPersistence(initial?: string) {
  let stored = initial;
  return {
    load: () => stored,
    save: (bearer: string) => {
      stored = bearer;
    },
  };
}

test("resolveBearer: an already-issued bearer is used directly (no exchange call)", async () => {
  const fetchImpl = makeFetch([
    () => {
      throw new Error("should not be called");
    },
  ]);
  const bearer = await resolveBearer(
    "https://x.test/mcp/agents",
    "already-a-bearer-token",
    () => {},
    undefined,
    fetchImpl,
    memoryPersistence(),
  );
  assert.equal(bearer, "already-a-bearer-token");
});

test("resolveBearer: a persisted bearer skips the exchange entirely", async () => {
  const fetchImpl = makeFetch([
    () => {
      throw new Error("should not be called — a persisted bearer must skip exchange");
    },
  ]);
  const bearer = await resolveBearer(
    "https://x.test/mcp/agents",
    "fmcp_sometoken",
    () => {},
    undefined,
    fetchImpl,
    memoryPersistence("persisted-bearer"),
  );
  assert.equal(bearer, "persisted-bearer");
});

test("exchangeConnectToken: posts form-urlencoded RFC 8693 params to <mcpUrl>/oauth/token", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  let capturedContentType = "";
  const fetchImpl = makeFetch([
    (url, init) => {
      capturedUrl = url;
      capturedBody = String(init?.body);
      capturedContentType = ((init?.headers ?? {}) as Record<string, string>)["content-type"];
      return new Response(JSON.stringify({ access_token: "new-bearer-123" }), { status: 200 });
    },
  ]);
  const bearer = await exchangeConnectToken(
    "https://x.test/mcp/agents",
    "fmcp_subject",
    () => {},
    undefined,
    fetchImpl,
  );
  assert.equal(bearer, "new-bearer-123");
  assert.equal(capturedUrl, "https://x.test/mcp/agents/oauth/token");
  assert.equal(capturedContentType, "application/x-www-form-urlencoded");
  const params = new URLSearchParams(capturedBody);
  assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(params.get("subject_token"), "fmcp_subject");
  assert.equal(params.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
});

test("exchangeConnectToken: retries on authorization_pending, then succeeds", async () => {
  let calls = 0;
  const fetchImpl = makeFetch([
    () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: "authorization_pending", error_description: "not finalized" }),
        { status: 400 },
      );
    },
    () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: "eventually-issued" }), { status: 200 });
    },
  ]);
  const logs: string[] = [];
  const bearer = await exchangeConnectToken(
    "https://x.test/mcp/agents",
    "fmcp_subject",
    (m) => logs.push(m),
    undefined,
    fetchImpl,
  );
  assert.equal(bearer, "eventually-issued");
  assert.equal(calls, 2);
});

test("exchangeConnectToken: a rejected/already-used subject token throws immediately (no retry)", async () => {
  let calls = 0;
  const fetchImpl = makeFetch([
    () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "subject_token already exchanged",
        }),
        { status: 401 },
      );
    },
  ]);
  await assert.rejects(
    exchangeConnectToken(
      "https://x.test/mcp/agents",
      "fmcp_subject",
      () => {},
      undefined,
      fetchImpl,
    ),
  );
  assert.equal(calls, 1);
});

test("exchangeConnectToken: an abort during the finalization wait stops retrying", async () => {
  const fetchImpl = makeFetch([
    () => new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
  ]);
  const controller = new AbortController();
  const promise = exchangeConnectToken(
    "https://x.test/mcp/agents",
    "fmcp_subject",
    () => {},
    controller.signal,
    fetchImpl,
  );
  controller.abort();
  await assert.rejects(promise, /aborted/i);
});
