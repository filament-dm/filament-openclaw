import { DEFAULT_ACCOUNT_ID, resolveToolAccountId } from "./accounts.js";
import rawToolSnapshot from "./filament-tools.snapshot.json" with { type: "json" };
const TOOL_NAME_PREFIX = "filament_";
const TOOL_SNAPSHOT = rawToolSnapshot;
const KNOWN_TOOL_NAMES = TOOL_SNAPSHOT.map((t) => t.name);
const EXCLUDED_TOOLS = /* @__PURE__ */ new Map([
  ["poll_work", "the poll transport owns this call exclusively"],
  ["register_push_token", "transport plumbing; this plugin receives work through poll_work"],
  ["list_push_tokens", "transport plumbing; this plugin receives work through poll_work"],
  ["get_wake_url", "transport plumbing; the gateway waits for work outside the model"]
]);
const RING0_TOOL_NAMES = /* @__PURE__ */ new Set([
  "set_profile",
  "declare_settings",
  "set_setting"
]);
function classifyToolTier(descriptor) {
  if (RING0_TOOL_NAMES.has(descriptor.name)) return "ring0";
  const readOnly = descriptor.annotations?.readOnlyHint;
  if (readOnly === true) return "read";
  if (readOnly === false) return "write";
  return "ring0";
}
const REPLIED_UNKNOWN_ROOM = "*";
const REPLIED_BACKCHANNEL = "backchannel";
function replyTarget(toolName, params) {
  if (toolName === "post_message") {
    return typeof params.channel === "string" ? params.channel : REPLIED_UNKNOWN_ROOM;
  }
  if (toolName === "reply_in_thread" || toolName === "post_quote") return REPLIED_UNKNOWN_ROOM;
  if (toolName === "message_principal") return REPLIED_BACKCHANNEL;
  return null;
}
const activeFilamentTurns = /* @__PURE__ */ new Map();
const sideFilamentTurns = /* @__PURE__ */ new Map();
function beginFilamentTurn(isBackchannel, accountId = DEFAULT_ACCOUNT_ID, side = false) {
  (side ? sideFilamentTurns : activeFilamentTurns).set(accountId, {
    backchannel: isBackchannel && !side,
    sessionKey: null,
    repliedTo: /* @__PURE__ */ new Set(),
    reacted: false,
    posted: []
  });
}
function bindFilamentTurnSession(sessionKey, accountId = DEFAULT_ACCOUNT_ID, side = false) {
  const turn = (side ? sideFilamentTurns : activeFilamentTurns).get(accountId);
  if (turn) turn.sessionKey = sessionKey;
}
function sameSession(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
function callTurns(accountId, sessionKey) {
  const turns = [activeFilamentTurns.get(accountId), sideFilamentTurns.get(accountId)].filter(
    (turn) => turn !== void 0
  );
  if (sessionKey === void 0) return turns;
  return turns.filter(
    (turn) => turn.sessionKey !== null && sameSession(turn.sessionKey, sessionKey)
  );
}
function endFilamentTurn(accountId = DEFAULT_ACCOUNT_ID, side = false) {
  const turns = side ? sideFilamentTurns : activeFilamentTurns;
  const turn = turns.get(accountId);
  turns.delete(accountId);
  return {
    repliedTo: turn?.repliedTo ?? /* @__PURE__ */ new Set(),
    reacted: turn?.reacted ?? false,
    posted: turn?.posted ?? []
  };
}
function _getActiveFilamentTurnForTest(accountId = DEFAULT_ACCOUNT_ID) {
  return activeFilamentTurns.get(accountId) ?? null;
}
function authorizeToolCall(tier, accountId = DEFAULT_ACCOUNT_ID, sessionKey) {
  if (tier === "read") return { ok: true };
  if (!activeFilamentTurns.has(accountId) && !sideFilamentTurns.has(accountId)) {
    return {
      ok: false,
      reason: "no active Filament turn (not dispatched by this plugin's transport)"
    };
  }
  const turns = callTurns(accountId, sessionKey);
  if (turns.length === 0) {
    return {
      ok: false,
      reason: "the active Filament turn runs in another session; only that session can use this tool"
    };
  }
  if (tier === "ring0" && !turns.some((turn) => turn.backchannel)) {
    return {
      ok: false,
      reason: "principal-only tool; the active turn did not originate from the backchannel"
    };
  }
  return { ok: true };
}
const filamentClients = /* @__PURE__ */ new Map();
function setFilamentClient(client, accountId = DEFAULT_ACCOUNT_ID) {
  if (client) filamentClients.set(accountId, client);
  else filamentClients.delete(accountId);
}
function getFilamentClient(accountId = DEFAULT_ACCOUNT_ID) {
  return filamentClients.get(accountId) ?? null;
}
const FALLBACK_PARAMETERS = { type: "object", properties: {}, additionalProperties: true };
function toLabel(name) {
  return name.split("_").map((w) => w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}
const EVENT_ID_ARG = /(^|_)message_id$|^thread_id$|^up_to$/;
function normalizeEventIdArgs(params) {
  let changed = false;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (EVENT_ID_ARG.test(key) && typeof value === "string" && value.startsWith("#$")) {
      out[key] = value.slice(1);
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : params;
}
function makeExecute(toolName, tier, accountId, sessionKey, getClient, log) {
  const qualifiedName = `${TOOL_NAME_PREFIX}${toolName}`;
  return async (_toolCallId, params, signal) => {
    const turns = callTurns(accountId, sessionKey);
    const authz = authorizeToolCall(tier, accountId, sessionKey);
    if (!authz.ok) {
      const inFlight = [activeFilamentTurns.get(accountId), sideFilamentTurns.get(accountId)].filter((turn) => turn !== void 0).map((turn) => turn.sessionKey ?? "unbound");
      const sessions = sessionKey ? `, session ${sessionKey}, turn ${inFlight.join(" / ") || "none"}` : "";
      log(`filament-tools: ${qualifiedName} denied (account ${accountId}${sessions})`);
      throw new Error(`${qualifiedName}: denied \u2014 ${authz.reason}`);
    }
    const client = getClient(accountId);
    if (!client) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(`${qualifiedName}: Filament is not connected yet`);
    }
    if (client.toolNames && !client.toolNames.has(toolName)) {
      log(`filament-tools: ${qualifiedName} not offered by this server`);
      throw new Error(
        `${qualifiedName}: this Filament server doesn't offer ${toolName} yet; tell your principal if you need it`
      );
    }
    let result;
    try {
      result = await client.callTool(toolName, normalizeEventIdArgs(params), { signal });
    } catch (error) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(`${qualifiedName}: call failed \u2014 ${String(error)}`);
    }
    if (!result.ok) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(
        `${qualifiedName}: ${result.kind ?? "error"} \u2014 ${result.error?.message ?? "unknown error"}`
      );
    }
    const refusal = refusalOf(result.data);
    if (refusal) {
      log(`filament-tools: ${qualifiedName} refused: ${refusal}`);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data ?? null) }],
        details: result.data
      };
    }
    log(`filament-tools: ${qualifiedName} ok`);
    const target = replyTarget(toolName, params);
    for (const turn of turns) {
      if (target) turn.repliedTo.add(target);
      if (target && typeof params.markdown_body === "string")
        turn.posted.push(params.markdown_body);
      if (toolName === "react") turn.reacted = true;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.data ?? null) }],
      details: result.data
    };
  };
}
function refusalOf(data) {
  if (typeof data !== "object" || data === null) return null;
  const error = data.error;
  return typeof error === "string" ? error : null;
}
function registerFilamentToolsFromSnapshot(api, getClient, log, resolveAccount = (ctx) => resolveToolAccountId(ctx, api.pluginConfig)) {
  const registered = [];
  for (const descriptor of TOOL_SNAPSHOT) {
    const tier = classifyToolTier(descriptor);
    const qualifiedName = `${TOOL_NAME_PREFIX}${descriptor.name}`;
    api.registerTool(
      (ctx) => {
        const accountId = resolveAccount(ctx ?? {});
        if (!accountId) return null;
        const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() !== "" ? ctx.sessionKey : void 0;
        return {
          name: qualifiedName,
          label: toLabel(descriptor.name),
          description: descriptor.description || descriptor.name,
          parameters: descriptor.inputSchema ?? FALLBACK_PARAMETERS,
          execute: makeExecute(descriptor.name, tier, accountId, sessionKey, getClient, log)
        };
      },
      { names: [qualifiedName] }
    );
    registered.push(qualifiedName);
  }
  log(`filament-tools: registered ${registered.length} tool(s) from snapshot`);
  return { registered, skipped: [] };
}
function logToolDrift(liveTools, log) {
  const snapshotNames = new Set(TOOL_SNAPSHOT.map((t) => t.name));
  const liveNames = new Set(
    liveTools.map((t) => t.name).filter((name) => !EXCLUDED_TOOLS.has(name))
  );
  const extra = [...liveNames].filter((name) => !snapshotNames.has(name)).sort();
  const missing = [...snapshotNames].filter((name) => !liveNames.has(name)).sort();
  if (extra.length > 0) {
    log(
      `filament-tools: server exposes ${extra.length} tool(s) not in the snapshot: ${extra.join(", ")}`
    );
  }
  if (missing.length > 0) {
    log(
      `filament-tools: snapshot has ${missing.length} tool(s) the server does not list for this agent (behind a feature flag, or removed): ${missing.join(", ")}`
    );
  }
  if (extra.length === 0 && missing.length === 0) {
    log("filament-tools: snapshot matches the live server's tool surface");
  }
}
async function checkFilamentToolDrift(client, log) {
  const result = await client.listTools();
  if (!result.ok || !result.tools) {
    log(
      `filament-tools: drift check skipped (tools/list failed: ${result.kind ?? "?"}: ${result.error?.message ?? "?"})`
    );
    return;
  }
  logToolDrift(result.tools, log);
}
export {
  KNOWN_TOOL_NAMES,
  REPLIED_BACKCHANNEL,
  REPLIED_UNKNOWN_ROOM,
  TOOL_NAME_PREFIX,
  TOOL_SNAPSHOT,
  _getActiveFilamentTurnForTest,
  authorizeToolCall,
  beginFilamentTurn,
  bindFilamentTurnSession,
  checkFilamentToolDrift,
  classifyToolTier,
  endFilamentTurn,
  getFilamentClient,
  logToolDrift,
  normalizeEventIdArgs,
  registerFilamentToolsFromSnapshot,
  setFilamentClient
};
