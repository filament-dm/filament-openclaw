/**
 * MCP-over-HTTP client for Filament's `/mcp/agents` endpoint.
 *
 * Failures come back classified (`ClientErrorKind`), never thrown: "auth" should stop retries,
 * "transient" is safe to retry. The exception is the caller's own abort, which rethrows so the poll
 * loop can tell stopping apart from a slow server.
 */

import { PLUGIN_VERSION } from "./version.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** The server sets `annotations.readOnlyHint` true on every read tool, false on every write tool. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
}

export interface ListToolsResult {
  ok: boolean;
  tools?: McpToolDescriptor[];
  error?: McpError;
  kind?: ClientErrorKind;
}

export type ClientErrorKind = "auth" | "transient" | "tool" | "protocol";

export interface McpError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: McpError;
}

export interface ToolCallResult {
  ok: boolean;
  httpStatus: number;
  data?: unknown;
  error?: McpError;
  kind?: ClientErrorKind;
}

const DEFAULT_TIMEOUT_MS = 15_000;
// Attachments move whole files, so they get longer than a JSON-RPC call.
const MEDIA_TIMEOUT_MS = 120_000;
export const POLL_TIMEOUT_MARGIN_MS = 15_000;

/** The body, read in chunks and cancelled once it passes `maxBytes`, with or without Content-Length. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`media is over ${maxBytes} bytes (limit ${maxBytes})`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Accepts both the spec's `{ content: [{ type: "text", text }] }` and the bare
 * `{ type: "text", text }` that Filament's server returns.
 */
export function parseToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;

  const asTextJson = (text: unknown): unknown => {
    if (typeof text !== "string") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
        const parsed = asTextJson((item as { text?: unknown }).text);
        if (parsed !== undefined) return parsed;
      }
    }
  }

  if ((result as { type?: unknown }).type === "text") {
    const parsed = asTextJson((result as { text?: unknown }).text);
    if (parsed !== undefined) return parsed;
  }

  return result;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function classifyJsonRpcError(error: McpError): ClientErrorKind {
  // -32001 is the server's auth-failure code.
  if (error.code === -32001) return "auth";
  // Policy refusals (-32003..-32006) and rejected arguments (-32602): retrying as is won't help.
  if ((error.code <= -32003 && error.code >= -32006) || error.code === -32602) return "tool";
  if (error.code === -32601) return "tool";
  const message = error.message?.toLowerCase() ?? "";
  if (
    message.includes("revoked") ||
    message.includes("unauthorized") ||
    message.includes("invalid_grant")
  ) {
    return "auth";
  }
  if (message.includes("unknown tool") || message.includes("not found")) return "tool";
  return "protocol";
}

export class FilamentMcpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;
  /** From the initialize response; carries the server's first-contact directive. */
  instructions: string | null = null;

  constructor(
    private readonly mcpUrl: string,
    private readonly token: string,
    private readonly clientInfo: { name: string; version: string } = {
      name: "filament-openclaw",
      version: PLUGIN_VERSION,
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Our own timeout resolves as status 0 with no json; throws only on network failure or abort. */
  private async post(
    url: string,
    body: unknown,
    expectJson: boolean,
    opts?: CallOptions,
  ): Promise<{ status: number; json: JsonRpcResponse | null; parseError: boolean }> {
    const controller = new AbortController();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (opts?.signal?.aborted) {
      // An "abort" event that already fired won't fire again for a late listener.
      controller.abort();
    } else {
      opts?.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
            ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (opts?.signal?.aborted) throw error;
        if (isAbortError(error) && timedOut) {
          return { status: 0, json: null, parseError: false };
        }
        throw error;
      }

      const headerSid = response.headers.get("mcp-session-id");
      if (headerSid) this.sessionId = headerSid;

      if (!expectJson || response.status === 204) {
        return { status: response.status, json: null, parseError: false };
      }
      try {
        const json = (await response.json()) as JsonRpcResponse;
        return { status: response.status, json, parseError: false };
      } catch {
        return { status: response.status, json: null, parseError: true };
      }
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async initialize(opts?: CallOptions): Promise<void> {
    if (this.initialized) return;
    const { status, json } = await this.post(
      this.mcpUrl,
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.clientInfo,
        },
      },
      true,
      opts,
    );
    // Not initialized: the next call runs the handshake again.
    if (status !== 200 || !json?.result) return;
    // Some servers carry the session id in the body rather than a header.
    const bodySid =
      json?.result && typeof json.result === "object"
        ? (json.result as { _sessionId?: unknown })._sessionId
        : undefined;
    if (typeof bodySid === "string" && bodySid) this.sessionId = bodySid;

    const instr =
      json?.result && typeof json.result === "object"
        ? (json.result as { instructions?: unknown }).instructions
        : undefined;
    this.instructions = typeof instr === "string" ? instr : null;

    await this.post(
      this.mcpUrl,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      false,
      opts,
    );
    this.initialized = true;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts?: CallOptions,
  ): Promise<ToolCallResult> {
    await this.initialize(opts);
    const { status, json, parseError } = await this.post(
      this.mcpUrl,
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      },
      true,
      opts,
    );

    if (status === 0 && !json) {
      return {
        ok: false,
        httpStatus: 0,
        kind: "transient",
        error: { code: -1, message: "request timed out" },
      };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        httpStatus: status,
        kind: "auth",
        error: { code: -32001, message: `HTTP ${status}` },
      };
    }
    if (status === 429 || status >= 500) {
      return {
        ok: false,
        httpStatus: status,
        kind: "transient",
        error: { code: -32000, message: `HTTP ${status}` },
      };
    }
    if (parseError) {
      return {
        ok: false,
        httpStatus: status,
        kind: "protocol",
        error: { code: -32700, message: "invalid JSON in response body" },
      };
    }
    if (json?.error) {
      return {
        ok: false,
        httpStatus: status,
        kind: classifyJsonRpcError(json.error),
        error: json.error,
      };
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        httpStatus: status,
        kind: "protocol",
        error: { code: -1, message: `unexpected HTTP ${status}` },
      };
    }

    const rawResult = json?.result;
    const rawIsError =
      rawResult &&
      typeof rawResult === "object" &&
      (rawResult as { isError?: unknown }).isError === true;
    const data = parseToolResult(rawResult);
    if (rawIsError) {
      const message =
        data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : "tool reported an error";
      return {
        ok: false,
        httpStatus: status,
        kind: "tool",
        data,
        error: { code: -32000, message },
      };
    }
    return { ok: true, httpStatus: status, data };
  }

  async listTools(opts?: CallOptions): Promise<ListToolsResult> {
    await this.initialize(opts);
    const { status, json, parseError } = await this.post(
      this.mcpUrl,
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} },
      true,
      opts,
    );

    if (status === 0 && !json) {
      return { ok: false, kind: "transient", error: { code: -1, message: "request timed out" } };
    }
    if (status === 401 || status === 403) {
      return { ok: false, kind: "auth", error: { code: -32001, message: `HTTP ${status}` } };
    }
    if (status === 429 || status >= 500) {
      return { ok: false, kind: "transient", error: { code: -32000, message: `HTTP ${status}` } };
    }
    if (parseError) {
      return {
        ok: false,
        kind: "protocol",
        error: { code: -32700, message: "invalid JSON in response body" },
      };
    }
    if (json?.error) {
      return { ok: false, kind: classifyJsonRpcError(json.error), error: json.error };
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        kind: "protocol",
        error: { code: -1, message: `unexpected HTTP ${status}` },
      };
    }
    const tools = (json?.result as { tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(tools)) {
      return {
        ok: false,
        kind: "protocol",
        error: { code: -1, message: "tools/list result missing a tools[] array" },
      };
    }
    const parsed: McpToolDescriptor[] = tools
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .filter((t) => typeof t.name === "string" && t.name.length > 0)
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema: t.inputSchema,
        annotations:
          t.annotations && typeof t.annotations === "object"
            ? (t.annotations as McpToolDescriptor["annotations"])
            : undefined,
      }));
    return { ok: true, tools: parsed };
  }

  getSelf(opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("get_self", {}, opts);
  }

  listPendingInvites(opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("list_pending_invites", {}, opts);
  }

  acceptInvite(loopId: string, opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("accept_invite", { loop_id: loopId }, opts);
  }

  listVouches(opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("list_vouches", {}, opts);
  }

  acceptVouch(loopId: string, opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("accept_vouch", { loop_id: loopId }, opts);
  }

  /** Blocks server-side up to `wait_seconds`: callers must pass a longer `timeoutMs`. */
  pollWork(
    args: { cursor?: string | null; ack?: string[]; wait_seconds: number; max_items: number },
    opts?: CallOptions,
  ): Promise<ToolCallResult> {
    return this.callTool(
      "poll_work",
      {
        cursor: args.cursor ?? null,
        ...(args.ack && args.ack.length > 0 ? { ack: args.ack } : {}),
        wait_seconds: args.wait_seconds,
        max_items: args.max_items,
      },
      opts,
    );
  }

  /** `reply_with` only names `post_message` or `reply_in_thread`; both take `markdown_body`. */
  replyWith(
    replyWithSpec: { tool: string; args: Record<string, unknown> },
    markdownBody: string,
    opts?: CallOptions,
    attachments: Array<{ mxc_url: string; filename?: string }> = [],
  ): Promise<ToolCallResult> {
    return this.callTool(
      replyWithSpec.tool,
      {
        ...replyWithSpec.args,
        markdown_body: markdownBody,
        ...(attachments.length ? { attachments } : {}),
      },
      opts,
    );
  }

  private async sideChannelPost(path: string, body?: unknown, opts?: CallOptions): Promise<number> {
    const { status } = await this.post(`${this.mcpUrl}${path}`, body, false, opts);
    return status;
  }

  /** GET or POST on a side-channel that moves raw bytes; the timeout aborts it. */
  private async sideChannelBytes(path: string, init: RequestInit, opts?: CallOptions) {
    const signals = [AbortSignal.timeout(opts?.timeoutMs ?? MEDIA_TIMEOUT_MS)];
    if (opts?.signal) signals.push(opts.signal);
    return await this.fetchImpl(`${this.mcpUrl}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.token}` },
      signal: AbortSignal.any(signals),
    });
  }

  /** An attachment's bytes, from the `/media` side-channel. Throws on HTTP errors and oversize. */
  async downloadMedia(
    mxcUrl: string,
    maxBytes: number,
    opts?: CallOptions,
  ): Promise<{ bytes: Buffer; contentType: string | null }> {
    const res = await this.sideChannelBytes(
      `/media?mxc_url=${encodeURIComponent(mxcUrl)}`,
      { method: "GET" },
      opts,
    );
    if (!res.ok) throw new Error(`media download returned HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new Error(`media is ${declared} bytes (limit ${maxBytes})`);
    }
    return { bytes: await readCapped(res, maxBytes), contentType: res.headers.get("content-type") };
  }

  /** Uploads bytes through the `/upload` side-channel and returns their `mxc://` url. */
  async uploadMedia(
    bytes: Uint8Array,
    contentType: string,
    filename: string | undefined,
    opts?: CallOptions,
  ): Promise<string> {
    const query = filename ? `?filename=${encodeURIComponent(filename)}` : "";
    const res = await this.sideChannelBytes(
      `/upload${query}`,
      { method: "POST", headers: { "content-type": contentType }, body: bytes },
      opts,
    );
    if (!res.ok) throw new Error(`media upload returned HTTP ${res.status}`);
    const json = (await res.json().catch(() => null)) as { mxc_url?: unknown } | null;
    if (typeof json?.mxc_url !== "string") throw new Error("media upload returned no mxc_url");
    return json.mxc_url;
  }

  heartbeat(opts?: CallOptions): Promise<number> {
    return this.sideChannelPost("/heartbeat", undefined, opts);
  }

  pong(nonce: string, opts?: CallOptions): Promise<number> {
    return this.sideChannelPost("/pong", { nonce }, opts);
  }

  reportTools(
    tools: Array<{ name: string; description?: string; origin?: string; health?: string }>,
    opts?: CallOptions,
  ): Promise<number> {
    return this.sideChannelPost("/tools", { tools }, opts);
  }
}
