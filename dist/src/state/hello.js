import { openTable } from "./store.js";
const hellos = openTable("first-hellos");
function helloSentAs(accountId) {
  return hellos.get(accountId);
}
function markHelloSent(accountId, mxid) {
  hellos.set(accountId, mxid);
}
export {
  helloSentAs,
  markHelloSent
};
