import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
const PLUGIN_ID = "filament-fcm";
const FCM_NAMESPACE = "fcm-registrations";
const RECEIVED_IDS_NAMESPACE = "fcm-received";
const RECEIVED_IDS_MAX = 1e3;
const IDENTITY_NAMESPACE = "identities";
const BEARER_NAMESPACE = "bearers";
let idStore = null;
let bearerStore = null;
let fcmStore = null;
let receivedStore = null;
function fcmStoreInstance() {
  if (!fcmStore) {
    fcmStore = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace: FCM_NAMESPACE,
      maxEntries: 32,
      overflowPolicy: "evict-oldest"
    });
  }
  return fcmStore;
}
function receivedStoreInstance() {
  if (!receivedStore) {
    receivedStore = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace: RECEIVED_IDS_NAMESPACE,
      maxEntries: 32,
      overflowPolicy: "evict-oldest"
    });
  }
  return receivedStore;
}
function identityStore() {
  if (!idStore) {
    idStore = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace: IDENTITY_NAMESPACE,
      maxEntries: 32,
      overflowPolicy: "evict-oldest"
    });
  }
  return idStore;
}
function bearerStoreInstance() {
  if (!bearerStore) {
    bearerStore = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace: BEARER_NAMESPACE,
      // Keyed per connect token now (see module header), so more than one
      // entry is the normal case across a token rotation, not an anomaly —
      // evict the oldest rather than rejecting a legitimate new exchange.
      maxEntries: 16,
      overflowPolicy: "evict-oldest"
    });
  }
  return bearerStore;
}
function bearerKey(connectToken) {
  return createHash("sha256").update(connectToken).digest("hex").slice(0, 16);
}
function loadIdentity(accountId) {
  return identityStore().lookup(accountId);
}
function saveIdentity(accountId, identity) {
  identityStore().register(accountId, identity);
}
function loadBearer(connectToken) {
  return bearerStoreInstance().lookup(bearerKey(connectToken))?.bearer;
}
function saveBearer(connectToken, bearer) {
  bearerStoreInstance().register(bearerKey(connectToken), { bearer, obtainedAt: Date.now() });
}
function loadFcmCredentials(accountId, projectId) {
  const stored = fcmStoreInstance().lookup(accountId);
  return stored && stored.project === projectId ? stored.credentials : void 0;
}
function hasFcmCredentialsForOtherProject(accountId, projectId) {
  const stored = fcmStoreInstance().lookup(accountId);
  return stored !== void 0 && stored.project !== projectId;
}
function saveFcmCredentials(accountId, credentials, projectId) {
  fcmStoreInstance().register(accountId, { project: projectId, credentials });
}
function loadReceivedIds(accountId) {
  return receivedStoreInstance().lookup(accountId) ?? [];
}
function recordReceivedId(accountId, id) {
  if (!id) return false;
  const current = loadReceivedIds(accountId);
  if (current.includes(id)) return false;
  const next = [...current, id];
  if (next.length > RECEIVED_IDS_MAX) next.splice(0, next.length - RECEIVED_IDS_MAX);
  receivedStoreInstance().register(accountId, next);
  return true;
}
export {
  hasFcmCredentialsForOtherProject,
  loadBearer,
  loadFcmCredentials,
  loadIdentity,
  loadReceivedIds,
  recordReceivedId,
  saveBearer,
  saveFcmCredentials,
  saveIdentity
};
//# sourceMappingURL=token-store.js.map
