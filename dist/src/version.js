const PLUGIN_VERSION = "0.1.0";
function isNewerVersion(candidate, installed) {
  const parse = (v) => {
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
export {
  PLUGIN_VERSION,
  isNewerVersion
};
