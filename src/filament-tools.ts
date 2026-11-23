/**
 * Filament's MCP tools as OpenClaw agent tools.
 *
 * Every tool is registered inside `register(api)` from a reviewed snapshot: a session resolves its
 * toolset once, early, and a registration made after connect can miss it. So `execute()` resolves
 * the live connection lazily, and a live `tools/list` after connect only logs drift.
 *
 * OpenClaw's `registerTool` has no channel or session scoping, and `execute()`'s ctx carries no
 * session identity, so authorization reads a per-account "current turn" slot set around each
 * dispatched work item. Known limitation: a turn the same agent runs on another channel while a
 * Filament turn is in flight inherits that turn's authorization.
 *
 * A turn the gateway starts beside the transport's (look-around.ts) has a slot of its own, so
 * neither turn ending takes the other's authorization. A call that names its session acts under
 * that session's turn alone; one that names none is counted for both.
 */
import { DEFAULT_ACCOUNT_ID, resolveToolAccountId, type ToolAccountContext } from "./accounts.js";
import type {
  CallOptions,
  ListToolsResult,
  McpToolDescriptor,
  ToolCallResult,
} from "./mcp-client.js";
// Regenerate with `npm run snapshot:tools`.
import rawToolSnapshot from "./filament-tools.snapshot.json" with { type: "json" };

export const TOOL_NAME_PREFIX = "filament_";

export interface SnapshotToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
}

export const TOOL_SNAPSHOT: readonly SnapshotToolDescriptor[] =
  rawToolSnapshot as SnapshotToolDescriptor[];

// OpenClaw requires runtime registrations to match `contracts.tools` in `openclaw.plugin.json`,
// which lists these names prefixed; a test keeps the two in sync.
export const KNOWN_TOOL_NAMES: readonly string[] = TOOL_SNAPSHOT.map((t) => t.name);

// Kept out of the snapshot and out of drift reports: harness plumbing, not tools for the model. Work
// reaches this plugin through poll_work, so a push token the model registered would go nowhere.
const EXCLUDED_TOOLS: ReadonlyMap<string, string> = new Map([
  ["poll_work", "the poll transport owns this call exclusively"],
  ["register_push_token", "transport plumbing; this plugin receives work through poll_work"],
  ["list_push_tokens", "transport plumbing; this plugin receives work through poll_work"],
  ["get_wake_url", "transport plumbing; the gateway waits for work outside the model"],
]);

// Tools that change the agent itself: callable only from a backchannel (principal) turn.
const RING0_TOOL_NAMES: ReadonlySet<string> = new Set([
  "set_profile",
  "declare_settings",
  "set_setting",
]);

export type ToolTier = "read" | "ring0" | "write";

export function classifyToolTier(descriptor: McpToolDescriptor): ToolTier {
  if (RING0_TOOL_NAMES.has(descriptor.name)) return "ring0";
  const readOnly = descriptor.annotations?.readOnlyHint;
  if (readOnly === true) return "read";
  if (readOnly === false) return "write";
  // Missing/malformed annotations: fail closed to the strictest tier.
  return "ring0";
}

interface FilamentTurnState {
  backchannel: boolean;
  // The OpenClaw session the turn runs in, once the route resolves it. Write tools are this
  // session's alone: another session of the same agent (a different channel, a cron run) shares
  // the account but must not borrow the turn's permissions.
  sessionKey: string | null;
  // Where a write tool already replied: the turn answered even when OpenClaw fails it.
  repliedTo: Set<string>;
  // A reaction answers in the room, but OpenClaw doesn't count it: a turn it fails can still be one
  // the agent answered.
  reacted: boolean;
  // What the write tools posted, so a final answer that repeats it isn't posted twice.
  posted: string[];
}

export interface FilamentTurnOutcome {
  repliedTo: ReadonlySet<string>;
  reacted: boolean;
  posted: readonly string[];
}

export const REPLIED_UNKNOWN_ROOM = "*";
export const REPLIED_BACKCHANNEL = "backchannel";

function replyTarget(toolName: string, params: Record<string, unknown>): string | null {
  if (toolName === "post_message") {
    return typeof params.channel === "string" ? params.channel : REPLIED_UNKNOWN_ROOM;
  }
  // Both name only a message: the room they answered in is unknown.
  if (toolName === "reply_in_thread" || toolName === "post_quote") return REPLIED_UNKNOWN_ROOM;
  if (toolName === "message_principal") return REPLIED_BACKCHANNEL;
  return null;
}

// One slot per account is enough: the transport dispatches each account's turns sequentially.
// Other sessions of the same agent still run meanwhile, so a slot also names its session.
const activeFilamentTurns = new Map<string, FilamentTurnState>();
// The gateway's own turn beside them. It never counts as a backchannel turn: no ring0 tools.
const sideFilamentTurns = new Map<string, FilamentTurnState>();

export function beginFilamentTurn(
  isBackchannel: boolean,
  accountId = DEFAULT_ACCOUNT_ID,
  side = false,
): void {
  (side ? sideFilamentTurns : activeFilamentTurns).set(accountId, {
    backchannel: isBackchannel && !side,
    sessionKey: null,
    repliedTo: new Set(),
    reacted: false,
    posted: [],
  });
}

/** Binds the turn to the OpenClaw session it runs in, before the agent's run starts. */
export function bindFilamentTurnSession(
  sessionKey: string,
  accountId = DEFAULT_ACCOUNT_ID,
  side = false,
): void {
  const turn = (side ? sideFilamentTurns : activeFilamentTurns).get(accountId);
  if (turn) turn.sessionKey = sessionKey;
}

function sameSession(a: string, b: string): boolean {
  // OpenClaw may store a session key lowercased; a Filament event id keeps its case.
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// The turns a call runs under: its session's, or every turn in flight when it names no session.
function callTurns(accountId: string, sessionKey: string | undefined): FilamentTurnState[] {
  const turns = [activeFilamentTurns.get(accountId), sideFilamentTurns.get(accountId)].filter(
    (turn): turn is FilamentTurnState => turn !== undefined,
  );
  if (sessionKey === undefined) return turns;
  return turns.filter(
    (turn) => turn.sessionKey !== null && sameSession(turn.sessionKey, sessionKey),
  );
}

export function endFilamentTurn(accountId = DEFAULT_ACCOUNT_ID, side = false): FilamentTurnOutcome {
  const turns = side ? sideFilamentTurns : activeFilamentTurns;
  const turn = turns.get(accountId);
  turns.delete(accountId);
  return {
    repliedTo: turn?.repliedTo ?? new Set<string>(),
    reacted: turn?.reacted ?? false,
    posted: turn?.posted ?? [],
  };
}

export function _getActiveFilamentTurnForTest(
  accountId = DEFAULT_ACCOUNT_ID,
): FilamentTurnState | null {
  return activeFilamentTurns.get(accountId) ?? null;
}

export interface AuthorizationResult {
  ok: boolean;
  reason?: string;
}

/**
 * `sessionKey` is the calling session, from the tool's OpenClaw context. A host that supplies
 * none gets the account-wide check alone, as before sessions were compared.
 */
export function authorizeToolCall(
  tier: ToolTier,
  accountId = DEFAULT_ACCOUNT_ID,
  sessionKey?: string,
): AuthorizationResult {
  if (tier === "read") return { ok: true };
  if (!activeFilamentTurns.has(accountId) && !sideFilamentTurns.has(accountId)) {
    return {
      ok: false,
      reason: "no active Filament turn (not dispatched by this plugin's transport)",
    };
  }
  const turns = callTurns(accountId, sessionKey);
  if (turns.length === 0) {
    return {
      ok: false,
      reason:
        "the active Filament turn runs in another session; only that session can use this tool",
    };
  }
  if (tier === "ring0" && !turns.some((turn) => turn.backchannel)) {
    return {
      ok: false,
      reason: "principal-only tool; the active turn did not originate from the backchannel",
    };
  }
  return { ok: true };
}

export interface FilamentToolClient {
  callTool(
    name: string,
    args?: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<ToolCallResult>;
  /** The live server's tools (`FilamentMcpClient.toolNames`); null or absent until listed. */
  readonly toolNames?: ReadonlySet<string> | null;
}

export type GetFilamentClient = (accountId: string) => FilamentToolClient | null;

const filamentClients = new Map<string, FilamentToolClient>();

export function setFilamentClient(
  client: FilamentToolClient | null,
  accountId = DEFAULT_ACCOUNT_ID,
): void {
  if (client) filamentClients.set(accountId, client);
  else filamentClients.delete(accountId);
}

export function getFilamentClient(accountId = DEFAULT_ACCOUNT_ID): FilamentToolClient | null {
  return filamentClients.get(accountId) ?? null;
}

// Structural rather than `OpenClawPluginApi`: its tool types require a TypeBox schema, and typebox
// is not importable from this package. The server's JSON Schema is passed as `parameters` as is.
export interface FilamentToolsApi {
  registerTool(
    factory: (ctx: ToolAccountContext) => FilamentAgentTool | null,
    opts: { names: string[] },
  ): void;
  /** Account fallback when a tool ctx carries no config. */
  pluginConfig?: unknown;
}

export type ResolveToolAccount = (ctx: ToolAccountContext) => string | null;

interface FilamentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

export interface FilamentAgentTool {
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

/** Arguments that name a message by its event id. */
const EVENT_ID_ARG = /(^|_)message_id$|^thread_id$|^up_to$|^in_reply_to$/;

/**
 * OpenClaw lists earlier messages to the model as `#<message_id> <sender>: <body>`, so a model
 * may hand back `#$event` for an id. Its conversation info shows an id's `$` as a full-width `＄`,
 * which the model copies. Matrix event ids start with `$`; the `#` is never part of one.
 */
export function normalizeEventIdArgs(params: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const id = EVENT_ID_ARG.test(key) && typeof value === "string" ? eventIdOf(value) : null;
    if (id !== null) {
      out[key] = id;
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : params;
}

// The id a mangled one stands for, or null when it isn't mangled.
function eventIdOf(value: string): string | null {
  const bare = value.startsWith("#") ? value.slice(1) : value;
  const id = bare.startsWith(FULL_WIDTH_DOLLAR) ? `$${bare.slice(1)}` : bare;
  return id !== value && id.startsWith("$") ? id : null;
}

const FULL_WIDTH_DOLLAR = "\uFF04";

function makeExecute(
  toolName: string,
  tier: ToolTier,
  accountId: string,
  sessionKey: string | undefined,
  getClient: GetFilamentClient,
  log: (message: string) => void,
): FilamentAgentTool["execute"] {
  const qualifiedName = `${TOOL_NAME_PREFIX}${toolName}`;
  return async (_toolCallId, params, signal) => {
    // The turns this call is authorized under; the call may outlive them.
    const turns = callTurns(accountId, sessionKey);
    const authz = authorizeToolCall(tier, accountId, sessionKey);
    if (!authz.ok) {
      const inFlight = [activeFilamentTurns.get(accountId), sideFilamentTurns.get(accountId)]
        .filter((turn) => turn !== undefined)
        .map((turn) => turn.sessionKey ?? "unbound");
      const sessions = sessionKey
        ? `, session ${sessionKey}, turn ${inFlight.join(" / ") || "none"}`
        : "";
      log(`filament-tools: ${qualifiedName} denied (account ${accountId}${sessions})`);
      throw new Error(`${qualifiedName}: denied — ${authz.reason}`);
    }
    const client = getClient(accountId);
    if (!client) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(`${qualifiedName}: Filament is not connected yet`);
    }
    // The snapshot can be newer than the server (e.g. the signed-URL media tools): say so rather
    // than send a call the server will reject as unknown. Unlisted yet: call through.
    // Answered, not thrown: a throw inside OpenClaw's code mode ends the agent's whole turn.
    if (client.toolNames && !client.toolNames.has(toolName)) {
      log(`filament-tools: ${qualifiedName} not offered by this server`);
      const data = {
        error: `this Filament server doesn't offer ${toolName} yet; go on without it`,
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
    }
    let result: ToolCallResult;
    try {
      result = await client.callTool(toolName, normalizeEventIdArgs(params), { signal });
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
    // The server answers some refusals (an unknown message_id) in the result, not as a failure:
    // the agent reads them, but nothing was posted, so the turn records no reply.
    const refusal = refusalOf(result.data);
    if (refusal) {
      log(`filament-tools: ${qualifiedName} refused: ${refusal}`);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data ?? null) }],
        details: result.data,
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
      details: result.data,
    };
  };
}

function refusalOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

export interface RegisterFilamentToolsResult {
  registered: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export function registerFilamentToolsFromSnapshot(
  api: FilamentToolsApi,
  getClient: GetFilamentClient,
  log: (message: string) => void,
  resolveAccount: ResolveToolAccount = (ctx) => resolveToolAccountId(ctx, api.pluginConfig),
): RegisterFilamentToolsResult {
  const registered: string[] = [];

  for (const descriptor of TOOL_SNAPSHOT) {
    const tier = classifyToolTier(descriptor as McpToolDescriptor);
    const qualifiedName = `${TOOL_NAME_PREFIX}${descriptor.name}`;
    // A factory, not a tool: OpenClaw builds it per agent/session, so the
    // tool is bound to that agent's Filament account — and absent (null) for
    // an agent with none, rather than calling through someone else's bearer.
    api.registerTool(
      (ctx) => {
        const accountId = resolveAccount(ctx ?? {});
        if (!accountId) return null;
        const sessionKey =
          typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() !== ""
            ? ctx.sessionKey
            : undefined;
        return {
          name: qualifiedName,
          label: toLabel(descriptor.name),
          description: descriptor.description || descriptor.name,
          parameters: descriptor.inputSchema ?? FALLBACK_PARAMETERS,
          execute: makeExecute(descriptor.name, tier, accountId, sessionKey, getClient, log),
        };
      },
      { names: [qualifiedName] },
    );
    registered.push(qualifiedName);
  }

  log(`filament-tools: registered ${registered.length} tool(s) from snapshot`);
  return { registered, skipped: [] };
}

export function logToolDrift(liveTools: McpToolDescriptor[], log: (message: string) => void): void {
  const snapshotNames = new Set(TOOL_SNAPSHOT.map((t) => t.name));
  const liveNames = new Set(
    liveTools.map((t) => t.name).filter((name) => !EXCLUDED_TOOLS.has(name)),
  );

  const extra = [...liveNames].filter((name) => !snapshotNames.has(name)).sort();
  const missing = [...snapshotNames].filter((name) => !liveNames.has(name)).sort();

  if (extra.length > 0) {
    log(
      `filament-tools: server exposes ${extra.length} tool(s) not in the snapshot: ${extra.join(", ")}`,
    );
  }
  if (missing.length > 0) {
    log(
      `filament-tools: snapshot has ${missing.length} tool(s) the server does not list for this agent (behind a feature flag, or removed): ${missing.join(", ")}`,
    );
  }
  if (extra.length === 0 && missing.length === 0) {
    log("filament-tools: snapshot matches the live server's tool surface");
  }
}

export async function checkFilamentToolDrift(
  client: { listTools(opts?: CallOptions): Promise<ListToolsResult> },
  log: (message: string) => void,
): Promise<void> {
  const result = await client.listTools();
  if (!result.ok || !result.tools) {
    log(
      `filament-tools: drift check skipped (tools/list failed: ${result.kind ?? "?"}: ${result.error?.message ?? "?"})`,
    );
    return;
  }
  logToolDrift(result.tools, log);
}
