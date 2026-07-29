import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
const PLUGIN_ID = "filament-fcm";
const CREDENTIALS_NAMESPACE = "fcm";
const CREDENTIALS_KEY = "credentials";
const IDENTITY_NAMESPACE = "identity";
const IDENTITY_KEY = "self";
let credStore = null;
let idStore = null;
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
function loadCredentials() {
  return credentialStore().lookup(CREDENTIALS_KEY);
}
function saveCredentials(creds) {
  credentialStore().register(CREDENTIALS_KEY, creds);
}
function cachedToken() {
  return loadCredentials()?.fcm?.token ?? null;
}
function loadIdentity() {
  return identityStore().lookup(IDENTITY_KEY);
}
function saveIdentity(identity) {
  identityStore().register(IDENTITY_KEY, identity);
}
export {
  cachedToken,
  loadCredentials,
  loadIdentity,
  saveCredentials,
  saveIdentity
};
//# sourceMappingURL=token-store.js.map
