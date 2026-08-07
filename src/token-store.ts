/**
 * Persistent storage for FCM registration credentials, backed by OpenClaw's
 * plugin-state keyed store (SQLite at ~/.openclaw/plugin-state.sqlite). This
 * replaces the JSON files the Python plugin wrote under ~/.hermes/filament-fcm/.
 *
 * We store the whole eneris `Credentials` object (which carries `fcm.token`)
 * under a single key, so a restart reuses the saved registration instead of
 * re-registering with Google.
 */
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";

/** Subset of the eneris Credentials shape we rely on. */
export interface FcmCredentials {
  fcm?: { token?: string };
  [key: string]: unknown;
}

/**
 * Credentials as persisted, tagged with the Firebase project they were
 * registered against. The tag lets us invalidate a cached token when the
 * configured project changes (e.g. prod `filament-8ce44` → dev
 * `filament-dev-f2f90`) — otherwise we'd hand Filament a token the server's
 * DirectPusher (bound to the new project) can never deliver to.
 */
interface StoredFcm {
  project?: string;
  credentials: FcmCredentials;
}

/** The agent identity learned from Filament during onboarding (get_self). */
export interface AgentIdentity {
  mxid: string;
  /** The principal (owner) mxid that controls this agent. */
  principal: string;
  /** The command-and-control backchannel room id, when present. */
  ccRoomId?: string;
  onboardedAt: number;
}

const PLUGIN_ID = "filament-fcm";
const CREDENTIALS_NAMESPACE = "fcm";
const CREDENTIALS_KEY = "credentials";
const IDENTITY_NAMESPACE = "identity";
const IDENTITY_KEY = "self";
const RECEIVED_IDS_NAMESPACE = "received-ids";
const RECEIVED_IDS_KEY = "ids";
// Bounded window of processed FCM persistent IDs, kept small enough that the
// persisted list and the MCS login payload don't grow unbounded (mirrors the
// Python plugin's 1000-entry cap).
const RECEIVED_IDS_MAX = 1_000;

// Structural view of the sync keyed store — avoids depending on the store's
// exported type name (the runtime module is only present inside the gateway).
type SyncStore<T> = {
  lookup(key: string): T | undefined;
  register(key: string, value: T): void;
};

let credStore: SyncStore<StoredFcm> | null = null;
let idStore: SyncStore<AgentIdentity> | null = null;
let receivedIdsStore: SyncStore<string[]> | null = null;

function credentialStore(): SyncStore<StoredFcm> {
  if (!credStore) {
    credStore = createPluginStateSyncKeyedStore<StoredFcm>(PLUGIN_ID, {
      namespace: CREDENTIALS_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new",
    }) as SyncStore<StoredFcm>;
  }
  return credStore;
}

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

/**
 * Load saved FCM credentials, or undefined on first run. When `projectId` is
 * given, credentials tagged with a *different* project are treated as absent so
 * the caller re-registers fresh against the configured project (old untagged
 * records are also discarded, forcing a one-time re-register after upgrade).
 */
export function loadCredentials(projectId?: string): FcmCredentials | undefined {
  const stored = credentialStore().lookup(CREDENTIALS_KEY);
  if (!stored?.credentials) return undefined;
  if (projectId !== undefined && stored.project !== projectId) return undefined;
  return stored.credentials;
}

/** Persist FCM credentials, tagged with the project they belong to. */
export function saveCredentials(creds: FcmCredentials, projectId?: string): void {
  credentialStore().register(CREDENTIALS_KEY, {
    credentials: creds,
    ...(projectId !== undefined ? { project: projectId } : {}),
  });
}

/**
 * The cached FCM registration token, or null when none is stored (or it belongs
 * to a different project than `projectId`, when provided).
 */
export function cachedToken(projectId?: string): string | null {
  return loadCredentials(projectId)?.fcm?.token ?? null;
}

/** Load the onboarded agent identity, or undefined if not onboarded yet. */
export function loadIdentity(): AgentIdentity | undefined {
  return identityStore().lookup(IDENTITY_KEY);
}

/** Persist the agent identity learned during onboarding. */
export function saveIdentity(identity: AgentIdentity): void {
  identityStore().register(IDENTITY_KEY, identity);
}

function receivedIds(): SyncStore<string[]> {
  if (!receivedIdsStore) {
    receivedIdsStore = createPluginStateSyncKeyedStore<string[]>(PLUGIN_ID, {
      namespace: RECEIVED_IDS_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new",
    }) as SyncStore<string[]>;
  }
  return receivedIdsStore;
}

/**
 * The processed FCM persistent IDs, most-recent last. Seeded into the receiver
 * on start so Google does not redeliver already-handled pushes across restarts.
 */
export function loadReceivedIds(): string[] {
  return receivedIds().lookup(RECEIVED_IDS_KEY) ?? [];
}

/**
 * Record a persistent ID as processed. Returns false if it was already present
 * (a duplicate/redelivery), true if newly recorded. Keeps a bounded window.
 */
export function recordReceivedId(id: string): boolean {
  if (!id) return false;
  const current = loadReceivedIds();
  if (current.includes(id)) return false;
  const next = [...current, id];
  if (next.length > RECEIVED_IDS_MAX) next.splice(0, next.length - RECEIVED_IDS_MAX);
  receivedIds().register(RECEIVED_IDS_KEY, next);
  return true;
}
