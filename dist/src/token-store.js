import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
const PLUGIN_ID = "filament-openclaw";
const FCM_NAMESPACE = "fcm-registrations";
const RECEIVED_IDS_NAMESPACE = "fcm-received";
const RECEIVED_IDS_MAX = 1e3;
const IDENTITY_NAMESPACE = "identities";
const BEARER_NAMESPACE = "bearers";
const CHOICE_ASKED_NAMESPACE = "choice-asked";
const GREETING_NAMESPACE = "bound-greetings";
const UPDATE_STATE_NAMESPACE = "update-state";
const UPDATE_REQUEST_NAMESPACE = "update-requests";
const UPDATE_STATE_KEY = "gateway";
const stores = /* @__PURE__ */ new Map();
function store(namespace, maxEntries = 32) {
  let instance = stores.get(namespace);
  if (!instance) {
    instance = createPluginStateSyncKeyedStore(PLUGIN_ID, {
      namespace,
      maxEntries,
      overflowPolicy: "evict-oldest"
    });
    stores.set(namespace, instance);
  }
  return instance;
}
const fcmStoreInstance = () => store(FCM_NAMESPACE);
const receivedStoreInstance = () => store(RECEIVED_IDS_NAMESPACE);
const choiceAskedStoreInstance = () => store(CHOICE_ASKED_NAMESPACE);
const greetingStoreInstance = () => store(GREETING_NAMESPACE);
const updateStateStoreInstance = () => store(UPDATE_STATE_NAMESPACE, 4);
const updateRequestStoreInstance = () => store(UPDATE_REQUEST_NAMESPACE);
const identityStore = () => store(IDENTITY_NAMESPACE);
const bearerStoreInstance = () => store(BEARER_NAMESPACE, 16);
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
function choiceAsked(accountId) {
  return choiceAskedStoreInstance().lookup(accountId) !== void 0;
}
function markChoiceAsked(accountId) {
  choiceAskedStoreInstance().register(accountId, Date.now());
}
function leaveGreeting(accountId, from, markdownBody) {
  greetingStoreInstance().register(accountId, { from, body: markdownBody });
}
function dropGreeting(accountId, from) {
  if (greetingStoreInstance().lookup(accountId)?.from === from) {
    greetingStoreInstance().register(accountId, { from, body: "" });
  }
}
function takeGreeting(accountId) {
  const stored = greetingStoreInstance().lookup(accountId);
  if (!stored?.body) return void 0;
  greetingStoreInstance().register(accountId, { from: stored.from, body: "" });
  return stored.body;
}
function loadUpdateState() {
  return updateStateStoreInstance().lookup(UPDATE_STATE_KEY) ?? {};
}
function saveUpdateState(state) {
  updateStateStoreInstance().register(UPDATE_STATE_KEY, state);
}
function markUpdateRequested(accountId, fromVersion) {
  updateRequestStoreInstance().register(accountId, { fromVersion });
}
function takeUpdateRequest(accountId) {
  const stored = updateRequestStoreInstance().lookup(accountId);
  if (!stored?.fromVersion) return void 0;
  updateRequestStoreInstance().register(accountId, { fromVersion: "" });
  return stored;
}
export {
  choiceAsked,
  dropGreeting,
  hasFcmCredentialsForOtherProject,
  leaveGreeting,
  loadBearer,
  loadFcmCredentials,
  loadIdentity,
  loadReceivedIds,
  loadUpdateState,
  markChoiceAsked,
  markUpdateRequested,
  recordReceivedId,
  saveFcmCredentials,
  saveIdentity,
  saveUpdateState,
  takeGreeting,
  takeUpdateRequest
};
