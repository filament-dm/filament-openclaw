import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
const PLUGIN_ID = "filament-fcm";
const CREDENTIALS_NAMESPACE = "fcm";
const CREDENTIALS_KEY = "credentials";
const IDENTITY_NAMESPACE = "identity";
const IDENTITY_KEY = "self";
const RECEIVED_IDS_NAMESPACE = "received-ids";
const RECEIVED_IDS_KEY = "ids";
const RECEIVED_IDS_MAX = 1e3;
let credStore = null;
let idStore = null;
let receivedIdsStore = null;
function credentialStore() {
  if (!credStore) {
    credStore = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace: CREDENTIALS_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new"
    });
  }
  return credStore;
}
function identityStore() {
  if (!idStore) {
    idStore = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace: IDENTITY_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new"
    });
  }
  return idStore;
}
function loadCredentials(projectId) {
  const stored = credentialStore().lookup(CREDENTIALS_KEY);
  if (!stored?.credentials) return void 0;
  if (projectId !== void 0 && stored.project !== projectId) return void 0;
  return stored.credentials;
}
function saveCredentials(creds, projectId) {
  credentialStore().register(CREDENTIALS_KEY, {
    credentials: creds,
    ...projectId !== void 0 ? { project: projectId } : {}
  });
}
function cachedToken(projectId) {
  return loadCredentials(projectId)?.fcm?.token ?? null;
}
function loadIdentity() {
  return identityStore().lookup(IDENTITY_KEY);
}
function saveIdentity(identity) {
  identityStore().register(IDENTITY_KEY, identity);
}
function receivedIds() {
  if (!receivedIdsStore) {
    receivedIdsStore = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace: RECEIVED_IDS_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new"
    });
  }
  return receivedIdsStore;
}
function loadReceivedIds() {
  return receivedIds().lookup(RECEIVED_IDS_KEY) ?? [];
}
function recordReceivedId(id) {
  if (!id) return false;
  const current = loadReceivedIds();
  if (current.includes(id)) return false;
  const next = [...current, id];
  if (next.length > RECEIVED_IDS_MAX) next.splice(0, next.length - RECEIVED_IDS_MAX);
  receivedIds().register(RECEIVED_IDS_KEY, next);
  return true;
}
export {
  cachedToken,
  loadCredentials,
  loadIdentity,
  loadReceivedIds,
  recordReceivedId,
  saveCredentials,
  saveIdentity
};
//# sourceMappingURL=token-store.js.map
