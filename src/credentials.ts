/**
 * Which bearer an account's MCP calls carry: the configured connect token
 * itself. That is what Filament serves — the connect token minted at reserve
 * time authenticates `/mcp/agents` for as long as the agent exists — for both
 * transports.
 *
 * The one exception is an account whose connect token was once exchanged for
 * a bearer (RFC 8693, a server feature since withdrawn): the exchange revoked
 * the connect token, and the bearer it returned is persisted under that
 * token's key. That bearer stays the account's credential.
 */
import { loadBearer } from "./token-store.js";

/**
 * The bearer for `configuredToken`: one persisted under this token's own key,
 * else the token itself. A different token never picks up another's bearer.
 */
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
