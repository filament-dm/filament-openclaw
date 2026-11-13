/**
 * Config writes that reach the gateway. A write made in-process from a plugin call (and a channel
 * account is one long call) schedules its own reload inside that call's async context, where
 * OpenClaw refuses to replace the plugin ("cannot replace itself from its own active call"). The
 * file watcher sometimes rescues it, sometimes not. Writing through the CLI, as install.sh does,
 * is an external change to the gateway and reloads every time.
 *
 * But `openclaw config patch` returns only once the gateway has applied the change, and a plugin
 * replacement waits for the plugin's admitted work: an account awaiting the patch that replaces
 * its own plugin (the token save after a device sign-in) deadlocked until the 60 s drain failed,
 * and the plugin stayed down until `openclaw plugins reload`. And a login run from an agent's
 * shell waited minutes for an apply the gateway was holding back. So such writes hand the patch
 * off (`WriteOptions`) instead of awaiting the apply: once the gateway has the change on file, it
 * applies it by itself, and the writer can let go.
 */
import { execFile } from "node:child_process";

import { asRecord, PLUGIN_ID } from "./accounts.js";

const PLUGIN_CONFIG_PATH = `plugins.entries.${PLUGIN_ID}.config`;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `signal` ends the command (SIGTERM); an `openclaw config patch` ended so closes its request. */
export type RunCli = (args: string[], stdin?: string, signal?: AbortSignal) => Promise<CliResult>;

/** The gateway is the CLI's own entry point, so no `openclaw` on PATH is assumed. */
export function openclawCliArgv(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  const entry = argv[1];
  return entry && /[\\/]openclaw[\\/]/.test(entry) ? [execPath, entry] : ["openclaw"];
}

export const runOpenclawCli: RunCli = (args, stdin, signal) =>
  new Promise((resolve) => {
    const [command, ...prefix] = openclawCliArgv();
    const child = execFile(
      command!,
      [...prefix, ...args],
      { env: process.env, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : null;
        resolve({ code: error ? (code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });

/**
 * The patch `openclaw config patch` needs to turn `before` into `after`: objects merge key by key,
 * a removed key becomes null, arrays and scalars are replaced whole. Undefined when nothing changed.
 */
export function configPatch(before: unknown, after: unknown): unknown {
  if (isPlainObject(before) && isPlainObject(after)) {
    const patch: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) {
        patch[key] = null;
        continue;
      }
      const child = key in before ? configPatch(before[key], after[key]) : after[key];
      if (child !== undefined) patch[key] = child;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? undefined : after;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `config get` exits 1 for a path the file does not set, with its reason in a JSON envelope. */
export function isUnsetPath(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { ok?: unknown; error?: { message?: unknown } };
    return parsed.ok === false && /valid but unset/.test(String(parsed.error?.message ?? ""));
  } catch {
    return false;
  }
}

function parseJson(label: string, result: CliResult): unknown {
  const text = result.stdout.trim();
  if (result.code !== 0) {
    if (isUnsetPath(text)) return undefined;
    throw new Error(
      `openclaw config get ${label} failed (exit ${result.code}): ${(result.stderr || text).trim()}`,
    );
  }
  if (!text || text === "undefined" || text === "null") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`openclaw config get ${label} returned something that is not JSON`);
  }
}

/**
 * How a write that may run inside work the gateway waits for hands its patch off. Without these
 * it awaits the patch until the gateway has applied it.
 */
export interface WriteOptions {
  /**
   * The writer's own abort: the reload a write causes aborts the account that made it. On abort
   * the patch is left to finish on its own and the write returns at once, so the account can stop
   * and the reload can go ahead.
   */
  abortSignal?: AbortSignal;
  /**
   * After this long without an answer, look at the file: if it already has the change, end the
   * `config patch` command (the gateway keeps the change and applies it by itself) and return.
   */
  handOffAfterMs?: number;
}

/** A `config patch` the caller may stop waiting for; `persisted` says whether the file has it. */
export async function patchConfig(
  patch: unknown,
  run: RunCli,
  persisted: () => Promise<boolean>,
  opts: WriteOptions = {},
): Promise<CliResult | "handed-off"> {
  const { abortSignal, handOffAfterMs } = opts;
  if (!abortSignal && handOffAfterMs === undefined) {
    return run(["config", "patch", "--stdin"], JSON.stringify(patch));
  }
  const end = new AbortController();
  const patching = run(["config", "patch", "--stdin"], JSON.stringify(patch), end.signal);
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const trigger = new Promise<"abort" | "timeout">((resolve) => {
      if (abortSignal?.aborted) return resolve("abort");
      onAbort = () => resolve("abort");
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (handOffAfterMs !== undefined)
        timer = setTimeout(() => resolve("timeout"), handOffAfterMs);
    });
    const first = await Promise.race([patching, trigger]);
    clearTimeout(timer);
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
    if (first !== "abort" && first !== "timeout") return first;
    // The reload this write causes is what aborts its writer: the gateway has the change. The
    // patch runs on and finishes by itself; nothing here may hold the account any longer.
    if (first === "abort") return "handed-off";
    if (await persisted().catch(() => false)) {
      end.abort();
      return "handed-off";
    }
    // Not on file yet: keep waiting for the patch (or the next look).
  }
}

// Writes queue behind each other: each one's read must see the previous one's patch, or the
// later `bindings` array would be built from a stale snapshot and drop what the earlier one added.
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Applies `mutate` to the plugin's config and the bindings as the file has them, then writes the
 * difference through the CLI. False when the mutation changes nothing. The token travels on stdin.
 */
export function writeGatewayConfig(
  mutate: (draft: Record<string, unknown>) => void,
  run: RunCli = runOpenclawCli,
  opts: WriteOptions = {},
): Promise<boolean> {
  const next = writeQueue.then(() => writeGatewayConfigNow(mutate, run, opts));
  writeQueue = next.catch(() => {});
  return next;
}

async function readFileState(run: RunCli): Promise<Record<string, unknown>> {
  const [pluginConfig, bindings] = await Promise.all([
    run(["config", "get", PLUGIN_CONFIG_PATH, "--json"]).then((r) =>
      parseJson(PLUGIN_CONFIG_PATH, r),
    ),
    run(["config", "get", "bindings", "--json"]).then((r) => parseJson("bindings", r)),
  ]);
  return {
    plugins: { entries: { [PLUGIN_ID]: { config: asRecord(pluginConfig) } } },
    bindings: Array.isArray(bindings) ? bindings : [],
  };
}

async function writeGatewayConfigNow(
  mutate: (draft: Record<string, unknown>) => void,
  run: RunCli,
  opts: WriteOptions,
): Promise<boolean> {
  const before = await readFileState(run);
  const draft = structuredClone(before) as Record<string, unknown>;
  mutate(draft);
  const after = {
    plugins: { entries: { [PLUGIN_ID]: { config: asRecord(pluginConfigOf(draft)) } } },
    bindings: Array.isArray(draft.bindings) ? draft.bindings : [],
  };
  const patch = configPatch(before, after);
  if (patch === undefined) return false;
  const result = await patchConfig(
    patch,
    run,
    async () => configPatch(await readFileState(run), after) === undefined,
    opts,
  );
  if (result === "handed-off") return true;
  if (result.code !== 0) {
    throw new Error(`openclaw config patch failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return true;
}

function pluginConfigOf(draft: Record<string, unknown>): unknown {
  return asRecord(asRecord(asRecord(draft.plugins).entries)[PLUGIN_ID]).config;
}

export type ConfigApplyWait = "applied" | "aborted" | "timeout";

/**
 * Waits until `applied` holds against the live gateway config. The reload that applies a write
 * aborts the writing account before the live config shows it, so an abort usually means applied.
 */
export async function awaitConfigApplied(params: {
  applied: () => boolean;
  abortSignal: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<ConfigApplyWait> {
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  const interval = params.intervalMs ?? 500;
  for (;;) {
    if (params.applied()) return "applied";
    if (params.abortSignal.aborted) return "aborted";
    if (Date.now() >= deadline) return "timeout";
    await new Promise<void>((resolve) => {
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
