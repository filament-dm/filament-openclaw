import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PLUGIN_VERSION } from "./version.js";

test("the version is the same in package.json, openclaw.plugin.json and the code", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const plugin = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.version, PLUGIN_VERSION);
  assert.equal(plugin.version, PLUGIN_VERSION);
});

test("npm version keeps them equal: its lifecycle script syncs the other two and rebuilds dist", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.version, /sync-version\.mjs/);
  assert.match(pkg.scripts.version, /npm run build/);
  assert.match(pkg.scripts.version, /git add .*openclaw\.plugin\.json .*src\/version\.ts .*dist/);
});
