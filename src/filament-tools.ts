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

// Kept out of the snapshot and out of drift reports. An agent registering a push token would take
// the FCM transport's pushes: the server keeps one push token per agent.
const EXCLUDED_TOOLS: ReadonlyMap<string, string> = new Map([
  ["poll_work", "the poll transport owns this call exclusively"],
  ["register_push_token", "transport plumbing; the FCM transport registers its own token"],
  ["list_push_tokens", "transport plumbing; the FCM transport registers its own token"],
]);

// Tools that change the agent itself: callable only from a backchannel (principal) turn.
const RING0_TOOL_NAMES: ReadonlySet<string> = new Set(["set_profile"]);

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
  // Lets the FCM transport skip posting the final text where a write tool already replied.
  repliedTo: Set<string>;
}

export const REPLIED_UNKNOWN_ROOM = "*";
export const REPLIED_BACKCHANNEL = "backchannel";

function replyTarget(toolName: string, params: Record<string, unknown>): string | null {
  if (toolName === "post_message") {
    return typeof params.channel === "string" ? params.channel : REPLIED_UNKNOWN_ROOM;
  }
  if (toolName === "reply_in_thread") return REPLIED_UNKNOWN_ROOM;
  if (toolName === "message_principal") return REPLIED_BACKCHANNEL;
  return null;
}

// One slot per account is enough: each account's transport dispatches its turns sequentially.
const activeFilamentTurns = new Map<string, FilamentTurnState>();

export function beginFilamentTurn(isBackchannel: boolean, accountId = DEFAULT_ACCOUNT_ID): void {
  activeFilamentTurns.set(accountId, { backchannel: isBackchannel, repliedTo: new Set() });
}

export function endFilamentTurn(accountId = DEFAULT_ACCOUNT_ID): ReadonlySet<string> {
  const repliedTo = activeFilamentTurns.get(accountId)?.repliedTo ?? new Set<string>();
  activeFilamentTurns.delete(accountId);
  return repliedTo;
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

export function authorizeToolCall(
  tier: ToolTier,
  accountId = DEFAULT_ACCOUNT_ID,
): AuthorizationResult {
  if (tier === "read") return { ok: true };
  const activeFilamentTurn = activeFilamentTurns.get(accountId);
  if (!activeFilamentTurn) {
    return {
      ok: false,
      reason: "no active Filament turn (not dispatched by this plugin's transport)",
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

export interface FilamentToolClient {
  callTool(
    name: string,
    args?: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<ToolCallResult>;
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

function makeExecute(
  toolName: string,
  tier: ToolTier,
  accountId: string,
  getClient: GetFilamentClient,
  log: (message: string) => void,
): FilamentAgentTool["execute"] {
  const qualifiedName = `${TOOL_NAME_PREFIX}${toolName}`;
  return async (_toolCallId, params) => {
    const authz = authorizeToolCall(tier, accountId);
    if (!authz.ok) {
      log(`filament-tools: ${qualifiedName} denied (account ${accountId})`);
      throw new Error(`${qualifiedName}: denied — ${authz.reason}`);
    }
    const client = getClient(accountId);
    if (!client) {
      log(`filament-tools: ${qualifiedName} failed`);
      throw new Error(`${qualifiedName}: Filament is not connected yet`);
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
    const target = replyTarget(toolName, params);
    if (target) activeFilamentTurns.get(accountId)?.repliedTo.add(target);
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
        return {
          name: qualifiedName,
          label: toLabel(descriptor.name),
          description: descriptor.description || descriptor.name,
          parameters: descriptor.inputSchema ?? FALLBACK_PARAMETERS,
          execute: makeExecute(descriptor.name, tier, accountId, getClient, log),
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
      `filament-tools: snapshot has ${missing.length} tool(s) the server no longer serves: ${missing.join(", ")}`,
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
