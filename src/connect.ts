/**
 * Filament connect sequence — the client half of onboarding, mirroring the
 * Python Hermes plugin's `adapter.connect()`:
 *
 *   1. initialize (capture the first-contact directive)
 *   2. get_self poll until finalized → persist identity (principal + backchannel)
 *   3. accept pending invites + vouches (best-effort)
 *   4. FCM register (obtain a Google push token)
 *   5. register_push_token → hand Filament the token so it can push to us
 *   6. heartbeat presence loop (keeps the agent online)
 *   7. first-contact greeting (canned hello; agent-generated greeting is a
 *      later step that needs the inbound → agent → outbound message loop)
 *
 * Inbound push dispatch is intentionally not wired yet: the FCM listener runs,
 * but received pushes are not yet handled.
 */
import type { TokenSnapshot } from "./conformance-core.js";
import { buildSnapshot, FcmConnection } from "./fcm.js";
import { FilamentMcpClient, type ToolCallResult } from "./mcp-client.js";
import { classifyGetSelf, isFirstContact, type ResolvedIdentity } from "./onboarding-core.js";
import { cachedToken, saveIdentity } from "./token-store.js";

const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";
const GETSELF_MAX_ATTEMPTS = 40; // ~2 min at the default 3s interval
const GETSELF_INTERVAL_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 20_000; // < 30s presence-decay window

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface McpSettings {
  /**
   * The raw connect-token input: a string, a `${ENV}` shorthand, or a SecretRef
   * object. Resolved to a concrete token by the caller (which has the gateway
   * config needed to resolve file/exec refs). Undefined = not configured.
   */
  tokenInput?: unknown;
  mcpUrl: string;
}

/**
 * Resolve the MCP endpoint and the connect-token *input* from plugin config,
 * falling back to env (`FILAMENT_MCP_TOKEN`/`FILAMENT_MCP_URL`) then the prod
 * default. A present token input is the gate that enables connect.
 */
export function resolveMcpSettings(
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): McpSettings {
  const cfg =
    pluginConfig && typeof pluginConfig === "object"
      ? (pluginConfig as Record<string, unknown>)
      : {};
  const cfgToken = cfg.connectToken;
  const hasCfgToken =
    (typeof cfgToken === "string" && cfgToken.trim().length > 0) ||
    (typeof cfgToken === "object" && cfgToken !== null);
  const envToken = env.FILAMENT_MCP_TOKEN?.trim();
  const tokenInput = hasCfgToken ? cfgToken : envToken || undefined;
  const cfgUrl = typeof cfg.mcpUrl === "string" ? cfg.mcpUrl.trim() : "";
  const mcpUrl = (cfgUrl || env.FILAMENT_MCP_URL?.trim() || DEFAULT_MCP_URL).replace(/\/+$/, "");
  return { tokenInput, mcpUrl };
}

/** A running connection: stop it, or read the live FCM token snapshot. */
export interface ConnectHandle {
  stop(): void;
  snapshot(): TokenSnapshot | null;
}

export interface RunConnectOptions {
  mcpUrl: string;
  token: string;
  log?: (message: string) => void;
}

/** Extract the `loop_id`s from a list_pending_invites / list_vouches result. */
function loopIds(result: ToolCallResult, key: "invites" | "vouches"): string[] {
  if (!result.ok || !result.data || typeof result.data !== "object") return [];
  const list = (result.data as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) =>
      item && typeof item === "object" ? (item as { loop_id?: unknown }).loop_id : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Auto-accept pending loop invites and vouches. Best-effort; never throws. */
async function acceptPending(
  client: FilamentMcpClient,
  log: (message: string) => void,
): Promise<void> {
  try {
    for (const loopId of loopIds(await client.listPendingInvites(), "invites")) {
      const res = await client.acceptInvite(loopId);
      log(
        `filament-connect: accept_invite ${loopId} ${res.ok ? "ok" : `failed (${res.error?.code ?? "?"})`}`,
      );
    }
  } catch (error) {
    log(`filament-connect: invites step failed (continuing): ${String(error)}`);
  }
  try {
    for (const loopId of loopIds(await client.listVouches(), "vouches")) {
      const res = await client.acceptVouch(loopId);
      log(
        `filament-connect: accept_vouch ${loopId} ${res.ok ? "ok" : `failed (${res.error?.code ?? "?"})`}`,
      );
    }
  } catch (error) {
    log(`filament-connect: vouches step failed (continuing): ${String(error)}`);
  }
}

/**
 * Run the full connect sequence. Returns a handle that stops the heartbeat loop
 * and FCM listener. Throws only if the connect token is rejected.
 */
export async function runConnect(opts: RunConnectOptions): Promise<ConnectHandle> {
  const { mcpUrl, token, log = () => {} } = opts;
  const client = new FilamentMcpClient(mcpUrl, token);
  let fcm: FcmConnection | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    fcm?.stop();
    fcm = null;
  };
  const snapshot = (): TokenSnapshot | null => (fcm ? fcm.snapshot() : buildSnapshot(false));

  // 1. Initialize; a first-contact directive means we should greet.
  await client.initialize();
  const greetPending = isFirstContact(client.instructions);

  // 2. Poll get_self until the app finalizes the agent.
  let identity: ResolvedIdentity | null = null;
  let ownerName: string | undefined;
  for (let attempt = 1; attempt <= GETSELF_MAX_ATTEMPTS; attempt++) {
    let res: ToolCallResult;
    try {
      res = await client.getSelf();
    } catch (error) {
      log(
        `filament-connect: get_self attempt ${attempt}/${GETSELF_MAX_ATTEMPTS} threw: ${String(error)}`,
      );
      if (attempt < GETSELF_MAX_ATTEMPTS) await sleep(GETSELF_INTERVAL_MS);
      continue;
    }
    const decision = classifyGetSelf(res);
    if (decision.status === "finalized" && decision.identity) {
      identity = decision.identity;
      const owner = (res.data as { owner?: { display_name?: unknown } } | undefined)?.owner;
      if (owner && typeof owner.display_name === "string") ownerName = owner.display_name;
      break;
    }
    if (decision.status === "auth_failed") {
      log("filament-connect: connect token rejected (auth failed)");
      stop();
      throw new Error("connect token rejected");
    }
    log(`filament-connect: not finalized yet (attempt ${attempt}/${GETSELF_MAX_ATTEMPTS})`);
    if (attempt < GETSELF_MAX_ATTEMPTS) await sleep(GETSELF_INTERVAL_MS);
  }
  if (!identity) {
    log("filament-connect: agent not finalized within the window; will retry on next restart");
    return { stop, snapshot };
  }
  saveIdentity({ ...identity, onboardedAt: Date.now() });
  log(
    `filament-connect: identity principal=${identity.principal} ccRoom=${identity.ccRoomId ?? "(none)"}`,
  );

  // 3. Auto-accept anything we were invited/vouched into while offline.
  await acceptPending(client, log);

  // 4. Register with FCM (best-effort — a failure must not abort presence).
  fcm = new FcmConnection(undefined, log);
  try {
    await fcm.start();
  } catch (error) {
    log(`filament-connect: FCM registration failed (continuing without push): ${String(error)}`);
  }

  // 5. Hand Filament the push token.
  const fcmToken = cachedToken();
  if (fcmToken) {
    const res = await client.registerPushToken(fcmToken, "android");
    log(
      res.ok
        ? "filament-connect: push token registered with Filament"
        : `filament-connect: register_push_token failed (${res.error?.code ?? "?"})`,
    );
  } else {
    log("filament-connect: no FCM token available; skipping register_push_token");
  }

  // 6. Presence heartbeat loop.
  const beat = async () => {
    try {
      await client.heartbeat();
    } catch (error) {
      log(`filament-connect: heartbeat failed: ${String(error)}`);
    }
  };
  await beat();
  heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // 7. First-contact greeting (canned; see module header). The server's
  // first-contact directive points at message_principal (DMs the principal).
  if (greetPending) {
    const hello = ownerName
      ? `Hi ${ownerName} — I'm connected to Filament and ready.`
      : "Hi — I'm connected to Filament and ready.";
    const res = await client.messagePrincipal(hello);
    log(
      res.ok
        ? "filament-connect: sent first-contact hello"
        : `filament-connect: greeting failed (${res.error?.code ?? "?"})`,
    );
  }

  return { stop, snapshot };
}
