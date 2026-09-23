/**
 * MCP-over-HTTP client for Filament's `/mcp/agents` endpoint.
 *
 * JSON-RPC 2.0 over HTTP POST, `Authorization: Bearer <token>`,
 * `Mcp-Session-Id` capture/replay, an `initialize` + `notifications/initialized`
 * handshake, and a tool-result unwrapper.
 *
 * Every outcome is classified so a caller never mistakes an error for success
 * (see `ClientErrorKind`):
 *   - "auth"      — 401/403, or a token-revoked/invalid JSON-RPC error. The
 *                   caller should stop retrying and surface a fatal status.
 *   - "transient" — 429/5xx, a network failure, or our own call timeout.
 *                   Safe to retry with backoff.
 *   - "tool"      — the call reached the server and got a well-formed
 *                   response, but the tool itself reported failure
 *                   (`result.isError === true`, or "unknown tool").
 *   - "protocol"  — invalid JSON, a malformed envelope, or any other
 *                   JSON-RPC-level error we can't otherwise classify.
 *
 * Every call accepts an optional `AbortSignal` and a per-call timeout. A
 * timeout classifies as "transient" (ok:false, returned normally); an
 * externally-aborted signal is NOT swallowed — it rethrows so the caller
 * (the poll loop) can tell "abort" apart from "the server is slow".
 */

/** MCP protocol version we advertise. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

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

/** The outcome of a single tools/call. */
export interface ToolCallResult {
  ok: boolean;
  httpStatus: number;
  /** Parsed inner JSON from the MCP content envelope (on success, or on a "tool" failure). */
  data?: unknown;
  error?: McpError;
  /** Present only when ok is false. */
  kind?: ClientErrorKind;
}

/** Default per-call timeout for ordinary (non-long-poll) tool calls. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Margin added on top of `wait_seconds` for poll_work's long-poll timeout. */
export const POLL_TIMEOUT_MARGIN_MS = 15_000;

export interface CallOptions {
  /** Abort the call (propagates as a thrown error, never swallowed as "transient"). */
  signal?: AbortSignal;
  /** Per-call timeout in ms; a timeout is reported as ok:false / kind:"transient". */
  timeoutMs?: number;
}

/**
 * Unwrap an MCP tool result into its inner JSON. Handles both shapes seen in
 * the wild: `{ content: [{ type: "text", text }] }` (spec-standard) and
 * `{ type: "text", text }` (Filament synapse's `_handle_tools_call`). Falls
 * back to the raw value when there's no text envelope.
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

/** True when `error` is the DOMException/Error thrown by an aborted fetch. */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

/** Classify a JSON-RPC top-level `error` object. */
function classifyJsonRpcError(error: McpError): ClientErrorKind {
  // -32001 is this server's convention for an auth failure (see onboarding-core.ts);
  // -32003 covers a revoked/expired token seen from the token-exchange surface.
  if (error.code === -32001 || error.code === -32003) return "auth";
  // -32601 (method not found) means the tool itself is missing/unregistered.
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
  /** Server `instructions` from the initialize response (the first-contact directive lives here). */
  instructions: string | null = null;

  constructor(
    private readonly mcpUrl: string,
    private readonly token: string,
    private readonly clientInfo: { name: string; version: string } = {
      name: "filament-openclaw",
      version: "0.1.0",
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * POST a JSON body with a timeout + abort signal. Resolves to the HTTP
   * status and parsed JSON (or a parse-failure marker) on any response that
   * reaches us; only rethrows when the call could not complete at all
   * (network failure, our own timeout, or the caller's abort).
   */
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
      // Already aborted before we even started: abort immediately rather
      // than waiting for an "abort" event that already fired in the past.
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
        if (opts?.signal?.aborted) throw error; // caller-initiated abort: propagate as-is
        if (isAbortError(error) && timedOut) {
          // Our own timeout — a transient condition, not a thrown failure.
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

  /** MCP handshake: initialize + notifications/initialized. Idempotent. */
  async initialize(opts?: CallOptions): Promise<void> {
    if (this.initialized) return;
    const { json } = await this.post(
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

    // Notification: no id, no response body expected.
    await this.post(
      this.mcpUrl,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      false,
      opts,
    );
    this.initialized = true;
  }

  /**
   * Call an MCP tool, returning a classified result. Never throws on an
   * error envelope; only throws on a caller-initiated abort (see module
   * header), so the poll loop can distinguish "stop" from "retry".
   */
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
      // Our own timeout (see `post`): never thrown, always transient.
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

  /** Fetch the agent's own identity (principal, backchannel, mxid). Read-only. */
  getSelf(opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("get_self", {}, opts);
  }

  /** List pending loop invites for this agent. Read-only. */
  listPendingInvites(opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("list_pending_invites", {}, opts);
  }

  /** Join a loop the agent was invited into. */
  acceptInvite(loopId: string, opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("accept_invite", { loop_id: loopId }, opts);
  }

  /** List pending vouches (member-initiated) for this agent. Read-only. */
  listVouches(opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("list_vouches", {}, opts);
  }

  /** Accept a member's vouch, turning it into a proposal a loop admin approves. */
  acceptVouch(loopId: string, opts?: CallOptions): Promise<ToolCallResult> {
    return this.callTool("accept_vouch", { loop_id: loopId }, opts);
  }

  /**
   * Ask for outstanding work: a long-poll that blocks server-side up to
   * `args.wait_seconds`. The HTTP timeout must exceed that, hence the
   * caller (src/poll-work.ts) always passes an explicit `timeoutMs`.
   */
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

  /**
   * Publish a reply exactly as the server asked for it: `reply_with.tool`
   * with `reply_with.args` verbatim, plus the generated text. `reply_with`
   * only ever names `post_message` or `reply_in_thread` — both tools accept
   * `markdown_body` alongside their pre-resolved args (`channel` /
   * `message_id`), so this single call covers both.
   */
  replyWith(
    replyWithSpec: { tool: string; args: Record<string, unknown> },
    markdownBody: string,
    opts?: CallOptions,
  ): Promise<ToolCallResult> {
    return this.callTool(
      replyWithSpec.tool,
      { ...replyWithSpec.args, markdown_body: markdownBody },
      opts,
    );
  }

  /**
   * Side-channel POST to `${mcpUrl}${path}` (not JSON-RPC), bearer-authed.
   * Used by the presence/liveness endpoint.
   */
  private async sideChannelPost(path: string, body?: unknown, opts?: CallOptions): Promise<number> {
    const { status } = await this.post(`${this.mcpUrl}${path}`, body, false, opts);
    return status;
  }

  /** Presence keep-alive: POST /heartbeat (keeps the agent online). */
  heartbeat(opts?: CallOptions): Promise<number> {
    return this.sideChannelPost("/heartbeat", undefined, opts);
  }
}
