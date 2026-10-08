import { loadBearer } from "./state/bearers.js";
function resolveBearer(configuredToken, log, loadPersisted = loadBearer) {
  const persisted = loadPersisted(configuredToken);
  if (persisted) {
    log("filament-connect: using the bearer persisted for this connect token");
    return persisted;
  }
  return configuredToken;
}
export {
  resolveBearer
};
