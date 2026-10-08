import { openTable } from "./store.js";
const checks = openTable("update-state", 4);
const requests = openTable("update-requests");
const GATEWAY = "gateway";
function loadUpdateState() {
  return checks.get(GATEWAY) ?? {};
}
function saveUpdateState(state) {
  checks.set(GATEWAY, state);
}
function markUpdateRequested(accountId, fromVersion) {
  requests.set(accountId, { fromVersion });
}
function takeUpdateRequest(accountId) {
  return requests.take(accountId);
}
export {
  loadUpdateState,
  markUpdateRequested,
  saveUpdateState,
  takeUpdateRequest
};
