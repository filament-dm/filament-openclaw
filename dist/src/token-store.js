import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
const PLUGIN_ID = "filament-fcm";
const IDENTITY_NAMESPACE = "identities";
const BEARER_NAMESPACE = "bearers";
let idStore = null;
let bearerStore = null;
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
export {
  loadBearer,
  loadIdentity,
  saveBearer,
  saveIdentity
};
//# sourceMappingURL=token-store.js.map
