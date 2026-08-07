const MCP_PROTOCOL_VERSION = "2025-03-26";
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
  async post(body, expectJson) {
    const response = await this.fetchImpl(this.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...this.sessionId ? { "mcp-session-id": this.sessionId } : {}
      },
      body: JSON.stringify(body)
    });
    const headerSid = response.headers.get("mcp-session-id");
    if (headerSid) this.sessionId = headerSid;
    if (!expectJson || response.status === 204) {
      return { status: response.status, json: null };
    }
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }
  /** MCP handshake: initialize + notifications/initialized. Idempotent. */
  async initialize() {
    if (this.initialized) return;
    const { json } = await this.post(
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
      true
    );
    const bodySid = json?.result && typeof json.result === "object" ? json.result._sessionId : void 0;
    if (typeof bodySid === "string" && bodySid) this.sessionId = bodySid;
    const instr = json?.result && typeof json.result === "object" ? json.result.instructions : void 0;
    this.instructions = typeof instr === "string" ? instr : null;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
    this.initialized = true;
  }
  /** Call an MCP tool, returning a classified result (never throws on error envelopes). */
  async callTool(name, args = {}) {
    await this.initialize();
    const { status, json } = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args }
      },
      true
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
  getSelf() {
    return this.callTool("get_self", {});
  }
  /** Hand Filament our FCM push token so DirectPusher can push to us. */
  registerPushToken(token, platform = "android") {
    return this.callTool("register_push_token", { token, platform });
  }
  listPendingInvites() {
    return this.callTool("list_pending_invites", {});
  }
  acceptInvite(loopId) {
    return this.callTool("accept_invite", { loop_id: loopId });
  }
  listVouches() {
    return this.callTool("list_vouches", {});
  }
  acceptVouch(loopId) {
    return this.callTool("accept_vouch", { loop_id: loopId });
  }
  /** Post a message to a channel. */
  postMessage(channel, markdownBody) {
    return this.callTool("post_message", { channel, markdown_body: markdownBody });
  }
  /** DM the principal (the server's first-contact directive points here). */
  messagePrincipal(markdownBody) {
    return this.callTool("message_principal", { markdown_body: markdownBody });
  }
  /**
   * Side-channel POST to `${mcpUrl}${path}` (not JSON-RPC), bearer-authed.
   * Used by the presence/liveness endpoints. Returns the HTTP status.
   */
  async sideChannelPost(path, body) {
    const response = await this.fetchImpl(`${this.mcpUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        ...this.sessionId ? { "mcp-session-id": this.sessionId } : {}
      },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    return response.status;
  }
  /** Presence keep-alive: POST /heartbeat (keeps the agent online). */
  heartbeat() {
    return this.sideChannelPost("/heartbeat");
  }
  /** Acknowledge a liveness ping: POST /pong (the channel calls this on an inbound ping). */
  pong(nonce) {
    return this.sideChannelPost("/pong", { nonce });
  }
}
export {
  FilamentMcpClient,
  MCP_PROTOCOL_VERSION,
  parseToolResult
};
//# sourceMappingURL=mcp-client.js.map
