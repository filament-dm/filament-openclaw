/**
 * How a running gateway learns the plugin has a newer version on `main`, and how it takes it.
 * Once a day one account fetches the plugin manifest from GitHub and compares it with the
 * installed version. A newer one is announced once, in the principal's backchannel, with a button
 * that replaces the plugin through the running gateway. The account reports the version it loads.
 */
import { asRecord, PLUGIN_ID } from "./accounts.js";
import { type CliResult, type RunCli, runOpenclawCli } from "./config-write.js";
import type { UpdateCheckState } from "./state/updates.js";
import { PLUGIN_VERSION } from "./version.js";

export type { UpdateCheckState };

/** The notice's button: a suggested message sends its own text, so the text is what the gateway parses. */
export const UPDATE_NOW_LABEL = "Update now";

export const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/openclaw.plugin.json";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Dotted numeric compare, missing parts read as 0; anything unparsable is never newer. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const parse = (v: string): number[] | null => {
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

export const UPDATE_FAILURE_BODY = [
  "I couldn’t update the Filament plugin. Follow these steps on the OpenClaw host.",
  "",
  "1. Run `openclaw plugins inspect filament-openclaw` to check the installed version and source.",
  "2. Stop the gateway through the service or terminal that started it, then run `openclaw plugins update filament-openclaw --accept-capabilities` using the same OpenClaw profile. If you installed from a local checkout, update and rebuild that checkout instead.",
  "3. Start the gateway again. If the update failed, use the instructions printed in the terminal.",
].join("\n");

export async function fetchLatestVersion(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const manifest = (await res.json()) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("the manifest has no version");
  }
  return manifest.version.trim();
}

export function updateNoticeBody(latest: string, installed: string): string {
  return [
    `📦 A new version of the Filament plugin is available: v${latest} (this gateway runs v${installed}).`,
    "",
    `- [${UPDATE_NOW_LABEL}](filament:message-send)`,
  ].join("\n");
}

export function updatedBody(previous: string, current: string): string {
  return isNewerVersion(current, previous)
    ? `Updated the Filament plugin to v${current} (from v${previous}).`
    : `The Filament plugin is already on the latest version, v${current}.`;
}

export interface UpdateCheckContext {
  installed?: string;
  url?: string;
  fetchImpl?: typeof fetch;
  load: () => UpdateCheckState;
  save: (state: UpdateCheckState) => void;
  say: (markdownBody: string) => Promise<boolean>;
  log: (message: string) => void;
  now?: () => number;
}

export type UpdateCheckOutcome = "skipped" | "current" | "notified" | "already-notified" | "failed";

export async function checkForUpdate(ctx: UpdateCheckContext): Promise<UpdateCheckOutcome> {
  const now = ctx.now?.() ?? Date.now();
  const state = ctx.load();
  if (state.lastCheckedAt !== undefined && now - state.lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) {
    return "skipped";
  }
  // Marked before the fetch: a failing fetch must not be retried by every account every minute.
  ctx.save({ ...state, lastCheckedAt: now });
  const installed = ctx.installed ?? PLUGIN_VERSION;
  let latest: string;
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

/** Polls `checkForUpdate` hourly until abort; the daily spacing lives in the shared state. */
export async function runUpdateChecks(
  ctx: UpdateCheckContext,
  abortSignal: AbortSignal,
  tickMs = 60 * 60 * 1000,
): Promise<void> {
  while (!abortSignal.aborted) {
    try {
      await checkForUpdate(ctx);
    } catch (error) {
      ctx.log(`filament-update: check failed: ${String(error)}`);
    }
    if (abortSignal.aborted) break;
    await new Promise<void>((resolve) => {
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

function updateInstallSpec(inspection: unknown, latest: string): string {
  const install = asRecord(asRecord(inspection).install);
  if (
    install.source === "git" &&
    (install.gitUrl === GIT_REPOSITORY || install.gitUrl === GIT_REPOSITORY_SSH) &&
    (!install.gitRef ||
      install.gitRef === "main" ||
      /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(String(install.gitRef)))
  ) {
    return `git:${install.gitUrl}@main`;
  }
  if (install.source === "clawhub" && install.clawhubPackage === CLAWHUB_PACKAGE) {
    return `clawhub:${CLAWHUB_PACKAGE}@${latest}`;
  }
  throw new Error("This install source requires a manual update");
}

function requireCliSuccess(operation: string, result: CliResult): void {
  if (result.code !== 0) {
    throw new Error(
      `${operation} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

/**
 * Installs a replacement through the live gateway. The caller starts this in the background:
 * the CLI waits for the replacement, which in turn waits for the caller's account to stop.
 */
export async function startPluginUpdate(
  installed: string,
  beforeInstall: () => void,
  run: RunCli = runOpenclawCli,
  latestVersion = () => fetchLatestVersion(UPDATE_CHECK_URL),
): Promise<"current" | "installed"> {
  const latest = await latestVersion();
  if (!/^([0-9]+\.){2}[0-9]+$/.test(latest)) {
    throw new Error("The update manifest has an invalid release version");
  }
  if (!isNewerVersion(latest, installed)) return "current";

  const inspection = await run(["plugins", "inspect", PLUGIN_ID, "--json"]);
  requireCliSuccess("Plugin inspection", inspection);
  const spec = updateInstallSpec(JSON.parse(inspection.stdout), latest);
  beforeInstall();
  // The published Filament sources are fixed above. Preserve existing activation settings and
  // let OpenClaw enforce its installation policy and apply the new runtime.
  const result = await run([
    "plugins",
    "install",
    spec,
    "--force",
    "--no-enable",
    "--accept-capabilities",
  ]);
  requireCliSuccess("Plugin install", result);
  return "installed";
}
