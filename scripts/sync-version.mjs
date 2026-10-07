#!/usr/bin/env node
// `npm version` bumps package.json; this copies that version into the two other places the
// plugin reads it from. Runs from the `version` lifecycle script, never by hand.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const replace = (file, pattern, replacement) => {
  const text = readFileSync(file, "utf8");
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`${file}: nothing to replace`);
  writeFileSync(file, next);
};
replace(path.join(root, "openclaw.plugin.json"), /"version":\s*"[^"]+"/, `"version": "${version}"`);
replace(
  path.join(root, "src/version.ts"),
  /export const PLUGIN_VERSION = "[^"]+";/,
  `export const PLUGIN_VERSION = "${version}";`,
);
console.log(`synced ${version}`);
