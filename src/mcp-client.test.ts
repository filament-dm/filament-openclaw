import assert from "node:assert/strict";
import { test } from "node:test";

import { FilamentMcpClient } from "./mcp-client.js";

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Build a fake `fetch` that serves one handler per call, in order. */
function makeFetch(handlers: Handler[]): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: RequestInit) => {
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    if (!handler) throw new Error("no more mock responses queued");
    return handler(String(url), init);
  }) as unknown as typeof fetch;
}

const initHandler: Handler = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { instructions: null } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const notifiedHandler: Handler = () => new Response(null, { status: 204 });

function client(toolHandlers: Handler[]): FilamentMcpClient {
  return new FilamentMcpClient(
    "https://example.test/mcp/agents",
    "fmcp_test",
    undefined,
    makeFetch([initHandler, notifiedHandler, ...toolHandlers]),
  );
}

test("callTool: success unwraps the content[] text-JSON envelope", async () => {
  const c = client([
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: '{"mxid":"@a:hs"}' }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ]);
  const res = await c.callTool("get_self", {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { mxid: "@a:hs" });
});

test("callTool: HTTP 401/403 classify as auth", async () => {
  for (const status of [401, 403]) {
    const c = client([() => new Response(JSON.stringify({}), { status })]);
    const res = await c.callTool("get_self", {});
    assert.equal(res.ok, false);
    assert.equal(res.kind, "auth");
  }
});

test("callTool: HTTP 502/504/429 classify as transient", async () => {
  for (const status of [502, 504, 429]) {
    const c = client([() => new Response(JSON.stringify({}), { status })]);
    const res = await c.callTool("get_self", {});
    assert.equal(res.ok, false);
    assert.equal(res.kind, "transient");
  }
});

test("callTool: invalid JSON body classifies as protocol", async () => {
  const c = client([() => new Response("{not json", { status: 200 })]);
  const res = await c.callTool("get_self", {});
  assert.equal(res.ok, false);
  assert.equal(res.kind, "protocol");
});

test("callTool: JSON-RPC top-level error classifies by code (auth / tool / protocol)", async () => {
  const rpcError = (code: number) => () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code, message: "x" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const auth = client([rpcError(-32001)]);
  assert.equal((await auth.callTool("get_self", {})).kind, "auth");

  const revoked = client([
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32000, message: "token revoked" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ]);
  assert.equal((await revoked.callTool("get_self", {})).kind, "auth");

  const missingTool = client([rpcError(-32601)]);
  assert.equal((await missingTool.callTool("nonexistent_tool", {})).kind, "tool");

  const protocolErr = client([rpcError(-32700)]);
  assert.equal((await protocolErr.callTool("get_self", {})).kind, "protocol");
});

test("callTool: result.isError === true classifies as tool, even on HTTP 200", async () => {
  const c = client([
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { isError: true, content: [{ type: "text", text: '{"error":"unknown tool"}' }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ]);
  const res = await c.callTool("bogus", {});
  assert.equal(res.ok, false);
  assert.equal(res.kind, "tool");
});

test("callTool: our own timeout classifies as transient (never throws)", async () => {
  const c = client([
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        // Mimics real fetch: never resolves on its own, only rejects once
        // the client's internal timeout aborts the request.
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  ]);
  const res = await c.callTool("get_self", {}, { timeoutMs: 20 });
  assert.equal(res.ok, false);
  assert.equal(res.kind, "transient");
});

test("callTool: an externally-aborted signal rethrows instead of returning transient", async () => {
  const c = client([
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  ]);
  const controller = new AbortController();
  const callPromise = c.callTool("poll_work", {}, { signal: controller.signal, timeoutMs: 5_000 });
  controller.abort();
  await assert.rejects(callPromise);
});

test("pollWork sends cursor/ack/wait_seconds/max_items and replyWith merges args + markdown_body verbatim", async () => {
  let capturedBody: unknown;
  const c = client([
    (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "{}" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  ]);
  await c.pollWork({ cursor: "c:abc", ack: ["$e1"], wait_seconds: 60, max_items: 1 });
  const body = capturedBody as { params: { name: string; arguments: Record<string, unknown> } };
  assert.equal(body.params.name, "poll_work");
  assert.deepEqual(body.params.arguments, {
    cursor: "c:abc",
    ack: ["$e1"],
    wait_seconds: 60,
    max_items: 1,
  });

  let capturedReplyBody: unknown;
  const c2 = client([
    (_url, init) => {
      capturedReplyBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: '{"event_id":"$x"}' }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  ]);
  await c2.replyWith({ tool: "reply_in_thread", args: { message_id: "$root" } }, "hello");
  const replyBody = capturedReplyBody as {
    params: { name: string; arguments: Record<string, unknown> };
  };
  assert.equal(replyBody.params.name, "reply_in_thread");
  assert.deepEqual(replyBody.params.arguments, { message_id: "$root", markdown_body: "hello" });
});
