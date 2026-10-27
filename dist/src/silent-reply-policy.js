import { FILAMENT_CHANNEL_ID } from "./accounts.js";
import { isUnsetPath, runOpenclawCli } from "./config-write.js";
const GROUP_SILENCE_PATH = `surfaces.${FILAMENT_CHANNEL_ID}.silentReply.group`;
async function ensureGroupSilenceAllowed(log, run = runOpenclawCli) {
  const current = await run(["config", "get", GROUP_SILENCE_PATH, "--json"]);
  if (current.code === 0) return "present";
  if (!isUnsetPath(current.stdout.trim())) {
    log(`filament: could not read ${GROUP_SILENCE_PATH} (exit ${current.code}); leaving it`);
    return "failed";
  }
  const patch = { surfaces: { [FILAMENT_CHANNEL_ID]: { silentReply: { group: "allow" } } } };
  const written = await run(["config", "patch", "--stdin"], JSON.stringify(patch));
  if (written.code !== 0) {
    log(`filament: could not set ${GROUP_SILENCE_PATH}: ${written.stderr.trim() || "?"}`);
    return "failed";
  }
  log(`filament: set ${GROUP_SILENCE_PATH} to "allow" so group turns may end in silence`);
  return "set";
}
let ensured = null;
function ensureGroupSilenceAllowedOnce(log) {
  ensured ??= ensureGroupSilenceAllowed(log).catch((error) => {
    log(`filament: could not set ${GROUP_SILENCE_PATH}: ${String(error)}`);
    return "failed";
  });
  return ensured;
}
export {
  GROUP_SILENCE_PATH,
  ensureGroupSilenceAllowed,
  ensureGroupSilenceAllowedOnce
};
