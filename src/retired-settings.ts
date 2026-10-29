/**
 * Settings the config schema still accepts so an older config loads, but nothing reads:
 * `transport` and `firebase` at the top level, and `transport` per account. The plugin removes them
 * from the gateway's config once per process. A release can drop them from the schema once every
 * gateway has run one that removes them.
 */
import { asRecord, PLUGIN_ID } from "./accounts.js";
import { type RunCli, runOpenclawCli } from "./config-write.js";

const RETIRED_TOP_LEVEL = ["transport", "firebase"] as const;
const RETIRED_PER_ACCOUNT = ["transport"] as const;

export interface RetiredSettings {
  /** A merge patch for `openclaw config patch`: null removes a key. */
  patch: unknown;
  /** Config paths under the plugin's `config`, for the log. */
  paths: string[];
}

export function retiredSettings(pluginConfig: unknown): RetiredSettings | null {
  const cfg = asRecord(pluginConfig);
  const config: Record<string, unknown> = {};
  const paths: string[] = [];
  for (const key of RETIRED_TOP_LEVEL) {
    if (key in cfg) {
      config[key] = null;
      paths.push(key);
    }
  }
  const accounts: Record<string, unknown> = {};
  for (const [accountId, raw] of Object.entries(asRecord(cfg.accounts))) {
    const entry = asRecord(raw);
    const retired = RETIRED_PER_ACCOUNT.filter((key) => key in entry);
    if (retired.length === 0) continue;
    accounts[accountId] = Object.fromEntries(retired.map((key) => [key, null]));
    paths.push(...retired.map((key) => `accounts.${accountId}.${key}`));
  }
  if (Object.keys(accounts).length > 0) config.accounts = accounts;
  if (paths.length === 0) return null;
  return { patch: { plugins: { entries: { [PLUGIN_ID]: { config } } } }, paths };
}

export type RetiredSettingsOutcome = "none" | "removed" | "failed";

export async function removeRetiredSettings(
  pluginConfig: unknown,
  log: (message: string) => void,
  run: RunCli = runOpenclawCli,
): Promise<RetiredSettingsOutcome> {
  const retired = retiredSettings(pluginConfig);
  if (!retired) return "none";
  const written = await run(["config", "patch", "--stdin"], JSON.stringify(retired.patch));
  const paths = retired.paths.join(", ");
  if (written.code !== 0) {
    log(`filament: could not remove retired settings (${paths}): ${written.stderr.trim() || "?"}`);
    return "failed";
  }
  log(`filament: removed retired settings that nothing reads: ${paths}`);
  return "removed";
}

let removed: Promise<RetiredSettingsOutcome> | null = null;

/** Once per gateway process, whichever account starts first. Never throws. */
export function removeRetiredSettingsOnce(
  pluginConfig: unknown,
  log: (message: string) => void,
): Promise<RetiredSettingsOutcome> {
  removed ??= removeRetiredSettings(pluginConfig, log).catch((error: unknown) => {
    log(`filament: could not remove retired settings: ${String(error)}`);
    return "failed" as const;
  });
  return removed;
}
