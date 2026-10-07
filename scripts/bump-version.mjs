#!/usr/bin/env node
// Bumps the plugin version in the three places that must agree: package.json,
// openclaw.plugin.json and src/version.ts. Usage: bump-version.mjs <patch|minor|major|x.y.z>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  pkg: path.join(root, "package.json"),
  plugin: path.join(root, "openclaw.plugin.json"),
  source: path.join(root, "src/version.ts"),
};

const pkg = JSON.parse(readFileSync(files.pkg, "utf8"));
const current = pkg.version;
const level = process.argv[2];
if (!level) {
  console.error("usage: bump-version.mjs <patch|minor|major|x.y.z>");
  process.exit(2);
}

const next = /^\d+\.\d+\.\d+$/.test(level) ? level : bump(current, level);

function bump(version, kind) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  console.error(`unknown level: ${kind}`);
  process.exit(2);
}

function rewriteJson(file) {
  const text = readFileSync(file, "utf8");
  const updated = text.replace(/"version":\s*"[^"]+"/, `"version": "${next}"`);
  if (updated === text) throw new Error(`no version field in ${file}`);
  writeFileSync(file, updated);
}

rewriteJson(files.pkg);
rewriteJson(files.plugin);
const source = readFileSync(files.source, "utf8");
const updatedSource = source.replace(
  /export const PLUGIN_VERSION = "[^"]+";/,
  `export const PLUGIN_VERSION = "${next}";`,
);
if (updatedSource === source) throw new Error(`no PLUGIN_VERSION in ${files.source}`);
writeFileSync(files.source, updatedSource);
console.log(`${current} -> ${next}`);
