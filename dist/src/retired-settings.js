import { asRecord, PLUGIN_ID } from "./accounts.js";
import { runOpenclawCli } from "./config-write.js";
const RETIRED_TOP_LEVEL = ["transport", "firebase"];
const RETIRED_PER_ACCOUNT = ["transport"];
function retiredSettings(pluginConfig) {
  const cfg = asRecord(pluginConfig);
  const config = {};
  const paths = [];
  for (const key of RETIRED_TOP_LEVEL) {
    if (key in cfg) {
      config[key] = null;
      paths.push(key);
    }
  }
  const accounts = {};
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
async function removeRetiredSettings(pluginConfig, log, run = runOpenclawCli) {
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
let removed = null;
function removeRetiredSettingsOnce(pluginConfig, log) {
  removed ??= removeRetiredSettings(pluginConfig, log).catch((error) => {
    log(`filament: could not remove retired settings: ${String(error)}`);
    return "failed";
  });
  return removed;
}
export {
  removeRetiredSettings,
  removeRetiredSettingsOnce,
  retiredSettings
};
