/**
 * Minimal MCP-over-HTTP client for Filament's `/mcp/agents` endpoint.
 *
 * Ports the essentials of the Python Hermes plugin's `filament_api.py`:
 * JSON-RPC 2.0 over HTTP POST, `Authorization: Bearer <fmcp_…>`, `Mcp-Session-Id`
 * capture/replay, an `initialize` + `notifications/initialized` handshake, and a
 * tool-result unwrapper. Uses the global `fetch` (Node 22+); no new dependency.
 */

/** MCP protocol version we advertise (matches Hermes). */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

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
  /** Parsed inner JSON from the MCP content envelope (on success). */
  data?: unknown;
  error?: McpError;
}

/**
 * Unwrap an MCP tool result into its inner JSON. Handles both shapes seen in
 * the wild: `{ content: [{ type: "text", text }] }` (Hermes' expectation) and
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

  private async post(
    body: unknown,
    expectJson: boolean,
  ): Promise<{ status: number; json: JsonRpcResponse | null }> {
    const response = await this.fetchImpl(this.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

    const headerSid = response.headers.get("mcp-session-id");
    if (headerSid) this.sessionId = headerSid;

    if (!expectJson || response.status === 204) {
      return { status: response.status, json: null };
    }
    let json: JsonRpcResponse | null = null;
    try {
      json = (await response.json()) as JsonRpcResponse;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  /** MCP handshake: initialize + notifications/initialized. Idempotent. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const { json } = await this.post(
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
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
    this.initialized = true;
  }

  /** Call an MCP tool, returning a classified result (never throws on error envelopes). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    await this.initialize();
    const { status, json } = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      },
      true,
    );
    if (json?.error) {
      return { ok: false, httpStatus: status, error: json.error };
    }
    if (status === 401 || status === 403) {
      return { ok: false, httpStatus: status, error: { code: -32001, message: `HTTP ${status}` } };
    }
    return { ok: true, httpStatus: status, data: parseToolResult(json?.result) };
  }

  /** Fetch the agent's own identity (principal, backchannel, mxid). */
  getSelf(): Promise<ToolCallResult> {
    return this.callTool("get_self", {});
  }

  /** Hand Filament our FCM push token so DirectPusher can push to us. */
  registerPushToken(token: string, platform = "android"): Promise<ToolCallResult> {
    return this.callTool("register_push_token", { token, platform });
  }

  listPendingInvites(): Promise<ToolCallResult> {
    return this.callTool("list_pending_invites", {});
  }

  acceptInvite(loopId: string): Promise<ToolCallResult> {
    return this.callTool("accept_invite", { loop_id: loopId });
  }

  listVouches(): Promise<ToolCallResult> {
    return this.callTool("list_vouches", {});
  }

  acceptVouch(loopId: string): Promise<ToolCallResult> {
    return this.callTool("accept_vouch", { loop_id: loopId });
  }

  /** Post a message to a channel. */
  postMessage(channel: string, markdownBody: string): Promise<ToolCallResult> {
    return this.callTool("post_message", { channel, markdown_body: markdownBody });
  }

  /** DM the principal (the server's first-contact directive points here). */
  messagePrincipal(markdownBody: string): Promise<ToolCallResult> {
    return this.callTool("message_principal", { markdown_body: markdownBody });
  }

  /**
   * Side-channel POST to `${mcpUrl}${path}` (not JSON-RPC), bearer-authed.
   * Used by the presence/liveness endpoints. Returns the HTTP status.
   */
  private async sideChannelPost(path: string, body?: unknown): Promise<number> {
    const response = await this.fetchImpl(`${this.mcpUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.status;
  }

  /** Presence keep-alive: POST /heartbeat (keeps the agent online). */
  heartbeat(): Promise<number> {
    return this.sideChannelPost("/heartbeat");
  }

  /** Acknowledge a liveness ping: POST /pong. (Wired once inbound dispatch exists.) */
  pong(nonce: string): Promise<number> {
    return this.sideChannelPost("/pong", { nonce });
  }
}
