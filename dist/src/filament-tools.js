import { DEFAULT_ACCOUNT_ID, resolveToolAccountId } from "./accounts.js";
import rawToolSnapshot from "./filament-tools.snapshot.json" with { type: "json" };
const TOOL_NAME_PREFIX = "filament_";
const TOOL_SNAPSHOT = rawToolSnapshot;
const KNOWN_TOOL_NAMES = TOOL_SNAPSHOT.map((t) => t.name);
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
const activeFilamentTurns = /* @__PURE__ */ new Map();
function beginFilamentTurn(isBackchannel, accountId = DEFAULT_ACCOUNT_ID) {
  activeFilamentTurns.set(accountId, { backchannel: isBackchannel });
}
function endFilamentTurn(accountId = DEFAULT_ACCOUNT_ID) {
  activeFilamentTurns.delete(accountId);
}
function _getActiveFilamentTurnForTest(accountId = DEFAULT_ACCOUNT_ID) {
  return activeFilamentTurns.get(accountId) ?? null;
}
function authorizeToolCall(tier, accountId = DEFAULT_ACCOUNT_ID) {
  if (tier === "read") return { ok: true };
  const activeFilamentTurn = activeFilamentTurns.get(accountId);
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
function makeExecute(toolName, tier, accountId, getClient, log) {
  const qualifiedName = `${TOOL_NAME_PREFIX}${toolName}`;
  return async (_toolCallId, params) => {
    const authz = authorizeToolCall(tier, accountId);
    if (!authz.ok) {
      log(`filament-tools: ${qualifiedName} denied (account ${accountId})`);
      throw new Error(`${qualifiedName}: denied \u2014 ${authz.reason}`);
    }
    const client = getClient(accountId);
    if (!client) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(`${qualifiedName}: Filament is not connected yet`);
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
function registerFilamentToolsFromSnapshot(api, getClient, log, resolveAccount = (ctx) => resolveToolAccountId(ctx, api.pluginConfig)) {
  const registered = [];
  for (const descriptor of TOOL_SNAPSHOT) {
    const tier = classifyToolTier(descriptor);
    const qualifiedName = `${TOOL_NAME_PREFIX}${descriptor.name}`;
    api.registerTool(
      (ctx) => {
        const accountId = resolveAccount(ctx ?? {});
        if (!accountId) return null;
        return {
          name: qualifiedName,
          label: toLabel(descriptor.name),
          description: descriptor.description || descriptor.name,
          parameters: descriptor.inputSchema ?? FALLBACK_PARAMETERS,
          execute: makeExecute(descriptor.name, tier, accountId, getClient, log)
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
      `filament-tools: snapshot has ${missing.length} tool(s) the server no longer serves: ${missing.join(", ")}`
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
  TOOL_NAME_PREFIX,
  TOOL_SNAPSHOT,
  _getActiveFilamentTurnForTest,
  authorizeToolCall,
  beginFilamentTurn,
  checkFilamentToolDrift,
  classifyToolTier,
  endFilamentTurn,
  getFilamentClient,
  logToolDrift,
  registerFilamentToolsFromSnapshot,
  setFilamentClient
};
//# sourceMappingURL=filament-tools.js.map
