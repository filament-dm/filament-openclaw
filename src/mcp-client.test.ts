import assert from "node:assert/strict";
import { test } from "node:test";

import { FilamentMcpClient } from "./mcp-client.js";

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

test("callTool: JSON-RPC top-level error classifies by code (auth / refusal as tool / protocol)", async () => {
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

  for (const code of [-32003, -32004, -32005, -32006, -32602]) {
    const refused = client([rpcError(code)]);
    assert.equal((await refused.callTool("post_message", {})).kind, "tool", `code ${code}`);
  }

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

test("initialize: a failed handshake is not remembered; the next call runs it again", async () => {
  const methods: string[] = [];
  const record =
    (handler: Handler): Handler =>
    (url, init) => {
      methods.push(JSON.parse(String(init?.body ?? "{}")).method);
      return handler(url, init);
    };
  const c = new FilamentMcpClient(
    "https://example.test/mcp/agents",
    "fmcp_test",
    undefined,
    makeFetch([
      record(() => new Response("upstream down", { status: 502 })),
      record(initHandler),
      record(notifiedHandler),
      record(
        () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              result: { content: [{ type: "text", text: "{}" }] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    ]),
  );
  await c.initialize();
  await c.callTool("get_self");
  assert.deepEqual(methods, [
    "initialize",
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
});

function sideChannelClient(handler: Handler): FilamentMcpClient {
  return new FilamentMcpClient(
    "https://example.test/mcp/agents",
    "fmcp_test",
    undefined,
    makeFetch([handler]),
  );
}

test("listTools: remembers the live tool names; a failed list keeps the last ones", async () => {
  const listed: Handler = () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "get_self" }, { name: "poll_work" }] },
      }),
      { headers: { "content-type": "application/json" } },
    );
  const c = client([listed, () => new Response("down", { status: 503 })]);
  assert.equal(c.toolNames, null);
  await c.listTools();
  assert.deepEqual([...c.toolNames!], ["get_self", "poll_work"]);
  assert.equal((await c.listTools()).ok, false);
  assert.deepEqual([...c.toolNames!], ["get_self", "poll_work"]);
});

test("downloadMedia: GETs /media with the mxc url and the bearer", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const c = sideChannelClient((url, init) => {
    seen = { url, init };
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  });
  const got = await c.downloadMedia("mxc://server/abc", 1024);
  assert.equal(seen!.url, "https://example.test/mcp/agents/media?mxc_url=mxc%3A%2F%2Fserver%2Fabc");
  assert.equal(seen!.init?.method, "GET");
  assert.equal((seen!.init?.headers as Record<string, string>).authorization, "Bearer fmcp_test");
  assert.deepEqual([...got.bytes], [1, 2, 3]);
  assert.equal(got.contentType, "image/png");
});

test("downloadMedia: refuses a file over the limit and an HTTP error", async () => {
  const big = sideChannelClient(() => new Response(new Uint8Array(10)));
  await assert.rejects(big.downloadMedia("mxc://server/abc", 5), /limit 5/);
  const missing = sideChannelClient(() => new Response("nope", { status: 404 }));
  await assert.rejects(missing.downloadMedia("mxc://server/abc", 5), /HTTP 404/);
});

test("downloadMedia: stops reading a stream with no Content-Length once it passes the limit", async () => {
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(4));
    },
    cancel() {
      cancelled = true;
    },
  });
  const c = sideChannelClient(() => new Response(endless));
  await assert.rejects(c.downloadMedia("mxc://server/abc", 10), /limit 10/);
  assert.ok(cancelled, "the body is cancelled");
  assert.ok(pulled <= 4, `read only past the limit (pulled ${pulled})`);
});

function toolResult(data: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: JSON.stringify(data) }] },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

test("downloadMedia: a server with get_media_download_url gets the message id; the signed URL goes without the bearer", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const c = client([
    (url, init) => {
      seen.push({ url, init });
      return toolResult({ download_url: "https://example.test/mcp/agents/media/signed/tok" });
    },
    (url, init) => {
      seen.push({ url, init });
      return new Response(new Uint8Array([7, 8]), { headers: { "content-type": "image/png" } });
    },
  ]);
  c.toolNames = new Set(["get_media_download_url"]);
  const got = await c.downloadMedia("mxc://server/abc", 1024, { messageId: "$m" });
  assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)).params, {
    name: "get_media_download_url",
    arguments: { mxc_url: "mxc://server/abc", message_id: "$m" },
  });
  assert.equal(seen[1]!.url, "https://example.test/mcp/agents/media/signed/tok");
  assert.equal(seen[1]!.init?.method, "GET");
  assert.equal(seen[1]!.init?.headers, undefined);
  assert.deepEqual([...got.bytes], [7, 8]);
  assert.equal(got.contentType, "image/png");
});

test("downloadMedia: a refusal inside an ok result skips the file, with no fallback to the bearer", async () => {
  let calls = 0;
  const c = client([
    () => {
      calls += 1;
      return toolResult({ error: "mxc://server/abc is not an attachment of message $m" });
    },
  ]);
  c.toolNames = new Set(["get_media_download_url"]);
  await assert.rejects(
    c.downloadMedia("mxc://server/abc", 1024, { messageId: "$m" }),
    /not an attachment of message/,
  );
  assert.equal(calls, 1);
});

test("downloadMedia: the signed URL keeps the size cap", async () => {
  const c = client([
    () => toolResult({ download_url: "https://example.test/signed/tok" }),
    () => new Response(new Uint8Array(10)),
  ]);
  c.toolNames = new Set(["get_media_download_url"]);
  await assert.rejects(c.downloadMedia("mxc://server/abc", 5, { messageId: "$m" }), /limit 5/);
});

test("downloadMedia: an older server, or no message id, uses the /media side-channel", async () => {
  const urls: string[] = [];
  const c = sideChannelClient((url) => {
    urls.push(url);
    return new Response(new Uint8Array([1]));
  });
  await c.downloadMedia("mxc://server/abc", 1024, { messageId: "$m" });
  c.toolNames = new Set(["get_media_download_url"]);
  await c.downloadMedia("mxc://server/abc", 1024);
  assert.deepEqual(urls, [
    "https://example.test/mcp/agents/media?mxc_url=mxc%3A%2F%2Fserver%2Fabc",
    "https://example.test/mcp/agents/media?mxc_url=mxc%3A%2F%2Fserver%2Fabc",
  ]);
});

test("uploadMedia: POSTs the bytes to /upload and returns the mxc url", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const c = sideChannelClient((url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ mxc_url: "mxc://server/up" }));
  });
  const mxc = await c.uploadMedia(new Uint8Array([9]), "application/pdf", "a b.pdf");
  assert.equal(mxc, "mxc://server/up");
  assert.equal(seen!.url, "https://example.test/mcp/agents/upload?filename=a%20b.pdf");
  assert.equal(seen!.init?.method, "POST");
  const headers = seen!.init?.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/pdf");
  assert.equal(headers.authorization, "Bearer fmcp_test");
});

test("replyWith: adds attachments only when there are some", async () => {
  const bodies: unknown[] = [];
  const toolHandler: Handler = (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)).params.arguments);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: JSON.stringify({ event_id: "$r" }) }] },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const c = client([toolHandler, toolHandler]);
  const spec = { tool: "post_message", args: { channel: "!r:s" } };
  await c.replyWith(spec, "text");
  await c.replyWith(spec, "", undefined, [{ mxc_url: "mxc://s/1", filename: "x.png" }]);
  assert.deepEqual(bodies, [
    { channel: "!r:s", markdown_body: "text" },
    {
      channel: "!r:s",
      markdown_body: "",
      attachments: [{ mxc_url: "mxc://s/1", filename: "x.png" }],
    },
  ]);
});
