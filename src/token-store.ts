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
 * The bearer is keyed by the *configured connect token*, not by a single
 * fixed key: `loadBearer`/`saveBearer` derive the store key from a truncated
 * sha256 of the connect token (the token itself is never stored or logged).
 * That way, swapping `plugins.entries.filament-fcm.config.connectToken` to a
 * new `fmcp_…` token always misses the store and triggers a fresh exchange,
 * instead of silently reusing a bearer — and thus the identity — left behind
 * by a previous token.
 *
 * The poll cursor is deliberately NOT persisted here: it is kept in memory
 * only (see src/poll-work.ts). A restart without a cursor re-scans from the
 * beginning of the agent's unread work, which is safe (poll_work is
 * idempotent per event: already-answered items are skipped by the server's
 * work ledger, and unanswered ones are simply redelivered) — see
 * ROADMAP.md for the tradeoff.
 */
import { createHash } from "node:crypto";

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
// "bearers" (plural), not the pre-rotation "bearer": the gateway keeps a keyed
// store's options for the life of the process, and reopening a namespace with
// different maxEntries/overflowPolicy throws PluginStateStoreError on a hot
// reload. A fresh namespace also leaves the legacy global `bearer/current`
// entry behind by construction.
const BEARER_NAMESPACE = "bearers";
// Pre-migration installs stored the bearer under the fixed key "current"
// (one bearer, no notion of which connect token produced it). That entry is
// never looked up by the per-token key below, so it's harmlessly orphaned
// rather than reused for a new token.

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
      // Keyed per connect token now (see module header), so more than one
      // entry is the normal case across a token rotation, not an anomaly —
      // evict the oldest rather than rejecting a legitimate new exchange.
      maxEntries: 16,
      overflowPolicy: "evict-oldest",
    }) as SyncStore<StoredBearer>;
  }
  return bearerStore;
}

/**
 * Derive the store key for a connect token: the first 16 hex characters of
 * its sha256 digest. Never store or log the token itself.
 */
function bearerKey(connectToken: string): string {
  return createHash("sha256").update(connectToken).digest("hex").slice(0, 16);
}

/** Load the onboarded agent identity, or undefined if not onboarded yet. */
export function loadIdentity(): AgentIdentity | undefined {
  return identityStore().lookup(IDENTITY_KEY);
}

/** Persist the agent identity learned during onboarding. */
export function saveIdentity(identity: AgentIdentity): void {
  identityStore().register(IDENTITY_KEY, identity);
}

/**
 * Load the bearer persisted for this connect token, or undefined if it was
 * never exchanged (or was exchanged for a different token).
 */
export function loadBearer(connectToken: string): string | undefined {
  return bearerStoreInstance().lookup(bearerKey(connectToken))?.bearer;
}

/**
 * Persist a bearer obtained from exchanging this connect token. Never logs
 * the token or the bearer.
 */
export function saveBearer(connectToken: string, bearer: string): void {
  bearerStoreInstance().register(bearerKey(connectToken), { bearer, obtainedAt: Date.now() });
}
