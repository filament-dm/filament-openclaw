import { openTable } from "./store.js";
const owners = openTable("recorded-owners");
function ownerRecordedAt(principal) {
  return owners.get(principal);
}
function markOwnerRecorded(principal, at = Date.now()) {
  owners.set(principal, at);
}
export {
  markOwnerRecorded,
  ownerRecordedAt
};
