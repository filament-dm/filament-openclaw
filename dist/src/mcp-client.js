const MCP_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_TIMEOUT_MS = 15e3;
const POLL_TIMEOUT_MARGIN_MS = 15e3;
function parseToolResult(result) {
  if (!result || typeof result !== "object") return result;
  const asTextJson = (text) => {
    if (typeof text !== "string") return void 0;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const content = result.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && item.type === "text") {
        const parsed = asTextJson(item.text);
        if (parsed !== void 0) return parsed;
      }
    }
  }
  if (result.type === "text") {
    const parsed = asTextJson(result.text);
    if (parsed !== void 0) return parsed;
  }
  return result;
}
function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError" || typeof error === "object" && error !== null && error.name === "AbortError";
}
function classifyJsonRpcError(error) {
  if (error.code === -32001 || error.code === -32003) return "auth";
  if (error.code === -32601) return "tool";
  const message = error.message?.toLowerCase() ?? "";
  if (message.includes("revoked") || message.includes("unauthorized") || message.includes("invalid_grant")) {
    return "auth";
  }
  if (message.includes("unknown tool") || message.includes("not found")) return "tool";
  return "protocol";
}
class FilamentMcpClient {
  constructor(mcpUrl, token, clientInfo = {
    name: "filament-openclaw",
    version: "0.1.0"
  }, fetchImpl = fetch) {
    this.mcpUrl = mcpUrl;
    this.token = token;
    this.clientInfo = clientInfo;
    this.fetchImpl = fetchImpl;
  }
  sessionId = null;
  nextId = 1;
  initialized = false;
  /** Server `instructions` from the initialize response (the first-contact directive lives here). */
  instructions = null;
  /**
   * POST a JSON body with a timeout + abort signal. Resolves to the HTTP
   * status and parsed JSON (or a parse-failure marker) on any response that
   * reaches us; only rethrows when the call could not complete at all
   * (network failure, our own timeout, or the caller's abort).
   */
  async post(url, body, expectJson, opts) {
    const controller = new AbortController();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (opts?.signal?.aborted) {
      controller.abort();
    } else {
      opts?.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
            ...this.sessionId ? { "mcp-session-id": this.sessionId } : {}
          },
          body: body === void 0 ? void 0 : JSON.stringify(body),
          signal: controller.signal
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
        const json = await response.json();
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
  async initialize(opts) {
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
          clientInfo: this.clientInfo
        }
      },
      true,
      opts
    );
    const bodySid = json?.result && typeof json.result === "object" ? json.result._sessionId : void 0;
    if (typeof bodySid === "string" && bodySid) this.sessionId = bodySid;
    const instr = json?.result && typeof json.result === "object" ? json.result.instructions : void 0;
    this.instructions = typeof instr === "string" ? instr : null;
    await this.post(
      this.mcpUrl,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      false,
      opts
    );
    this.initialized = true;
  }
  /**
   * Call an MCP tool, returning a classified result. Never throws on an
   * error envelope; only throws on a caller-initiated abort (see module
   * header), so the poll loop can distinguish "stop" from "retry".
   */
  async callTool(name, args = {}, opts) {
    await this.initialize(opts);
    const { status, json, parseError } = await this.post(
      this.mcpUrl,
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args }
      },
      true,
      opts
    );
    if (status === 0 && !json) {
      return {
        ok: false,
        httpStatus: 0,
        kind: "transient",
        error: { code: -1, message: "request timed out" }
      };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        httpStatus: status,
        kind: "auth",
        error: { code: -32001, message: `HTTP ${status}` }
      };
    }
    if (status === 429 || status >= 500) {
      return {
        ok: false,
        httpStatus: status,
        kind: "transient",
        error: { code: -32e3, message: `HTTP ${status}` }
      };
    }
    if (parseError) {
      return {
        ok: false,
        httpStatus: status,
        kind: "protocol",
        error: { code: -32700, message: "invalid JSON in response body" }
      };
    }
    if (json?.error) {
      return {
        ok: false,
        httpStatus: status,
        kind: classifyJsonRpcError(json.error),
        error: json.error
      };
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        httpStatus: status,
        kind: "protocol",
        error: { code: -1, message: `unexpected HTTP ${status}` }
      };
    }
    const rawResult = json?.result;
    const rawIsError = rawResult && typeof rawResult === "object" && rawResult.isError === true;
    const data = parseToolResult(rawResult);
    if (rawIsError) {
      const message = data && typeof data === "object" && typeof data.error === "string" ? data.error : "tool reported an error";
      return {
        ok: false,
        httpStatus: status,
        kind: "tool",
        data,
        error: { code: -32e3, message }
      };
    }
    return { ok: true, httpStatus: status, data };
  }
  /** Fetch the agent's own identity (principal, backchannel, mxid). Read-only. */
  getSelf(opts) {
    return this.callTool("get_self", {}, opts);
  }
  /** List pending loop invites for this agent. Read-only. */
  listPendingInvites(opts) {
    return this.callTool("list_pending_invites", {}, opts);
  }
  /** Join a loop the agent was invited into. */
  acceptInvite(loopId, opts) {
    return this.callTool("accept_invite", { loop_id: loopId }, opts);
  }
  /** List pending vouches (member-initiated) for this agent. Read-only. */
  listVouches(opts) {
    return this.callTool("list_vouches", {}, opts);
  }
  /** Accept a member's vouch, turning it into a proposal a loop admin approves. */
  acceptVouch(loopId, opts) {
    return this.callTool("accept_vouch", { loop_id: loopId }, opts);
  }
  /**
   * Ask for outstanding work: a long-poll that blocks server-side up to
   * `args.wait_seconds`. The HTTP timeout must exceed that, hence the
   * caller (src/poll-work.ts) always passes an explicit `timeoutMs`.
   */
  pollWork(args, opts) {
    return this.callTool(
      "poll_work",
      {
        cursor: args.cursor ?? null,
        ...args.ack && args.ack.length > 0 ? { ack: args.ack } : {},
        wait_seconds: args.wait_seconds,
        max_items: args.max_items
      },
      opts
    );
  }
  /**
   * Publish a reply exactly as the server asked for it: `reply_with.tool`
   * with `reply_with.args` verbatim, plus the generated text. `reply_with`
   * only ever names `post_message` or `reply_in_thread` — both tools accept
   * `markdown_body` alongside their pre-resolved args (`channel` /
   * `message_id`), so this single call covers both.
   */
  replyWith(replyWithSpec, markdownBody, opts) {
    return this.callTool(
      replyWithSpec.tool,
      { ...replyWithSpec.args, markdown_body: markdownBody },
      opts
    );
  }
  /**
   * Side-channel POST to `${mcpUrl}${path}` (not JSON-RPC), bearer-authed.
   * Used by the presence/liveness endpoint.
   */
  async sideChannelPost(path, body, opts) {
    const { status } = await this.post(`${this.mcpUrl}${path}`, body, false, opts);
    return status;
  }
  /** Presence keep-alive: POST /heartbeat (keeps the agent online). */
  heartbeat(opts) {
    return this.sideChannelPost("/heartbeat", void 0, opts);
  }
}
export {
  FilamentMcpClient,
  MCP_PROTOCOL_VERSION,
  POLL_TIMEOUT_MARGIN_MS,
  parseToolResult
};
//# sourceMappingURL=mcp-client.js.map
