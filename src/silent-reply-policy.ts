/**
 * Whether a Filament group turn may end in silence. OpenClaw reads it from
 * `surfaces.filament.silentReply.group`, and its default moved from "allow" to "disallow" in
 * 2026.10. Under "disallow" every group turn is reply-required: an agent that chooses NO_REPLY
 * fails the turn instead of staying quiet. The plugin sets "allow" once, never over a value the
 * owner set, and marks the turns that do need an answer with `WasMentioned` (work-item.ts).
 */
import { FILAMENT_CHANNEL_ID } from "./accounts.js";
import { isUnsetPath, type RunCli, runOpenclawCli } from "./config-write.js";

export const GROUP_SILENCE_PATH = `surfaces.${FILAMENT_CHANNEL_ID}.silentReply.group`;

export type GroupSilenceOutcome = "set" | "present" | "failed";

export async function ensureGroupSilenceAllowed(
  log: (message: string) => void,
  run: RunCli = runOpenclawCli,
): Promise<GroupSilenceOutcome> {
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

let ensured: Promise<GroupSilenceOutcome> | null = null;

/** Once per gateway process, whichever account starts first. Never throws. */
export function ensureGroupSilenceAllowedOnce(
  log: (message: string) => void,
): Promise<GroupSilenceOutcome> {
  ensured ??= ensureGroupSilenceAllowed(log).catch((error: unknown) => {
    log(`filament: could not set ${GROUP_SILENCE_PATH}: ${String(error)}`);
    return "failed" as const;
  });
  return ensured;
}
