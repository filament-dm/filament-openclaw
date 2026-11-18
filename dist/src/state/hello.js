import { openTable } from "./store.js";
const hellos = openTable("first-hellos");
function helloSentAs(accountId) {
  return hellos.get(accountId);
}
function markHelloSent(accountId, mxid) {
  hellos.set(accountId, mxid);
}
const lookAroundsDue = openTable("look-arounds-due");
function markLookAroundDue(accountId, mxid) {
  lookAroundsDue.set(accountId, mxid);
}
function lookAroundDueFor(accountId) {
  return lookAroundsDue.get(accountId);
}
function takeLookAroundDue(accountId) {
  return lookAroundsDue.take(accountId);
}
export {
  helloSentAs,
  lookAroundDueFor,
  markHelloSent,
  markLookAroundDue,
  takeLookAroundDue
};
