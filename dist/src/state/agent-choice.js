import { openTable } from "./store.js";
const asked = openTable("choice-asked");
const greetings = openTable("bound-greetings");
function choiceAsked(accountId) {
  return asked.get(accountId) !== void 0;
}
function markChoiceAsked(accountId) {
  asked.set(accountId, Date.now());
}
function leaveGreeting(accountId, from, markdownBody) {
  greetings.set(accountId, { from, body: markdownBody });
}
function dropGreeting(accountId, from) {
  if (greetings.get(accountId)?.from === from) greetings.delete(accountId);
}
function takeGreeting(accountId) {
  return greetings.take(accountId)?.body;
}
export {
  choiceAsked,
  dropGreeting,
  leaveGreeting,
  markChoiceAsked,
  takeGreeting
};
