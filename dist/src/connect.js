import { buildSnapshot, FcmConnection } from "./fcm.js";
import { FilamentMcpClient } from "./mcp-client.js";
import { classifyGetSelf, isFirstContact } from "./onboarding-core.js";
import { cachedToken, saveIdentity } from "./token-store.js";
const DEFAULT_MCP_URL = "https://api.filament.dm/mcp/agents";
const GETSELF_MAX_ATTEMPTS = 40;
const GETSELF_INTERVAL_MS = 3e3;
const HEARTBEAT_INTERVAL_MS = 2e4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function resolveMcpSettings(pluginConfig, env = process.env) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const cfgToken = cfg.connectToken;
  const hasCfgToken = typeof cfgToken === "string" && cfgToken.trim().length > 0 || typeof cfgToken === "object" && cfgToken !== null;
  const envToken = env.FILAMENT_MCP_TOKEN?.trim();
  const tokenInput = hasCfgToken ? cfgToken : envToken || void 0;
  const cfgUrl = typeof cfg.mcpUrl === "string" ? cfg.mcpUrl.trim() : "";
  const mcpUrl = (cfgUrl || env.FILAMENT_MCP_URL?.trim() || DEFAULT_MCP_URL).replace(/\/+$/, "");
  return { tokenInput, mcpUrl };
}
function loopIds(result, key) {
  if (!result.ok || !result.data || typeof result.data !== "object") return [];
  const list = result.data[key];
  if (!Array.isArray(list)) return [];
  return list.map(
    (item) => item && typeof item === "object" ? item.loop_id : void 0
  ).filter((id) => typeof id === "string" && id.length > 0);
}
async function acceptPending(client, log) {
  try {
    for (const loopId of loopIds(await client.listPendingInvites(), "invites")) {
      const res = await client.acceptInvite(loopId);
      log(
        `filament-connect: accept_invite ${loopId} ${res.ok ? "ok" : `failed (${res.error?.code ?? "?"})`}`
      );
    }
  } catch (error) {
    log(`filament-connect: invites step failed (continuing): ${String(error)}`);
  }
  try {
    for (const loopId of loopIds(await client.listVouches(), "vouches")) {
      const res = await client.acceptVouch(loopId);
      log(
        `filament-connect: accept_vouch ${loopId} ${res.ok ? "ok" : `failed (${res.error?.code ?? "?"})`}`
      );
    }
  } catch (error) {
    log(`filament-connect: vouches step failed (continuing): ${String(error)}`);
  }
}
async function runConnect(opts) {
  const { mcpUrl, token, log = () => {
  }, onInbound } = opts;
  const client = new FilamentMcpClient(mcpUrl, token);
  let fcm = null;
  let heartbeatTimer = null;
  const stop = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    fcm?.stop();
    fcm = null;
  };
  const snapshot = () => fcm ? fcm.snapshot() : buildSnapshot(false);
  await client.initialize();
  const greetPending = isFirstContact(client.instructions);
  let identity = null;
  let ownerName;
  for (let attempt = 1; attempt <= GETSELF_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await client.getSelf();
    } catch (error) {
      log(
        `filament-connect: get_self attempt ${attempt}/${GETSELF_MAX_ATTEMPTS} threw: ${String(error)}`
      );
      if (attempt < GETSELF_MAX_ATTEMPTS) await sleep(GETSELF_INTERVAL_MS);
      continue;
    }
    const decision = classifyGetSelf(res);
    if (decision.status === "finalized" && decision.identity) {
      identity = decision.identity;
      const owner = res.data?.owner;
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
    return { stop, snapshot, client };
  }
  saveIdentity({ ...identity, onboardedAt: Date.now() });
  log(
    `filament-connect: identity principal=${identity.principal} ccRoom=${identity.ccRoomId ?? "(none)"}`
  );
  await acceptPending(client, log);
  fcm = new FcmConnection(void 0, log, onInbound);
  try {
    await fcm.start();
  } catch (error) {
    log(`filament-connect: FCM registration failed (continuing without push): ${String(error)}`);
  }
  const fcmToken = cachedToken();
  if (fcmToken) {
    const res = await client.registerPushToken(fcmToken, "android");
    log(
      res.ok ? "filament-connect: push token registered with Filament" : `filament-connect: register_push_token failed (${res.error?.code ?? "?"})`
    );
  } else {
    log("filament-connect: no FCM token available; skipping register_push_token");
  }
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
  if (greetPending) {
    const hello = ownerName ? `Hi ${ownerName} \u2014 I'm connected to Filament and ready.` : "Hi \u2014 I'm connected to Filament and ready.";
    const res = await client.messagePrincipal(hello);
    log(
      res.ok ? "filament-connect: sent first-contact hello" : `filament-connect: greeting failed (${res.error?.code ?? "?"})`
    );
  }
  return { stop, snapshot, client };
}
export {
  resolveMcpSettings,
  runConnect
};
//# sourceMappingURL=connect.js.map
