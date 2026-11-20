/**
 * How a running gateway learns the plugin has a newer release, and how it takes it.
 * Once a day one account asks ClawHub for the package's latest version and compares it with the
 * installed one. ClawHub moves `latest` only once a release passes its security checks, so a
 * version still being scanned, or merged to `main` but not released, is never announced.
 *
 * Taking it reinstalls the plugin at ClawHub's latest release when tapped, through the running gateway:
 * `openclaw plugins update` refuses to run beside a live gateway from OpenClaw 2026.11, while
 * `plugins install --force` is applied in place. A GitHub install moves to ClawHub on the way. A newer one is announced once, in the principal's backchannel, with a button
 * that runs `openclaw plugins update` through the CLI; the gateway hot-reloads the plugin and the
 * account comes back on the new version and says so.
 */
import { PLUGIN_ID } from "./accounts.js";
import { type CliResult, type RunCli, runOpenclawCli } from "./config-write.js";
import type { UpdateCheckState } from "./state/updates.js";
import { PLUGIN_VERSION } from "./version.js";

export type { UpdateCheckState };

/** The notice's button: a suggested message sends its own text, so the text is what the gateway parses. */
export const UPDATE_NOW_LABEL = "Update now";

/** ClawHub's public package endpoint for `@filament-dm/filament-openclaw`; no sign-in needed. */
export const UPDATE_CHECK_URL =
  "https://clawhub.ai/api/v1/packages/%40filament-dm%2Ffilament-openclaw";

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

/** The ClawHub package this plugin is released as. */
export const CLAWHUB_PACKAGE = "@filament-dm/filament-openclaw";

/**
 * Installs the latest release over whatever copy the gateway runs, keeping the plugin's config.
 * Also what an owner runs on the host when an update from chat fails.
 */
export const INSTALL_COMMAND = `openclaw plugins install clawhub:${CLAWHUB_PACKAGE} --force --accept-capabilities`;

/** Install sources a published release may replace. A linked or local copy is its owner's. */
const REPLACEABLE_SOURCES: ReadonlySet<string> = new Set(["clawhub", "git", "npm"]);

const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export async function fetchLatestVersion(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { package?: { latestVersion?: unknown } };
  const latest = body.package?.latestVersion;
  if (typeof latest !== "string" || !latest.trim()) {
    throw new Error("ClawHub returned no latest version");
  }
  return latest.trim();
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

export type PluginUpdateOutcome =
  /** The install ran; the gateway reloads the plugin and the account that comes back reports it. */
  | { kind: "started"; version: string }
  | { kind: "current"; version: string }
  /** Not a published install (a linked checkout, or no install record): left alone. */
  | { kind: "manual"; reason: string }
  | { kind: "failed"; detail: string };

export interface PluginUpdateParams {
  installed: string;
  /** Called right before the install, the last moment the account can leave its marker. */
  beforeInstall?: () => void;
  run?: RunCli;
  latestVersion?: () => Promise<string>;
}

function installSource(stdout: string): string | undefined {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  const install = (JSON.parse(stdout.slice(start)) as { install?: { source?: unknown } }).install;
  return typeof install?.source === "string" ? install.source : undefined;
}

function cliOutput(result: CliResult): string {
  return (result.stderr || result.stdout).trim();
}

/**
 * Takes the latest release from ClawHub and never throws. The caller must not await it from an
 * account's own call: the install waits for the gateway to swap the plugin, and the swap waits
 * for that account to stop.
 */
export async function startPluginUpdate(params: PluginUpdateParams): Promise<PluginUpdateOutcome> {
  const run = params.run ?? runOpenclawCli;
  try {
    const inspection = await run(["plugins", "inspect", PLUGIN_ID, "--json"]);
    if (inspection.code !== 0) {
      return {
        kind: "failed",
        detail: `plugins inspect failed (exit ${inspection.code}): ${cliOutput(inspection)}`,
      };
    }
    const source = installSource(inspection.stdout);
    if (!source || !REPLACEABLE_SOURCES.has(source)) {
      return {
        kind: "manual",
        reason: `the plugin is not a published install (source: ${source ?? "none"})`,
      };
    }
    const latest = await (params.latestVersion ?? (() => fetchLatestVersion(UPDATE_CHECK_URL)))();
    if (!RELEASE_VERSION.test(latest)) {
      return { kind: "failed", detail: `ClawHub's latest version is not a release: ${latest}` };
    }
    // A ClawHub install on the latest release has nothing to take; any other source moves over.
    if (source === "clawhub" && !isNewerVersion(latest, params.installed)) {
      return { kind: "current", version: params.installed };
    }
    params.beforeInstall?.();
    const result = await run([
      "plugins",
      "install",
      `clawhub:${CLAWHUB_PACKAGE}@${latest}`,
      "--force",
      "--accept-capabilities",
    ]);
    if (result.code !== 0) {
      return {
        kind: "failed",
        detail: `plugins install failed (exit ${result.code}): ${cliOutput(result)}`,
      };
    }
    return { kind: "started", version: latest };
  } catch (error) {
    return { kind: "failed", detail: String(error) };
  }
}

/** What the principal is told when the update did not start; the details stay in the log. */
export function updateOutcomeBody(outcome: PluginUpdateOutcome): string | null {
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
        `\`${INSTALL_COMMAND}\``,
      ].join("\n");
    case "failed":
      return [
        "I couldn't update the Filament plugin from here. On the machine that runs this OpenClaw gateway, run:",
        "",
        `\`${INSTALL_COMMAND}\``,
        "",
        "Keep the gateway running: I stay signed in to Filament. If it says the replacement was not applied, restart the gateway once.",
      ].join("\n");
  }
}
