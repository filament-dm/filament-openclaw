/**
 * The installed plugin version. `npm version` keeps it equal to `package.json` and
 * `openclaw.plugin.json` (scripts/sync-version.mjs); the update check compares it with `main`.
 */
export const PLUGIN_VERSION = "0.1.0";

/** Dotted numeric compare, missing parts read as 0; anything unparsable is never newer. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const parse = (v: string): number[] | null => {
    const parts = v.trim().replace(/^v/, "").split(".");
    const numbers = parts.map((p) => Number(p));
    return numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null;
  };
  const a = parse(candidate);
  const b = parse(installed);
  if (!a || !b) return false;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
