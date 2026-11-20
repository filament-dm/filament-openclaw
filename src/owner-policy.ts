/**
 * Records the agent's Filament principal as a command owner (`commands.ownerAllowFrom`), so its
 * own messages are owner turns: OpenClaw's owner-only tools and commands (the `openclaw` tool,
 * `/restart`, exec approvals) otherwise refuse a turn from Filament. Like CLI pairing, which
 * records the first owner, it adds the principal only while no Filament owner is listed, never
 * changes or removes an entry the owner wrote, and adds each principal at most once: an owner who
 * removes the entry keeps it removed.
 */
import { FILAMENT_CHANNEL_ID } from "./accounts.js";
import { isUnsetPath, type RunCli, runOpenclawCli } from "./config-write.js";
import { markOwnerRecorded, ownerRecordedAt } from "./state/owners.js";

export const OWNER_ALLOW_FROM_PATH = "commands.ownerAllowFrom";

export type OwnerOutcome = "set" | "present" | "other-owner" | "removed-by-owner" | "failed";

/** Which principals this gateway has recorded before; the plugin state store by default. */
export interface OwnerMemory {
  recordedAt: (principal: string) => number | undefined;
  markRecorded: (principal: string) => void;
}

const stateMemory: OwnerMemory = {
  recordedAt: ownerRecordedAt,
  markRecorded: (principal) => markOwnerRecorded(principal),
};

export function ownerEntry(principal: string): string {
  return `${FILAMENT_CHANNEL_ID}:${principal}`;
}

/** The owner list with the principal added, or the reason to leave it as it is. */
export function withPrincipalOwner(
  current: unknown,
  principal: string,
): { list: string[] } | { outcome: "present" | "other-owner" } {
  const list = Array.isArray(current)
    ? current.filter((entry): entry is string => typeof entry === "string")
    : [];
  const entry = ownerEntry(principal);
  if (list.includes(entry)) return { outcome: "present" };
  const prefix = `${FILAMENT_CHANNEL_ID}:`;
  if (list.some((existing) => existing.trim().toLowerCase().startsWith(prefix))) {
    return { outcome: "other-owner" };
  }
  return { list: [...list, entry] };
}

export async function ensurePrincipalOwner(
  principal: string,
  log: (message: string) => void,
  run: RunCli = runOpenclawCli,
  memory: OwnerMemory = stateMemory,
): Promise<OwnerOutcome> {
  if (!principal.startsWith("@")) return "failed";
  if (memory.recordedAt(principal) !== undefined) {
    const read = await run(["config", "get", OWNER_ALLOW_FROM_PATH, "--json"]);
    const listed = read.code === 0 && read.stdout.includes(JSON.stringify(ownerEntry(principal)));
    return listed ? "present" : "removed-by-owner";
  }
  const read = await run(["config", "get", OWNER_ALLOW_FROM_PATH, "--json"]);
  let current: unknown = [];
  if (read.code === 0) {
    try {
      current = JSON.parse(read.stdout);
    } catch {
      log(`filament: could not parse ${OWNER_ALLOW_FROM_PATH}; leaving it`);
      return "failed";
    }
  } else if (!isUnsetPath(read.stdout.trim())) {
    log(`filament: could not read ${OWNER_ALLOW_FROM_PATH} (exit ${read.code}); leaving it`);
    return "failed";
  }
  const next = withPrincipalOwner(current, principal);
  if ("outcome" in next) {
    if (next.outcome === "other-owner") {
      log(
        `filament: ${OWNER_ALLOW_FROM_PATH} already names a Filament owner; not adding ${principal}`,
      );
    }
    return next.outcome;
  }
  const patch = { commands: { ownerAllowFrom: next.list } };
  const written = await run(["config", "patch", "--stdin"], JSON.stringify(patch));
  if (written.code !== 0) {
    log(`filament: could not set ${OWNER_ALLOW_FROM_PATH}: ${written.stderr.trim() || "?"}`);
    return "failed";
  }
  memory.markRecorded(principal);
  log(`filament: recorded ${principal} as a command owner (${OWNER_ALLOW_FROM_PATH})`);
  return "set";
}

let queue: Promise<unknown> = Promise.resolve();

/** One write at a time across accounts, each after the ones before it. Never throws. */
export function ensurePrincipalOwnerQueued(
  principal: string,
  log: (message: string) => void,
): Promise<OwnerOutcome> {
  const next = queue.then(() =>
    ensurePrincipalOwner(principal, log).catch((error: unknown) => {
      log(`filament: could not set ${OWNER_ALLOW_FROM_PATH}: ${String(error)}`);
      return "failed" as const;
    }),
  );
  queue = next;
  return next;
}
