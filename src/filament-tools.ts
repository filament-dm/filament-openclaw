/**
 * Expose Filament's MCP tool surface to the OpenClaw agent, in parity with
 * the Python `filament-hermes` plugin: Hermes fetches `tools/list` from the
 * MCP server and registers every returned tool as a Hermes tool (falling
 * back to a bundled static manifest only when the live fetch fails — see
 * `filament-hermes/hermes_filament_fcm/__init__.py`'s `_resolve_tools`).
 *
 * ## Why registration is not fully dynamic here
 *
 * OpenClaw's plugin entry point is synchronous
 * (`OpenClawPluginDefinition.register?: (api: OpenClawPluginApi) => void` —
 * no `Promise` return, see `node_modules/openclaw/dist/types-DaHgOqFX.d.ts`),
 * but the live tool catalog is only knowable after an async MCP round trip
 * that itself depends on a resolved bearer (`runConnect`, which can take up
 * to ~2 minutes while an agent finishes onboarding). Hermes sidesteps this
 * with a blocking HTTP call at Python module-import time; there is no
 * synchronous-fetch equivalent in Node. So `registerFilamentTools` is called
 * from `src/channel.ts` *after* `runConnect` resolves and *before*
 * `runPollLoop` starts — asynchronously, but strictly before any turn this
 * channel could dispatch. **Unverified without a live gateway:** whether
 * `api.registerTool()` calls made this way (after `register(api)` has
 * already returned) are honored by the host's tool registry — the SDK's own
 * lazy-tool-factory patterns (`toolMetadata`/`OpenClawPluginToolFactory`)
 * suggest tool availability can be decided at runtime, but nothing in the
 * `.d.ts` files or the docs confirms a registry opened this late still
 * accepts writes.
 *
 * ## What gets registered
 *
 * Every tool the live `tools/list` response returns, MINUS:
 *   - `poll_work` — the poll loop (`src/poll-work.ts`) owns this call
 *     exclusively; the agent must never call it directly.
 *   - `register_push_token` / `list_push_tokens` — harness plumbing for an
 *     FCM-based transport. This plugin uses `poll_work`, not FCM, so these
 *     tools have no push token to register and would just confuse the
 *     model. Hermes excludes the FCM-specific equivalent of these for the
 *     identical reason (see its `BLOCKED_TOOLS`); this is the one place we
 *     depart from a literal "expose everything but poll_work" reading of
 *     the parity goal, and it is a considered call, not an oversight.
 *   - anything the live server returns that is NOT in `KNOWN_TOOL_NAMES`
 *     below. `openclaw.plugin.json`'s `contracts.tools` must list every
 *     name this module can register (the manifest doc: "Runtime
 *     `api.registerTool(...)` registrations must match `contracts.tools`"),
 *     and that list can only be a snapshot — it needs a human pass to add a
 *     brand-new server-side tool. Filtering to this allowlist also means an
 *     unreviewed new tool never reaches the model just because the server
 *     started advertising it.
 *
 * ## Authorization tiers
 *
 * Each registered (non-excluded) tool falls into one of three tiers,
 * decided per-call inside `execute()` (OpenClaw's `registerTool` options
 * are just `{name, names, optional}` — no channel/session scoping exists to
 * do this at registration time; see `authorizeToolCall` below):
 *
 *   - **read** — `annotations.readOnlyHint === true` in the live schema.
 *     Always allowed, from any turn.
 *   - **ring0** — `set_profile`: Filament's own tool declares this
 *     `ungated_reason="agent self-configuration, not channel content"`
 *     (synapse `tools_config.py`), and `filament-hermes/docs/
 *     agent-boundaries.md` §5 names exactly this class ("tools that change
 *     the agent are Ring 0 and principal-only") as backchannel/principal-only.
 *     Allowed only during a turn dispatched from an `is_backchannel` work
 *     item.
 *   - **write** — everything else with `readOnlyHint !== true`. Allowed
 *     from any turn this plugin's own poll loop dispatched (backchannel or
 *     group), matching Hermes' default posture for its non-Ring-0 tools.
 *
 * A tool whose `readOnlyHint` is missing or not a boolean (a malformed or
 * future schema shape) is treated as `ring0` — the strictest tier — rather
 * than guessed as read or ordinary write.
 *
 * ## The turn-tracking limitation
 *
 * `execute()`'s `ctx: ExtensionContext` carries no session/channel/peer
 * identity (verified against `node_modules/openclaw/dist/index-CUIIZH35.d.ts`
 * — its `sessionManager` is a `ReadonlySessionManager` exposing only id/file/
 * tree accessors, nothing that maps back to "this call came from the
 * Filament channel's backchannel item"). Lacking that, authorization here
 * uses a **module-level flag** (`beginFilamentTurn`/`endFilamentTurn`),
 * set/cleared by `src/channel.ts` around each `dispatchWorkItemTurn` call.
 * This is NOT concurrency-safe: `poll-work.ts`'s loop is sequential so two
 * Filament turns never overlap, but if OpenClaw runs a turn on a *different*
 * channel (Telegram, Discord, …) concurrently with an in-flight Filament
 * dispatch, that other turn would incorrectly inherit Filament-turn
 * authorization for the overlap. Accepted for this PoC because there is no
 * SDK-level per-turn tool scoping to do better with (see the module
 * docstring above and the manifest's `OpenClawPluginToolOptions`, which is
 * only `{name, names, optional}`) — flag if a live gateway shows this
 * matters in practice.
 */
import type {
  CallOptions,
  ListToolsResult,
  McpToolDescriptor,
  ToolCallResult,
} from "./mcp-client.js";

/** Tool name prefix this plugin registers under (stock-plugin convention —
 *  see e.g. `discord_*`/`telegram_*` tool names in the installed OpenClaw's
 *  bundled channel-adjacent tool plugins). */
export const TOOL_NAME_PREFIX = "filament_";

/**
 * The reviewed snapshot of Filament MCP tool names this plugin may expose,
 * unprefixed (as the server names them). Must stay in sync with
 * `openclaw.plugin.json`'s `contracts.tools` (which carries the same names,
 * prefixed) — see the module docstring's "What gets registered".
 *
 * Source: `synapse/synapse/plugins/agents_mcp/{tools_read,tools_write,
 * tools_config}.py` `TOOL_DEFS`, as of 2026-09-23. `poll_work`
 * (`tools_poll.py`) and the two push-token tools are deliberately excluded
 * (see the module docstring).
 */
export const KNOWN_TOOL_NAMES: readonly string[] = [
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
  "get_backchannel",
];

/** Tools always excluded from registration, with why (see module docstring). */
const EXCLUDED_TOOLS: ReadonlyMap<string, string> = new Map([
  ["poll_work", "the poll loop owns this call exclusively"],
  ["register_push_token", "FCM harness plumbing; this transport is poll_work, not FCM"],
  ["list_push_tokens", "FCM harness plumbing; this transport is poll_work, not FCM"],
]);

/** Ring-0 (principal/backchannel-only) tool names — see module docstring. */
const RING0_TOOL_NAMES: ReadonlySet<string> = new Set(["set_profile"]);

export type ToolTier = "read" | "ring0" | "write";

/** Classify a live tool descriptor into an authorization tier. Exported for tests. */
export function classifyToolTier(descriptor: McpToolDescriptor): ToolTier {
  if (RING0_TOOL_NAMES.has(descriptor.name)) return "ring0";
  const readOnly = descriptor.annotations?.readOnlyHint;
  if (readOnly === true) return "read";
  if (readOnly === false) return "write";
  // Missing/malformed annotations: fail closed to the strictest tier.
  return "ring0";
}

// ── Turn tracking (see module docstring's "turn-tracking limitation") ──────

interface FilamentTurnState {
  backchannel: boolean;
}

let activeFilamentTurn: FilamentTurnState | null = null;

/** Call before dispatching a Filament work-item turn. */
export function beginFilamentTurn(isBackchannel: boolean): void {
  activeFilamentTurn = { backchannel: isBackchannel };
}

/** Call after a Filament work-item turn finishes (success or failure). */
export function endFilamentTurn(): void {
  activeFilamentTurn = null;
}

/** Test-only accessor/reset. */
export function _getActiveFilamentTurnForTest(): FilamentTurnState | null {
  return activeFilamentTurn;
}

export interface AuthorizationResult {
  ok: boolean;
  reason?: string;
}

/** Decide whether a call in tier `tier` may run right now. Exported for tests. */
export function authorizeToolCall(tier: ToolTier): AuthorizationResult {
  if (tier === "read") return { ok: true };
  if (!activeFilamentTurn) {
    return {
      ok: false,
      reason: "no active Filament turn (not dispatched by this plugin's poll loop)",
    };
  }
  if (tier === "ring0" && !activeFilamentTurn.backchannel) {
    return {
      ok: false,
      reason: "principal-only tool; the active turn did not originate from the backchannel",
    };
  }
  return { ok: true };
}

// ── Client + registration ───────────────────────────────────────────────

/** Minimal client surface a tool needs (matches FilamentMcpClient.callTool). */
export interface FilamentToolClient {
  callTool(
    name: string,
    args?: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<ToolCallResult>;
}

/** Resolves the live connection's client, or null when not currently connected. */
export type GetFilamentClient = () => FilamentToolClient | null;

/**
 * Loose structural view of the plugin tool-registration surface (see
 * `src/channel.ts`'s `FilamentChannelApi` for the established precedent of
 * this pattern in this repo): the concrete `OpenClawPluginApi`/
 * `ToolDefinition<TParams extends TSchema>` types require a TypeBox schema
 * object, and `typebox` is only reachable inside `openclaw`'s own nested
 * `node_modules` (not a resolvable import from this package) — see the
 * module docstring. A plain JSON Schema object (exactly what Filament's
 * `tools/list` already returns) is passed through as `parameters` instead.
 */
export interface FilamentToolsApi {
  registerTool(tool: FilamentAgentTool): void;
}

interface FilamentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

interface FilamentAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<FilamentToolResult>;
}

const FALLBACK_PARAMETERS = { type: "object", properties: {}, additionalProperties: true } as const;

function toLabel(name: string): string {
  return name
    .split("_")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Build the `execute` closure for one tool, proxying through the live connection. */
function makeExecute(
  toolName: string,
  tier: ToolTier,
  getClient: GetFilamentClient,
  log: (message: string) => void,
): FilamentAgentTool["execute"] {
  const qualifiedName = `${TOOL_NAME_PREFIX}${toolName}`;
  return async (_toolCallId, params) => {
    const authz = authorizeToolCall(tier);
    if (!authz.ok) {
      log(`filament-tools: ${qualifiedName} denied`);
      throw new Error(`${qualifiedName}: denied — ${authz.reason}`);
    }
    const client = getClient();
    if (!client) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(`${qualifiedName}: not connected to Filament`);
    }
    let result: ToolCallResult;
    try {
      result = await client.callTool(toolName, params);
    } catch (error) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(`${qualifiedName}: call failed — ${String(error)}`);
    }
    if (!result.ok) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(
        `${qualifiedName}: ${result.kind ?? "error"} — ${result.error?.message ?? "unknown error"}`,
      );
    }
    log(`filament-tools: ${qualifiedName} ok`);
    return {
      content: [{ type: "text", text: JSON.stringify(result.data ?? null) }],
      details: result.data,
    };
  };
}

export interface RegisterFilamentToolsResult {
  registered: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Register every tool from a live `tools/list` response that is both
 * present in `KNOWN_TOOL_NAMES` and not in `EXCLUDED_TOOLS`. Call this after
 * a successful `runConnect`, before the poll loop starts (see module
 * docstring). `getClient` is consulted fresh on every call so a tool
 * degrades cleanly if the connection later drops (auth revoked, etc.)
 * rather than needing to be unregistered.
 */
export function registerFilamentTools(
  api: FilamentToolsApi,
  liveTools: McpToolDescriptor[],
  getClient: GetFilamentClient,
  log: (message: string) => void,
): RegisterFilamentToolsResult {
  const known = new Set(KNOWN_TOOL_NAMES);
  const registered: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const descriptor of liveTools) {
    const excludedReason = EXCLUDED_TOOLS.get(descriptor.name);
    if (excludedReason) {
      skipped.push({ name: descriptor.name, reason: excludedReason });
      continue;
    }
    if (!known.has(descriptor.name)) {
      skipped.push({
        name: descriptor.name,
        reason: "not in KNOWN_TOOL_NAMES (unreviewed server-side addition)",
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
      execute: makeExecute(descriptor.name, tier, getClient, log),
    });
    registered.push(qualifiedName);
  }

  log(
    `filament-tools: registered ${registered.length} tool(s)` +
      (skipped.length > 0 ? `, skipped ${skipped.length}` : ""),
  );
  return { registered, skipped };
}

/**
 * Fetch the live tool catalog and register it. Best-effort: a failed
 * `tools/list` call is logged and results in zero tools registered rather
 * than throwing — a channel that can poll_work but not tools/list is
 * unusual but should not crash the account.
 */
export async function fetchAndRegisterFilamentTools(
  api: FilamentToolsApi,
  client: FilamentToolClient & { listTools(opts?: CallOptions): Promise<ListToolsResult> },
  getClient: GetFilamentClient,
  log: (message: string) => void,
): Promise<RegisterFilamentToolsResult> {
  const result = await client.listTools();
  if (!result.ok || !result.tools) {
    log(
      `filament-tools: tools/list failed (${result.kind ?? "?"}: ${result.error?.message ?? "?"}); no agent tools registered`,
    );
    return { registered: [], skipped: [] };
  }
  return registerFilamentTools(api, result.tools, getClient, log);
}
