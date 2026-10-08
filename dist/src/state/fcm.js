import { openTable } from "./store.js";
const registrations = openTable("fcm-registrations");
const received = openTable("fcm-received");
const RECEIVED_IDS_MAX = 1e3;
function loadFcmCredentials(accountId, projectId) {
  const stored = registrations.get(accountId);
  return stored && stored.project === projectId ? stored.credentials : void 0;
}
function hasFcmCredentialsForOtherProject(accountId, projectId) {
  const stored = registrations.get(accountId);
  return stored !== void 0 && stored.project !== projectId;
}
function saveFcmCredentials(accountId, credentials, projectId) {
  registrations.set(accountId, { project: projectId, credentials });
}
function loadReceivedIds(accountId) {
  return received.get(accountId) ?? [];
}
function recordReceivedId(accountId, id) {
  if (!id) return false;
  const current = loadReceivedIds(accountId);
  if (current.includes(id)) return false;
  const next = [...current, id];
  if (next.length > RECEIVED_IDS_MAX) next.splice(0, next.length - RECEIVED_IDS_MAX);
  received.set(accountId, next);
  return true;
}
export {
  hasFcmCredentialsForOtherProject,
  loadFcmCredentials,
  loadReceivedIds,
  recordReceivedId,
  saveFcmCredentials
};
