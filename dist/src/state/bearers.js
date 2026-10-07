import { createHash } from "node:crypto";
import { openTable } from "./store.js";
const bearers = openTable("bearers", 16);
function bearerKey(connectToken) {
  return createHash("sha256").update(connectToken).digest("hex").slice(0, 16);
}
function loadBearer(connectToken) {
  return bearers.get(bearerKey(connectToken))?.bearer;
}
export {
  loadBearer
};
