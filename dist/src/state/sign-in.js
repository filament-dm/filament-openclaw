import { openTable } from "./store.js";
const ends = openTable("sign-in-ends");
function loadSignInEnd(accountId) {
  return ends.get(accountId);
}
function saveSignInEnd(accountId, end) {
  ends.set(accountId, end);
}
function clearSignInEnd(accountId) {
  ends.delete(accountId);
}
export {
  clearSignInEnd,
  loadSignInEnd,
  saveSignInEnd
};
