import { openTable } from "./store.js";
const names = openTable("followed-names");
function followedName(accountId) {
  return names.get(accountId);
}
function recordFollowedName(accountId, followed) {
  names.set(accountId, followed);
}
export {
  followedName,
  recordFollowedName
};
