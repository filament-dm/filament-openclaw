import { PLUGIN_ID } from "./accounts.js";
import { runOpenclawCli } from "./config-write.js";
import { PLUGIN_VERSION } from "./version.js";
const UPDATE_NOW_LABEL = "Update now";
const UPDATE_CHECK_URL = "https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/openclaw.plugin.json";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
function isNewerVersion(candidate, installed) {
  const parse = (v) => {
    const numbers = v.trim().replace(/^v/, "").split(".").map(Number);
    return numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null;
  };
  const a = parse(candidate);
  const b = parse(installed);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
const UPDATE_COMMAND = `openclaw plugins update ${PLUGIN_ID} --accept-capabilities`;
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
    `- [${UPDATE_NOW_LABEL}](filament:message-send)`
  ].join("\n");
}
function updatedBody(previous, current) {
  return isNewerVersion(current, previous) ? `Updated the Filament plugin to v${current} (from v${previous}).` : `The Filament plugin is already on the latest version, v${current}.`;
}
async function checkForUpdate(ctx) {
  const now = ctx.now?.() ?? Date.now();
  const state = ctx.load();
  if (state.lastCheckedAt !== void 0 && now - state.lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) {
    return "skipped";
  }
  ctx.save({ ...state, lastCheckedAt: now });
  const installed = ctx.installed ?? PLUGIN_VERSION;
  let latest;
  try {
    latest = await fetchLatestVersion(ctx.url ?? UPDATE_CHECK_URL, ctx.fetchImpl);
  } catch (error) {
    ctx.log(`filament-update: could not read the latest version: ${String(error)}`);
    return "failed";
  }
  if (!isNewerVersion(latest, installed)) {
    ctx.log(`filament-update: v${installed} is current`);
    return "current";
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
    if (abortSignal.aborted) break;
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
function startPluginUpdate(run = runOpenclawCli) {
  return run(["plugins", "update", PLUGIN_ID, "--accept-capabilities"]);
}
function updateFailureMessage(result) {
  return `${UPDATE_COMMAND} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`;
}
export {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_URL,
  UPDATE_COMMAND,
  UPDATE_NOW_LABEL,
  checkForUpdate,
  fetchLatestVersion,
  isNewerVersion,
  runUpdateChecks,
  startPluginUpdate,
  updateFailureMessage,
  updateNoticeBody,
  updatedBody
};
