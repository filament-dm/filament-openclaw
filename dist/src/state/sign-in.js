import { createHash } from "node:crypto";
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
const revoked = openTable("revoked-bearers");
function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
function loadRevoked(accountId) {
  return revoked.get(accountId);
}
function markRevoked(accountId, token, at = Date.now()) {
  revoked.set(accountId, { fingerprint: tokenFingerprint(token), at });
}
function clearRevoked(accountId) {
  revoked.delete(accountId);
}
export {
  clearRevoked,
  clearSignInEnd,
  loadRevoked,
  loadSignInEnd,
  markRevoked,
  saveSignInEnd,
  tokenFingerprint
};
