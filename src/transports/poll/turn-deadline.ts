/**
 * A turn that stops moving. Since OpenClaw 2026.11.4 a reply turn that arrives while the agent is
 * still in its startup preparation waits for it (openclaw #174958) instead of failing at once. On
 * some starts the turn then never answers and never settles: the poll loop sat on it, and the
 * messages queued while the gateway was down got no answer.
 *
 * So a turn has to keep moving. Before the agent's run starts (OpenClaw's run start or model
 * choice) it gets `startTimeoutMs`; after that, `idleTimeoutMs` between steps (a turn stage, a
 * tool or block reply, the final). One that stalls is aborted and offered again under the same
 * cursor: the item is not acknowledged, and nothing was published for it. Every step is kept with
 * its time, and a turn still running is reported every `heartbeatMs`, so the log shows where a
 * turn stopped.
 */
import type { TurnOptions, TurnResult } from "../types.js";

/** How long a turn gets to start the agent's run, or finish, before it counts as stuck. */
export const TURN_START_TIMEOUT_MS = 90_000;
/**
 * Once the agent's run started, the longest quiet spell between two steps. Long enough for a slow
 * model call or tool; a run that says nothing for this long is not coming back.
 */
export const TURN_IDLE_TIMEOUT_MS = 5 * 60_000;
/** After aborting a stuck turn, how long it gets to settle before the loop lets it go. */
export const STUCK_TURN_SETTLE_MS = 10_000;
/** How often a turn still running is reported. */
export const TURN_HEARTBEAT_MS = 60_000;

/** Steps that mean the agent's run began: from here the turn is the model's. */
const RUN_STARTED = new Set(["run:start", "model:selected"]);

export type WatchedTurn =
  | { kind: "result"; result: TurnResult; trail: string }
  /** Stalled. `lastStep`: the last step OpenClaw reported; `trail`: every step with its time. */
  | {
      kind: "stuck";
      started: boolean;
      lastStep: string | undefined;
      settled: boolean;
      trail: string;
    };

export interface TurnDeadlineOptions {
  /** The transport's own abort (gateway shutdown): passed on to the turn. */
  abortSignal: AbortSignal;
  /** Heartbeats and the run's start. */
  log?: (message: string) => void;
  startTimeoutMs?: number;
  idleTimeoutMs?: number;
  settleMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * Runs `turn` under the deadlines above. Throws what the turn throws, unless the turn was already
 * judged stuck. A result that lands during the settle wait is still used.
 */
export async function runTurnWithStartDeadline(
  turn: (opts: TurnOptions) => Promise<TurnResult>,
  opts: TurnDeadlineOptions,
): Promise<WatchedTurn> {
  const startTimeoutMs = opts.startTimeoutMs ?? TURN_START_TIMEOUT_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? STUCK_TURN_SETTLE_MS;
  const heartbeatMs = opts.heartbeatMs ?? TURN_HEARTBEAT_MS;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const t0 = now();
  const steps: Array<{ step: string; at: number }> = [];
  let started = false;
  let lastMoveAt = t0;
  const secs = (ms: number) => (ms / 1000).toFixed(1);
  const trail = () => steps.map((s) => `${s.step}@${secs(s.at - t0)}s`).join(" ") || "no steps";
  let wake: () => void = () => {};

  const stuck = new AbortController();
  const running = turn({
    abortSignal: AbortSignal.any([opts.abortSignal, stuck.signal]),
    onProgress: (step) => {
      const at = now();
      steps.push({ step, at });
      lastMoveAt = at;
      if (!started && RUN_STARTED.has(step)) {
        started = true;
        log(`the agent's run started after ${secs(at - t0)} s (${step})`);
      }
      wake();
    },
  });
  let done = false;
  const settled = running.then(
    () => void (done = true),
    () => void (done = true),
  );

  // Wakes on a step, on the turn settling, or on the next deadline or heartbeat.
  let nextHeartbeat = t0 + heartbeatMs;
  while (!done) {
    const deadline = started ? lastMoveAt + idleTimeoutMs : t0 + startTimeoutMs;
    const at = now();
    if (at >= deadline) break;
    if (at >= nextHeartbeat) {
      log(
        `turn still running after ${secs(at - t0)} s (${started ? "run started" : "run not started"}; last step: ${steps.at(-1)?.step ?? "none"})`,
      );
      nextHeartbeat += heartbeatMs;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.max(0, Math.min(deadline, nextHeartbeat) - now()));
      }),
    ]);
    clearTimeout(timer);
    wake = () => {};
  }
  if (done) return { kind: "result", result: await running, trail: trail() };

  stuck.abort(new Error(started ? "the turn stalled" : "the turn did not start in time"));
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<"grace">((resolve) => {
    graceTimer = setTimeout(() => resolve("grace"), settleMs);
  });
  const after = await Promise.race([settled.then(() => "settled" as const), grace]);
  clearTimeout(graceTimer);
  if (after === "settled") {
    const outcome = await running.then(
      (result) => result,
      () => undefined,
    );
    if (outcome && (outcome.sawFinal || outcome.sawSkip || outcome.sawError)) {
      return { kind: "result", result: outcome, trail: trail() };
    }
  }
  return {
    kind: "stuck",
    started,
    lastStep: steps.at(-1)?.step,
    settled: after === "settled",
    trail: trail(),
  };
}
