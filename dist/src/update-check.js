import { asRecord, PLUGIN_ID } from "./accounts.js";
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
const GIT_REPOSITORY = "https://github.com/filament-dm/filament-openclaw.git";
const GIT_REPOSITORY_SSH = "git@github.com:filament-dm/filament-openclaw.git";
const CLAWHUB_PACKAGE = "@filament-dm/filament-openclaw";
const UPDATE_FAILURE_BODY = [
  "I couldn\u2019t update the Filament plugin. Follow these steps on the OpenClaw host.",
  "",
  "1. Run `openclaw plugins inspect filament-openclaw` to check the installed version and source.",
  "2. Stop the gateway through the service or terminal that started it, then run `openclaw plugins update filament-openclaw --accept-capabilities` using the same OpenClaw profile. If you installed from a local checkout, update and rebuild that checkout instead.",
  "3. Start the gateway again. If the update failed, use the instructions printed in the terminal."
].join("\n");
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
function updateInstallSpec(inspection, latest) {
  const install = asRecord(asRecord(inspection).install);
  if (install.source === "git" && (install.gitUrl === GIT_REPOSITORY || install.gitUrl === GIT_REPOSITORY_SSH) && (!install.gitRef || install.gitRef === "main" || /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(String(install.gitRef)))) {
    return `git:${install.gitUrl}@main`;
  }
  if (install.source === "clawhub" && install.clawhubPackage === CLAWHUB_PACKAGE) {
    return `clawhub:${CLAWHUB_PACKAGE}@${latest}`;
  }
  throw new Error("This install source requires a manual update");
}
function requireCliSuccess(operation, result) {
  if (result.code !== 0) {
    throw new Error(
      `${operation} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`
    );
  }
}
async function startPluginUpdate(installed, beforeInstall, run = runOpenclawCli, latestVersion = () => fetchLatestVersion(UPDATE_CHECK_URL)) {
  const latest = await latestVersion();
  if (!/^([0-9]+\.){2}[0-9]+$/.test(latest)) {
    throw new Error("The update manifest has an invalid release version");
  }
  if (!isNewerVersion(latest, installed)) return "current";
  const inspection = await run(["plugins", "inspect", PLUGIN_ID, "--json"]);
  requireCliSuccess("Plugin inspection", inspection);
  const spec = updateInstallSpec(JSON.parse(inspection.stdout), latest);
  beforeInstall();
  const result = await run([
    "plugins",
    "install",
    spec,
    "--force",
    "--no-enable",
    "--accept-capabilities"
  ]);
  requireCliSuccess("Plugin install", result);
  return "installed";
}
export {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_URL,
  UPDATE_FAILURE_BODY,
  UPDATE_NOW_LABEL,
  checkForUpdate,
  fetchLatestVersion,
  isNewerVersion,
  runUpdateChecks,
  startPluginUpdate,
  updateNoticeBody,
  updatedBody
};
