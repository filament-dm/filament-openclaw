import { createHash } from "node:crypto";

import { openTable } from "./store.js";

/**
 * Bearers exchanged for a connect token, read only: keyed by a hash of that token, so a new token
 * never reuses an old token's bearer. Nothing writes new ones.
 */
interface StoredBearer {
  bearer: string;
  obtainedAt: number;
}

// Read only, but the options must not change: see openTable.
const bearers = openTable<StoredBearer>("bearers", 16);

/** Never store or log the connect token itself. */
function bearerKey(connectToken: string): string {
  return createHash("sha256").update(connectToken).digest("hex").slice(0, 16);
}

export function loadBearer(connectToken: string): string | undefined {
  return bearers.get(bearerKey(connectToken))?.bearer;
}
