import { openTable } from "./store.js";
const identities = openTable("identities");
function loadIdentity(accountId) {
  return identities.get(accountId);
}
function saveIdentity(accountId, identity) {
  identities.set(accountId, identity);
}
export {
  loadIdentity,
  saveIdentity
};
