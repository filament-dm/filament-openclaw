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

// Structural view of the sync keyed store — avoids depending on the store's
// exported type name (the runtime module is only present inside the gateway).
type SyncStore<T> = {
  lookup(key: string): T | undefined;
  register(key: string, value: T): void;
};

let credStore: SyncStore<FcmCredentials> | null = null;
let idStore: SyncStore<AgentIdentity> | null = null;

function credentialStore(): SyncStore<FcmCredentials> {
  if (!credStore) {
    credStore = createPluginStateSyncKeyedStore<FcmCredentials>(PLUGIN_ID, {
      namespace: CREDENTIALS_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new",
    }) as SyncStore<FcmCredentials>;
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

/** Load saved FCM credentials, or undefined on first run. */
export function loadCredentials(): FcmCredentials | undefined {
  return credentialStore().lookup(CREDENTIALS_KEY);
}

/** Persist FCM credentials (called whenever eneris regenerates them). */
export function saveCredentials(creds: FcmCredentials): void {
  credentialStore().register(CREDENTIALS_KEY, creds);
}

/** The cached FCM registration token, or null when none is stored. */
export function cachedToken(): string | null {
  return loadCredentials()?.fcm?.token ?? null;
}

/** Load the onboarded agent identity, or undefined if not onboarded yet. */
export function loadIdentity(): AgentIdentity | undefined {
  return identityStore().lookup(IDENTITY_KEY);
}

/** Persist the agent identity learned during onboarding. */
export function saveIdentity(identity: AgentIdentity): void {
  identityStore().register(IDENTITY_KEY, identity);
}
