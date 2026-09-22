/**
 * Persistent storage for the Filament plugin, backed by OpenClaw's plugin-state
 * keyed store (SQLite at ~/.openclaw/plugin-state.sqlite).
 *
 * Two things are persisted:
 *   - the agent identity learned during onboarding (get_self): principal,
 *     backchannel room, mxid.
 *   - the bearer token used for MCP calls, once a connect token (`fmcp_…`) has
 *     been exchanged for it (see src/connect.ts). The exchange is one-time
 *     (the connect token is single-use and gets revoked by the server on
 *     exchange), so persisting the resulting bearer lets a restart skip the
 *     exchange and reuse it directly.
 *
 * The poll cursor is deliberately NOT persisted here: it is kept in memory
 * only (see src/poll-work.ts). A restart without a cursor re-scans from the
 * beginning of the agent's unread work, which is safe (poll_work is
 * idempotent per event: already-answered items are skipped by the server's
 * work ledger, and unanswered ones are simply redelivered) — see
 * ROADMAP.md for the tradeoff.
 */
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";

/** The agent identity learned from Filament during onboarding (get_self). */
export interface AgentIdentity {
  mxid: string;
  /** The principal (owner) mxid that controls this agent. */
  principal: string;
  /** The command-and-control backchannel room id, when present. */
  ccRoomId?: string;
  onboardedAt: number;
}

/** A persisted bearer, obtained by exchanging a connect token once. */
export interface StoredBearer {
  bearer: string;
  /** ms since epoch; informational only (the exchanged bearer has no TTL). */
  obtainedAt: number;
}

const PLUGIN_ID = "filament-fcm";
const IDENTITY_NAMESPACE = "identity";
const IDENTITY_KEY = "self";
const BEARER_NAMESPACE = "bearer";
const BEARER_KEY = "current";

// Structural view of the sync keyed store — avoids depending on the store's
// exported type name (the runtime module is only present inside the gateway).
type SyncStore<T> = {
  lookup(key: string): T | undefined;
  register(key: string, value: T): void;
};

let idStore: SyncStore<AgentIdentity> | null = null;
let bearerStore: SyncStore<StoredBearer> | null = null;

function identityStore(): SyncStore<AgentIdentity> {
  if (!idStore) {
    idStore = createPluginStateSyncKeyedStore<AgentIdentity>(PLUGIN_ID, {
      namespace: IDENTITY_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new",
    }) as SyncStore<AgentIdentity>;
  }
  return idStore;
}

function bearerStoreInstance(): SyncStore<StoredBearer> {
  if (!bearerStore) {
    bearerStore = createPluginStateSyncKeyedStore<StoredBearer>(PLUGIN_ID, {
      namespace: BEARER_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new",
    }) as SyncStore<StoredBearer>;
  }
  return bearerStore;
}

/** Load the onboarded agent identity, or undefined if not onboarded yet. */
export function loadIdentity(): AgentIdentity | undefined {
  return identityStore().lookup(IDENTITY_KEY);
}

/** Persist the agent identity learned during onboarding. */
export function saveIdentity(identity: AgentIdentity): void {
  identityStore().register(IDENTITY_KEY, identity);
}

/** Load the persisted bearer, or undefined if the connect token was never exchanged. */
export function loadBearer(): string | undefined {
  return bearerStoreInstance().lookup(BEARER_KEY)?.bearer;
}

/** Persist a bearer obtained from the connect-token exchange. Never logged. */
export function saveBearer(bearer: string): void {
  bearerStoreInstance().register(BEARER_KEY, { bearer, obtainedAt: Date.now() });
}
