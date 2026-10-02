/**
 * Plugin state in OpenClaw's keyed store, per channel account: the `get_self` identity, the FCM
 * registration (so a restart keeps the push token), processed push ids (so Google does not
 * redeliver them) and whether a pending account already asked which agent to be.
 *
 * Bearers are read only, keyed by a hash of the connect token they were exchanged for, so a new
 * token never reuses an old token's bearer or identity. Nothing writes new ones.
 */
import { createHash } from "node:crypto";

import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";

export interface AgentIdentity {
  mxid: string;
  principal: string;
  /** The command-and-control (backchannel) room. */
  ccRoomId?: string;
  onboardedAt: number;
}

export interface StoredBearer {
  bearer: string;
  obtainedAt: number;
}

/** eneris `Credentials`, persisted opaquely. */
export interface FcmCredentials {
  fcm?: { token?: string };
  [key: string]: unknown;
}

// Tagged with its Firebase project: after a project change the old token can never be delivered
// to, so the account must re-register.
interface StoredFcm {
  project: string;
  credentials: FcmCredentials;
}

const PLUGIN_ID = "filament-openclaw";
// Reopening a namespace with different store options throws on a hot reload, so a namespace's
// options never change; new options need a new namespace.
const FCM_NAMESPACE = "fcm-registrations";
const RECEIVED_IDS_NAMESPACE = "fcm-received";
// Bounded because the list is also sent in the MCS login payload.
const RECEIVED_IDS_MAX = 1_000;
const IDENTITY_NAMESPACE = "identities";
const BEARER_NAMESPACE = "bearers";
const CHOICE_ASKED_NAMESPACE = "choice-asked";

// Structural: the store's runtime module is only present inside the gateway.
type SyncStore<T> = {
  lookup(key: string): T | undefined;
  register(key: string, value: T): void;
};

let idStore: SyncStore<AgentIdentity> | null = null;
let bearerStore: SyncStore<StoredBearer> | null = null;
let fcmStore: SyncStore<StoredFcm> | null = null;
let receivedStore: SyncStore<string[]> | null = null;
let choiceAskedStore: SyncStore<number> | null = null;

function fcmStoreInstance(): SyncStore<StoredFcm> {
  if (!fcmStore) {
    fcmStore = createPluginStateSyncKeyedStore<StoredFcm>(PLUGIN_ID, {
      namespace: FCM_NAMESPACE,
      maxEntries: 32,
      overflowPolicy: "evict-oldest",
    }) as SyncStore<StoredFcm>;
  }
  return fcmStore;
}

function receivedStoreInstance(): SyncStore<string[]> {
  if (!receivedStore) {
    receivedStore = createPluginStateSyncKeyedStore<string[]>(PLUGIN_ID, {
      namespace: RECEIVED_IDS_NAMESPACE,
      maxEntries: 32,
      overflowPolicy: "evict-oldest",
    }) as SyncStore<string[]>;
  }
  return receivedStore;
}

function choiceAskedStoreInstance(): SyncStore<number> {
  if (!choiceAskedStore) {
    choiceAskedStore = createPluginStateSyncKeyedStore<number>(PLUGIN_ID, {
      namespace: CHOICE_ASKED_NAMESPACE,
      maxEntries: 32,
      overflowPolicy: "evict-oldest",
    }) as SyncStore<number>;
  }
  return choiceAskedStore;
}

function identityStore(): SyncStore<AgentIdentity> {
  if (!idStore) {
    idStore = createPluginStateSyncKeyedStore<AgentIdentity>(PLUGIN_ID, {
      namespace: IDENTITY_NAMESPACE,
      maxEntries: 32,
      overflowPolicy: "evict-oldest",
    }) as SyncStore<AgentIdentity>;
  }
  return idStore;
}

function bearerStoreInstance(): SyncStore<StoredBearer> {
  if (!bearerStore) {
    bearerStore = createPluginStateSyncKeyedStore<StoredBearer>(PLUGIN_ID, {
      namespace: BEARER_NAMESPACE,
      // Read only, but the options must not change: see FCM_NAMESPACE.
      maxEntries: 16,
      overflowPolicy: "evict-oldest",
    }) as SyncStore<StoredBearer>;
  }
  return bearerStore;
}

/** Never store or log the connect token itself. */
function bearerKey(connectToken: string): string {
  return createHash("sha256").update(connectToken).digest("hex").slice(0, 16);
}

export function loadIdentity(accountId: string): AgentIdentity | undefined {
  return identityStore().lookup(accountId);
}

export function saveIdentity(accountId: string, identity: AgentIdentity): void {
  identityStore().register(accountId, identity);
}

export function loadBearer(connectToken: string): string | undefined {
  return bearerStoreInstance().lookup(bearerKey(connectToken))?.bearer;
}

export function loadFcmCredentials(
  accountId: string,
  projectId: string,
): FcmCredentials | undefined {
  const stored = fcmStoreInstance().lookup(accountId);
  return stored && stored.project === projectId ? stored.credentials : undefined;
}

export function hasFcmCredentialsForOtherProject(accountId: string, projectId: string): boolean {
  const stored = fcmStoreInstance().lookup(accountId);
  return stored !== undefined && stored.project !== projectId;
}

export function saveFcmCredentials(
  accountId: string,
  credentials: FcmCredentials,
  projectId: string,
): void {
  fcmStoreInstance().register(accountId, { project: projectId, credentials });
}

export function loadReceivedIds(accountId: string): string[] {
  return receivedStoreInstance().lookup(accountId) ?? [];
}

/** False when the id was already recorded (a redelivery). */
export function recordReceivedId(accountId: string, id: string): boolean {
  if (!id) return false;
  const current = loadReceivedIds(accountId);
  if (current.includes(id)) return false;
  const next = [...current, id];
  if (next.length > RECEIVED_IDS_MAX) next.splice(0, next.length - RECEIVED_IDS_MAX);
  receivedStoreInstance().register(accountId, next);
  return true;
}

/** False when this pending account already asked; a config reload must not ask again. */
export function markChoiceAsked(accountId: string): boolean {
  if (choiceAskedStoreInstance().lookup(accountId) !== undefined) return false;
  choiceAskedStoreInstance().register(accountId, Date.now());
  return true;
}
