const TOOL_NAME_PREFIX = "filament_";
const KNOWN_TOOL_NAMES = [
  // tools_read.py
  "list_channels",
  "list_loop_channels",
  "get_channel_details",
  "get_recent_messages",
  "search_messages",
  "get_thread",
  "get_user_profile",
  "search_members",
  "list_mentions",
  "list_reactions",
  "list_pending_invites",
  "list_vouches",
  // tools_write.py
  "post_message",
  "message_principal",
  "reply_in_thread",
  "react",
  "unreact",
  "mark_read",
  "set_status",
  "accept_invite",
  "accept_vouch",
  "join_channel",
  "leave_channel",
  "create_channel",
  "rechat",
  "quote",
  // tools_config.py (register_push_token / list_push_tokens excluded)
  "get_self",
  "set_profile",
  "set_channel_notification_level",
  "get_backchannel"
];
const EXCLUDED_TOOLS = /* @__PURE__ */ new Map([
  ["poll_work", "the poll loop owns this call exclusively"],
  ["register_push_token", "FCM harness plumbing; this transport is poll_work, not FCM"],
  ["list_push_tokens", "FCM harness plumbing; this transport is poll_work, not FCM"]
]);
const RING0_TOOL_NAMES = /* @__PURE__ */ new Set(["set_profile"]);
function classifyToolTier(descriptor) {
  if (RING0_TOOL_NAMES.has(descriptor.name)) return "ring0";
  const readOnly = descriptor.annotations?.readOnlyHint;
  if (readOnly === true) return "read";
  if (readOnly === false) return "write";
  return "ring0";
}
let activeFilamentTurn = null;
function beginFilamentTurn(isBackchannel) {
  activeFilamentTurn = { backchannel: isBackchannel };
}
function endFilamentTurn() {
  activeFilamentTurn = null;
}
function _getActiveFilamentTurnForTest() {
  return activeFilamentTurn;
}
function authorizeToolCall(tier) {
  if (tier === "read") return { ok: true };
  if (!activeFilamentTurn) {
    return {
      ok: false,
      reason: "no active Filament turn (not dispatched by this plugin's poll loop)"
    };
  }
  if (tier === "ring0" && !activeFilamentTurn.backchannel) {
    return {
      ok: false,
      reason: "principal-only tool; the active turn did not originate from the backchannel"
    };
  }
  return { ok: true };
}
const FALLBACK_PARAMETERS = { type: "object", properties: {}, additionalProperties: true };
function toLabel(name) {
  return name.split("_").map((w) => w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}
function makeExecute(toolName, tier, getClient, log) {
  const qualifiedName = `${TOOL_NAME_PREFIX}${toolName}`;
  return async (_toolCallId, params) => {
    const authz = authorizeToolCall(tier);
    if (!authz.ok) {
      log(`filament-tools: ${qualifiedName} denied`);
      throw new Error(`${qualifiedName}: denied \u2014 ${authz.reason}`);
    }
    const client = getClient();
    if (!client) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(`${qualifiedName}: not connected to Filament`);
    }
    let result;
    try {
      result = await client.callTool(toolName, params);
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
    log(`filament-tools: ${qualifiedName} ok`);
    return {
      content: [{ type: "text", text: JSON.stringify(result.data ?? null) }],
      details: result.data
    };
  };
}
function registerFilamentTools(api, liveTools, getClient, log) {
  const known = new Set(KNOWN_TOOL_NAMES);
  const registered = [];
  const skipped = [];
  for (const descriptor of liveTools) {
    const excludedReason = EXCLUDED_TOOLS.get(descriptor.name);
    if (excludedReason) {
      skipped.push({ name: descriptor.name, reason: excludedReason });
      continue;
    }
    if (!known.has(descriptor.name)) {
      skipped.push({
        name: descriptor.name,
        reason: "not in KNOWN_TOOL_NAMES (unreviewed server-side addition)"
      });
      continue;
    }
    const tier = classifyToolTier(descriptor);
    const qualifiedName = `${TOOL_NAME_PREFIX}${descriptor.name}`;
    api.registerTool({
      name: qualifiedName,
      label: toLabel(descriptor.name),
      description: descriptor.description ?? descriptor.name,
      parameters: descriptor.inputSchema ?? FALLBACK_PARAMETERS,
      execute: makeExecute(descriptor.name, tier, getClient, log)
    });
    registered.push(qualifiedName);
  }
  log(
    `filament-tools: registered ${registered.length} tool(s)` + (skipped.length > 0 ? `, skipped ${skipped.length}` : "")
  );
  return { registered, skipped };
}
async function fetchAndRegisterFilamentTools(api, client, getClient, log) {
  const result = await client.listTools();
  if (!result.ok || !result.tools) {
    log(
      `filament-tools: tools/list failed (${result.kind ?? "?"}: ${result.error?.message ?? "?"}); no agent tools registered`
    );
    return { registered: [], skipped: [] };
  }
  return registerFilamentTools(api, result.tools, getClient, log);
}
export {
  KNOWN_TOOL_NAMES,
  TOOL_NAME_PREFIX,
  _getActiveFilamentTurnForTest,
  authorizeToolCall,
  beginFilamentTurn,
  classifyToolTier,
  endFilamentTurn,
  fetchAndRegisterFilamentTools,
  registerFilamentTools
};
//# sourceMappingURL=filament-tools.js.map
