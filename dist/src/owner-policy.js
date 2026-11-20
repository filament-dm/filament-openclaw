import { FILAMENT_CHANNEL_ID } from "./accounts.js";
import { isUnsetPath, runOpenclawCli } from "./config-write.js";
import { markOwnerRecorded, ownerRecordedAt } from "./state/owners.js";
const OWNER_ALLOW_FROM_PATH = "commands.ownerAllowFrom";
const stateMemory = {
  recordedAt: ownerRecordedAt,
  markRecorded: (principal) => markOwnerRecorded(principal)
};
function ownerEntry(principal) {
  return `${FILAMENT_CHANNEL_ID}:${principal}`;
}
function withPrincipalOwner(current, principal) {
  const list = Array.isArray(current) ? current.filter((entry2) => typeof entry2 === "string") : [];
  const entry = ownerEntry(principal);
  if (list.includes(entry)) return { outcome: "present" };
  const prefix = `${FILAMENT_CHANNEL_ID}:`;
  if (list.some((existing) => existing.trim().toLowerCase().startsWith(prefix))) {
    return { outcome: "other-owner" };
  }
  return { list: [...list, entry] };
}
async function ensurePrincipalOwner(principal, log, run = runOpenclawCli, memory = stateMemory) {
  if (!principal.startsWith("@")) return "failed";
  if (memory.recordedAt(principal) !== void 0) {
    const read2 = await run(["config", "get", OWNER_ALLOW_FROM_PATH, "--json"]);
    const listed = read2.code === 0 && read2.stdout.includes(JSON.stringify(ownerEntry(principal)));
    return listed ? "present" : "removed-by-owner";
  }
  const read = await run(["config", "get", OWNER_ALLOW_FROM_PATH, "--json"]);
  let current = [];
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
        `filament: ${OWNER_ALLOW_FROM_PATH} already names a Filament owner; not adding ${principal}`
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
let queue = Promise.resolve();
function ensurePrincipalOwnerQueued(principal, log) {
  const next = queue.then(
    () => ensurePrincipalOwner(principal, log).catch((error) => {
      log(`filament: could not set ${OWNER_ALLOW_FROM_PATH}: ${String(error)}`);
      return "failed";
    })
  );
  queue = next;
  return next;
}
export {
  OWNER_ALLOW_FROM_PATH,
  ensurePrincipalOwner,
  ensurePrincipalOwnerQueued,
  ownerEntry,
  withPrincipalOwner
};
