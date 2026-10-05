/**
 * Config writes that reach the gateway. A write made in-process from a plugin call (and a channel
 * account is one long call) schedules its own reload inside that call's async context, where
 * OpenClaw refuses to replace the plugin ("cannot replace itself from its own active call"). The
 * file watcher sometimes rescues it, sometimes not. Writing through the CLI, as install.sh does,
 * is an external change to the gateway and reloads every time.
 */
import { execFile } from "node:child_process";

import { asRecord, PLUGIN_ID } from "./accounts.js";

const PLUGIN_CONFIG_PATH = `plugins.entries.${PLUGIN_ID}.config`;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunCli = (args: string[], stdin?: string) => Promise<CliResult>;

/** The gateway is the CLI's own entry point, so no `openclaw` on PATH is assumed. */
export function openclawCliArgv(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  const entry = argv[1];
  return entry && /[\\/]openclaw[\\/]/.test(entry) ? [execPath, entry] : ["openclaw"];
}

export const runOpenclawCli: RunCli = (args, stdin) =>
  new Promise((resolve) => {
    const [command, ...prefix] = openclawCliArgv();
    const child = execFile(
      command!,
      [...prefix, ...args],
      { env: process.env, maxBuffer: 4 * 1024 * 1024 },
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

function parseJson(label: string, result: CliResult): unknown {
  if (result.code !== 0) {
    throw new Error(
      `openclaw config get ${label} failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
  const text = result.stdout.trim();
  if (!text || text === "undefined" || text === "null") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`openclaw config get ${label} returned something that is not JSON`);
  }
}

/**
 * Applies `mutate` to the plugin's config and the bindings as the file has them, then writes the
 * difference through the CLI. False when the mutation changes nothing. The token travels on stdin.
 */
export async function writeGatewayConfig(
  mutate: (draft: Record<string, unknown>) => void,
  run: RunCli = runOpenclawCli,
): Promise<boolean> {
  const [pluginConfig, bindings] = await Promise.all([
    run(["config", "get", PLUGIN_CONFIG_PATH, "--json"]).then((r) =>
      parseJson(PLUGIN_CONFIG_PATH, r),
    ),
    run(["config", "get", "bindings", "--json"]).then((r) => parseJson("bindings", r)),
  ]);
  const before = {
    plugins: { entries: { [PLUGIN_ID]: { config: asRecord(pluginConfig) } } },
    bindings: Array.isArray(bindings) ? bindings : [],
  };
  const draft = structuredClone(before) as Record<string, unknown>;
  mutate(draft);
  const patch = configPatch(before, {
    plugins: { entries: { [PLUGIN_ID]: { config: asRecord(pluginConfigOf(draft)) } } },
    bindings: Array.isArray(draft.bindings) ? draft.bindings : [],
  });
  if (patch === undefined) return false;
  const result = await run(["config", "patch", "--stdin"], JSON.stringify(patch));
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
