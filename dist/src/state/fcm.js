import { openTable } from "./store.js";
const registrations = openTable("fcm-registrations");
const received = openTable("fcm-received");
function forgetFcmState(accountId) {
  registrations.delete(accountId);
  received.delete(accountId);
}
export {
  forgetFcmState
};
