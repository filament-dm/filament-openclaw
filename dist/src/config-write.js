import { execFile } from "node:child_process";
import { asRecord, PLUGIN_ID } from "./accounts.js";
const PLUGIN_CONFIG_PATH = `plugins.entries.${PLUGIN_ID}.config`;
function openclawCliArgv(argv = process.argv, execPath = process.execPath) {
  const entry = argv[1];
  return entry && /[\\/]openclaw[\\/]/.test(entry) ? [execPath, entry] : ["openclaw"];
}
const runOpenclawCli = (args, stdin) => new Promise((resolve) => {
  const [command, ...prefix] = openclawCliArgv();
  const child = execFile(
    command,
    [...prefix, ...args],
    { env: process.env, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      const code = error && "code" in error && typeof error.code === "number" ? error.code : null;
      resolve({ code: error ? code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    }
  );
  if (stdin !== void 0) child.stdin?.end(stdin);
  else child.stdin?.end();
});
function configPatch(before, after) {
  if (isPlainObject(before) && isPlainObject(after)) {
    const patch = {};
    for (const key of /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) {
        patch[key] = null;
        continue;
      }
      const child = key in before ? configPatch(before[key], after[key]) : after[key];
      if (child !== void 0) patch[key] = child;
    }
    return Object.keys(patch).length > 0 ? patch : void 0;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? void 0 : after;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isUnsetPath(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.ok === false && /valid but unset/.test(String(parsed.error?.message ?? ""));
  } catch {
    return false;
  }
}
function parseJson(label, result) {
  const text = result.stdout.trim();
  if (result.code !== 0) {
    if (isUnsetPath(text)) return void 0;
    throw new Error(
      `openclaw config get ${label} failed (exit ${result.code}): ${(result.stderr || text).trim()}`
    );
  }
  if (!text || text === "undefined" || text === "null") return void 0;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`openclaw config get ${label} returned something that is not JSON`);
  }
}
let writeQueue = Promise.resolve();
function writeGatewayConfig(mutate, run = runOpenclawCli) {
  const next = writeQueue.then(() => writeGatewayConfigNow(mutate, run));
  writeQueue = next.catch(() => {
  });
  return next;
}
async function writeGatewayConfigNow(mutate, run) {
  const [pluginConfig, bindings] = await Promise.all([
    run(["config", "get", PLUGIN_CONFIG_PATH, "--json"]).then(
      (r) => parseJson(PLUGIN_CONFIG_PATH, r)
    ),
    run(["config", "get", "bindings", "--json"]).then((r) => parseJson("bindings", r))
  ]);
  const before = {
    plugins: { entries: { [PLUGIN_ID]: { config: asRecord(pluginConfig) } } },
    bindings: Array.isArray(bindings) ? bindings : []
  };
  const draft = structuredClone(before);
  mutate(draft);
  const patch = configPatch(before, {
    plugins: { entries: { [PLUGIN_ID]: { config: asRecord(pluginConfigOf(draft)) } } },
    bindings: Array.isArray(draft.bindings) ? draft.bindings : []
  });
  if (patch === void 0) return false;
  const result = await run(["config", "patch", "--stdin"], JSON.stringify(patch));
  if (result.code !== 0) {
    throw new Error(`openclaw config patch failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return true;
}
function pluginConfigOf(draft) {
  return asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config;
}
async function awaitConfigApplied(params) {
  const deadline = Date.now() + (params.timeoutMs ?? 3e4);
  const interval = params.intervalMs ?? 500;
  for (; ; ) {
    if (params.applied()) return "applied";
    if (params.abortSignal.aborted) return "aborted";
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => {
      const timer = setTimeout(done, interval);
      function done() {
        clearTimeout(timer);
        params.abortSignal.removeEventListener("abort", done);
        resolve();
      }
      params.abortSignal.addEventListener("abort", done, { once: true });
    });
  }
}
export {
  awaitConfigApplied,
  configPatch,
  openclawCliArgv,
  runOpenclawCli,
  writeGatewayConfig
};
