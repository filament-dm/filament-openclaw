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

import type { UpdateCheckState } from "./update-check.js";

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
const GREETING_NAMESPACE = "bound-greetings";
const UPDATE_STATE_NAMESPACE = "update-state";
const UPDATE_REQUEST_NAMESPACE = "update-requests";
const UPDATE_STATE_KEY = "gateway";

// Structural: the store's runtime module is only present inside the gateway.
type SyncStore<T> = {
  lookup(key: string): T | undefined;
  register(key: string, value: T): void;
};

// Tagged with the account that left it, so a losing bind clears only its own.
interface StoredGreeting {
  from: string;
  body: string;
}

const stores = new Map<string, SyncStore<unknown>>();

/** One store per namespace, opened on first use and kept for the life of the module. */
function store<T>(namespace: string, maxEntries = 32): SyncStore<T> {
  let instance = stores.get(namespace);
  if (!instance) {
    instance = createPluginStateSyncKeyedStore<T>(PLUGIN_ID, {
      namespace,
      maxEntries,
      overflowPolicy: "evict-oldest",
    }) as SyncStore<unknown>;
    stores.set(namespace, instance);
  }
  return instance as SyncStore<T>;
}

const fcmStoreInstance = () => store<StoredFcm>(FCM_NAMESPACE);
const receivedStoreInstance = () => store<string[]>(RECEIVED_IDS_NAMESPACE);
const choiceAskedStoreInstance = () => store<number>(CHOICE_ASKED_NAMESPACE);
const greetingStoreInstance = () => store<StoredGreeting>(GREETING_NAMESPACE);
const updateStateStoreInstance = () => store<UpdateCheckState>(UPDATE_STATE_NAMESPACE, 4);
const updateRequestStoreInstance = () => store<{ fromVersion: string }>(UPDATE_REQUEST_NAMESPACE);
const identityStore = () => store<AgentIdentity>(IDENTITY_NAMESPACE);
// Read only, but the options must not change: see FCM_NAMESPACE.
const bearerStoreInstance = () => store<StoredBearer>(BEARER_NAMESPACE, 16);

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
export function choiceAsked(accountId: string): boolean {
  return choiceAskedStoreInstance().lookup(accountId) !== undefined;
}

/** Record that the question was put to the principal. Call it after the send succeeded. */
export function markChoiceAsked(accountId: string): void {
  choiceAskedStoreInstance().register(accountId, Date.now());
}

/**
 * What the account bound from a pending one says when it first connects. The pending account
 * cannot say it: the reload that applies its choice replaces it.
 */
export function leaveGreeting(accountId: string, from: string, markdownBody: string): void {
  greetingStoreInstance().register(accountId, { from, body: markdownBody });
}

/** Clears the greeting only if `from` left it: another account's successful bind keeps its own. */
export function dropGreeting(accountId: string, from: string): void {
  if (greetingStoreInstance().lookup(accountId)?.from === from) {
    greetingStoreInstance().register(accountId, { from, body: "" });
  }
}

/** The greeting left for this account, cleared on read so a later reload does not repeat it. */
export function takeGreeting(accountId: string): string | undefined {
  const stored = greetingStoreInstance().lookup(accountId);
  if (!stored?.body) return undefined;
  greetingStoreInstance().register(accountId, { from: stored.from, body: "" });
  return stored.body;
}

/** Shared by every account on the gateway: when the version was last checked and which was announced. */
export function loadUpdateState(): UpdateCheckState {
  return updateStateStoreInstance().lookup(UPDATE_STATE_KEY) ?? {};
}

export function saveUpdateState(state: UpdateCheckState): void {
  updateStateStoreInstance().register(UPDATE_STATE_KEY, state);
}

/** Left by the account that ran the update, read back by the same account after the reload. */
export function markUpdateRequested(accountId: string, fromVersion: string): void {
  updateRequestStoreInstance().register(accountId, { fromVersion });
}

export function takeUpdateRequest(accountId: string): { fromVersion: string } | undefined {
  const stored = updateRequestStoreInstance().lookup(accountId);
  if (!stored?.fromVersion) return undefined;
  updateRequestStoreInstance().register(accountId, { fromVersion: "" });
  return stored;
}
