import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
const PLUGIN_ID = "filament-fcm";
const IDENTITY_NAMESPACE = "identity";
const IDENTITY_KEY = "self";
const BEARER_NAMESPACE = "bearer";
const BEARER_KEY = "current";
let idStore = null;
let bearerStore = null;
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
function bearerStoreInstance() {
  if (!bearerStore) {
    bearerStore = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace: BEARER_NAMESPACE,
      maxEntries: 4,
      overflowPolicy: "reject-new"
    });
  }
  return bearerStore;
}
function loadIdentity() {
  return identityStore().lookup(IDENTITY_KEY);
}
function saveIdentity(identity) {
  identityStore().register(IDENTITY_KEY, identity);
}
function loadBearer() {
  return bearerStoreInstance().lookup(BEARER_KEY)?.bearer;
}
function saveBearer(bearer) {
  bearerStoreInstance().register(BEARER_KEY, { bearer, obtainedAt: Date.now() });
}
export {
  loadBearer,
  loadIdentity,
  saveBearer,
  saveIdentity
};
//# sourceMappingURL=token-store.js.map
