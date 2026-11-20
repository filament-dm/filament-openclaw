import { PLUGIN_ID } from "./accounts.js";
import { runOpenclawCli } from "./config-write.js";
import { PLUGIN_VERSION } from "./version.js";
const UPDATE_NOW_LABEL = "Update now";
const UPDATE_CHECK_URL = "https://clawhub.ai/api/v1/packages/%40filament-dm%2Ffilament-openclaw";
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
const CLAWHUB_PACKAGE = "@filament-dm/filament-openclaw";
const INSTALL_COMMAND = `openclaw plugins install clawhub:${CLAWHUB_PACKAGE} --force --accept-capabilities`;
const REPLACEABLE_SOURCES = /* @__PURE__ */ new Set(["clawhub", "git", "npm"]);
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
async function fetchLatestVersion(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const latest = body.package?.latestVersion;
  if (typeof latest !== "string" || !latest.trim()) {
    throw new Error("ClawHub returned no latest version");
  }
  return latest.trim();
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
function installSource(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return void 0;
  const install = JSON.parse(stdout.slice(start)).install;
  return typeof install?.source === "string" ? install.source : void 0;
}
function cliOutput(result) {
  return (result.stderr || result.stdout).trim();
}
async function startPluginUpdate(params) {
  const run = params.run ?? runOpenclawCli;
  try {
    const inspection = await run(["plugins", "inspect", PLUGIN_ID, "--json"]);
    if (inspection.code !== 0) {
      return {
        kind: "failed",
        detail: `plugins inspect failed (exit ${inspection.code}): ${cliOutput(inspection)}`
      };
    }
    const source = installSource(inspection.stdout);
    if (!source || !REPLACEABLE_SOURCES.has(source)) {
      return {
        kind: "manual",
        reason: `the plugin is not a published install (source: ${source ?? "none"})`
      };
    }
    const latest = await (params.latestVersion ?? (() => fetchLatestVersion(UPDATE_CHECK_URL)))();
    if (!RELEASE_VERSION.test(latest)) {
      return { kind: "failed", detail: `ClawHub's latest version is not a release: ${latest}` };
    }
    if (source === "clawhub" && !isNewerVersion(latest, params.installed)) {
      return { kind: "current", version: params.installed };
    }
    params.beforeInstall?.();
    const result = await run([
      "plugins",
      "install",
      `clawhub:${CLAWHUB_PACKAGE}@${latest}`,
      "--force",
      "--accept-capabilities"
    ]);
    if (result.code !== 0) {
      return {
        kind: "failed",
        detail: `plugins install failed (exit ${result.code}): ${cliOutput(result)}`
      };
    }
    return { kind: "started", version: latest };
  } catch (error) {
    return { kind: "failed", detail: String(error) };
  }
}
function updateOutcomeBody(outcome) {
  switch (outcome.kind) {
    case "started":
      return null;
    case "current":
      return updatedBody(outcome.version, outcome.version);
    case "manual":
      return [
        "This gateway runs the Filament plugin from a local copy, so I can't update it from here.",
        "Update that copy, or switch to the published plugin by running this on the gateway host:",
        "",
        `\`${INSTALL_COMMAND}\``
      ].join("\n");
    case "failed":
      return [
        "I couldn't update the Filament plugin from here. On the machine that runs this OpenClaw gateway, run:",
        "",
        `\`${INSTALL_COMMAND}\``,
        "",
        "Keep the gateway running: I stay signed in to Filament. If it says the replacement was not applied, restart the gateway once."
      ].join("\n");
  }
}
export {
  CLAWHUB_PACKAGE,
  INSTALL_COMMAND,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_URL,
  UPDATE_NOW_LABEL,
  checkForUpdate,
  fetchLatestVersion,
  isNewerVersion,
  runUpdateChecks,
  startPluginUpdate,
  updateNoticeBody,
  updateOutcomeBody,
  updatedBody
};
