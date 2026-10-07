import { PLUGIN_ID } from "./accounts.js";
import { runOpenclawCli } from "./config-write.js";
import { UPDATE_NOW_LABEL } from "./gateway.js";
import { isNewerVersion, PLUGIN_VERSION } from "./version.js";
const DEFAULT_UPDATE_CHECK_URL = "https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/openclaw.plugin.json";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
const UPDATE_COMMAND = `openclaw plugins update ${PLUGIN_ID} --accept-capabilities`;
function resolveUpdatePolicy(pluginConfig, env = process.env) {
  const raw = pluginConfig?.updates;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "notify" || value === "auto" || value === "off") return value;
  const disabled = env.FILAMENT_DISABLE_UPDATE_CHECK?.trim().toLowerCase();
  return disabled === "true" || disabled === "1" ? "off" : "notify";
}
function resolveUpdateCheckUrl(env = process.env) {
  return env.FILAMENT_UPDATE_CHECK_URL?.trim() || DEFAULT_UPDATE_CHECK_URL;
}
async function fetchLatestVersion(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const manifest = await res.json();
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("the manifest has no version");
  }
  return manifest.version.trim();
}
function updateNoticeBody(latest, installed) {
  return [
    `\u{1F4E6} A new version of the Filament plugin is available: v${latest} (this gateway runs v${installed}).`,
    "",
    `- [${UPDATE_NOW_LABEL}](filament:message-send)`,
    "",
    `Or run it on the machine hosting the gateway: \`${UPDATE_COMMAND}\`. The gateway reloads the plugin in place; no restart.`
  ].join("\n");
}
function updatedBody(previous, current) {
  return isNewerVersion(current, previous) ? `Updated the Filament plugin to v${current} (from v${previous}).` : `The Filament plugin is already on the latest version, v${current}.`;
}
async function checkForUpdate(ctx) {
  if (ctx.policy === "off") return "skipped";
  const now = ctx.now?.() ?? Date.now();
  const state = ctx.load();
  if (state.lastCheckedAt !== void 0 && now - state.lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) {
    return "skipped";
  }
  ctx.save({ ...state, lastCheckedAt: now });
  const installed = ctx.installed ?? PLUGIN_VERSION;
  let latest;
  try {
    latest = await fetchLatestVersion(ctx.url, ctx.fetchImpl);
  } catch (error) {
    ctx.log(`filament-update: could not read the latest version: ${String(error)}`);
    return "failed";
  }
  if (!isNewerVersion(latest, installed)) {
    ctx.log(`filament-update: v${installed} is current`);
    return "current";
  }
  if (ctx.policy === "auto") {
    ctx.log(`filament-update: v${latest} is available; updating from v${installed}`);
    await ctx.update();
    return "updating";
  }
  if (state.notifiedVersion === latest) return "already-notified";
  ctx.log(`filament-update: v${latest} is available (installed v${installed})`);
  if (await ctx.say(updateNoticeBody(latest, installed))) {
    ctx.save({ lastCheckedAt: now, notifiedVersion: latest });
    return "notified";
  }
  return "failed";
}
async function runUpdateChecks(ctx, abortSignal, tickMs = 60 * 60 * 1e3) {
  while (!abortSignal.aborted) {
    try {
      await checkForUpdate(ctx);
    } catch (error) {
      ctx.log(`filament-update: check failed: ${String(error)}`);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(done, tickMs);
      function done() {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", done);
        resolve();
      }
      abortSignal.addEventListener("abort", done, { once: true });
    });
  }
}
async function runPluginUpdate(run = runOpenclawCli) {
  const result = await run(["plugins", "update", PLUGIN_ID, "--accept-capabilities"]);
  if (result.code !== 0) {
    throw new Error(
      `${UPDATE_COMMAND} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result;
}
export {
  DEFAULT_UPDATE_CHECK_URL,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_COMMAND,
  UPDATE_NOW_LABEL,
  checkForUpdate,
  fetchLatestVersion,
  resolveUpdateCheckUrl,
  resolveUpdatePolicy,
  runPluginUpdate,
  runUpdateChecks,
  updateNoticeBody,
  updatedBody
};
