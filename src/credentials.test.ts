import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveBearer } from "./credentials.js";

function memoryPersistence(initial?: Record<string, string>) {
  const stored = new Map<string, string>(Object.entries(initial ?? {}));
  return (connectToken: string) => stored.get(connectToken);
}

test("resolveBearer: with nothing persisted, the connect token is the bearer", () => {
  assert.equal(
    resolveBearer("fmcp_sometoken", () => {}, memoryPersistence()),
    "fmcp_sometoken",
  );
});

test("resolveBearer: a bearer persisted under this connect token wins over the token", () => {
  const bearer = resolveBearer(
    "fmcp_sometoken",
    () => {},
    memoryPersistence({ fmcp_sometoken: "persisted-bearer" }),
  );
  assert.equal(bearer, "persisted-bearer");
});

test("resolveBearer: a different connect token never reuses another token's bearer", () => {
  const load = memoryPersistence({ fmcp_tokenOne: "bearer-for-token-one" });
  assert.equal(
    resolveBearer("fmcp_tokenTwo", () => {}, load),
    "fmcp_tokenTwo",
  );
  assert.equal(
    resolveBearer("fmcp_tokenOne", () => {}, load),
    "bearer-for-token-one",
  );
});
