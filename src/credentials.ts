/**
 * An account's bearer is its connect token, except for one whose token was exchanged for a
 * persisted bearer: the exchange revoked the token, so that bearer stays its credential.
 */
import { loadBearer } from "./token-store.js";

export function resolveBearer(
  configuredToken: string,
  log: (message: string) => void,
  loadPersisted: (connectToken: string) => string | undefined = loadBearer,
): string {
  const persisted = loadPersisted(configuredToken);
  if (persisted) {
    log("filament-connect: using the bearer persisted for this connect token");
    return persisted;
  }
  return configuredToken;
}
