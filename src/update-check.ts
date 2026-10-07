/**
 * How a running gateway learns the plugin has a newer version on `main`, and how it takes it.
 * Once a day one account fetches the plugin manifest from GitHub and compares it with the
 * installed version. A newer one is announced once, in the principal's backchannel, with a button
 * that runs `openclaw plugins update` through the CLI; the gateway hot-reloads the plugin and the
 * account comes back on the new version and says so.
 */
import { PLUGIN_ID } from "./accounts.js";
import { type CliResult, type RunCli, runOpenclawCli } from "./config-write.js";
import { UPDATE_NOW_LABEL } from "./gateway.js";
import type { UpdateCheckState } from "./state/updates.js";
import { isNewerVersion, PLUGIN_VERSION } from "./version.js";

export { UPDATE_NOW_LABEL, type UpdateCheckState };

export const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/filament-dm/filament-openclaw/main/openclaw.plugin.json";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const UPDATE_COMMAND = `openclaw plugins update ${PLUGIN_ID} --accept-capabilities`;

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
    "",
    `Or run it on the machine hosting the gateway: \`${UPDATE_COMMAND}\`. The gateway reloads the plugin in place; no restart.`,
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

/** `openclaw plugins update` from inside the gateway; it hot-reloads the plugin on success. */
export async function runPluginUpdate(run: RunCli = runOpenclawCli): Promise<CliResult> {
  const result = await run(["plugins", "update", PLUGIN_ID, "--accept-capabilities"]);
  if (result.code !== 0) {
    throw new Error(
      `${UPDATE_COMMAND} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}
