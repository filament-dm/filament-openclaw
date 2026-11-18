/**
 * A turn that never starts. Since OpenClaw 2026.11.4 a reply turn that arrives while the agent is
 * still in its startup preparation waits for it (openclaw #174958) instead of failing at once. On
 * some starts that wait ends and the turn still never reaches the agent's run, and never settles:
 * the poll loop then sat on it, and the messages queued while the gateway was down got no answer.
 *
 * So a turn has to show that the agent's run began (OpenClaw's run start or model choice) within a
 * deadline, or finish. One that does neither is aborted and offered again under the same cursor:
 * the item is not acknowledged, and nothing was published for it.
 */
import type { TurnOptions, TurnResult } from "../types.js";

/** How long a turn gets to start the agent's run, or finish, before it counts as stuck. */
export const TURN_START_TIMEOUT_MS = 90_000;
/** After aborting a stuck turn, how long it gets to settle before the loop lets it go. */
export const STUCK_TURN_SETTLE_MS = 10_000;

/** Steps that mean the agent's run began: from here the turn is the model's, however long. */
const RUN_STARTED = new Set(["run:start", "model:selected"]);

export type WatchedTurn =
  | { kind: "result"; result: TurnResult }
  /** Neither started nor finished in time. `lastStep`: the last step OpenClaw reported. */
  | { kind: "stuck"; lastStep: string | undefined; settled: boolean };

export interface TurnDeadlineOptions {
  /** The transport's own abort (gateway shutdown): passed on to the turn. */
  abortSignal: AbortSignal;
  startTimeoutMs?: number;
  settleMs?: number;
}

/**
 * Runs `turn` with a start deadline. Throws what the turn throws, unless the turn was already
 * judged stuck. A result that lands during the settle wait is still used.
 */
export async function runTurnWithStartDeadline(
  turn: (opts: TurnOptions) => Promise<TurnResult>,
  opts: TurnDeadlineOptions,
): Promise<WatchedTurn> {
  const startTimeoutMs = opts.startTimeoutMs ?? TURN_START_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? STUCK_TURN_SETTLE_MS;
  const stuck = new AbortController();
  let lastStep: string | undefined;
  let markStarted: () => void = () => {};
  const started = new Promise<"started">((resolve) => {
    markStarted = () => resolve("started");
  });
  const running = turn({
    abortSignal: AbortSignal.any([opts.abortSignal, stuck.signal]),
    onProgress: (step) => {
      lastStep = step;
      if (RUN_STARTED.has(step)) markStarted();
    },
  });
  const settled = running.then(
    () => "settled" as const,
    () => "settled" as const,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), startTimeoutMs);
  });
  const first = await Promise.race([settled, started, deadline]);
  clearTimeout(timer);
  if (first !== "timeout") return { kind: "result", result: await running };

  stuck.abort(new Error(`the turn did not start within ${startTimeoutMs} ms`));
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<"grace">((resolve) => {
    graceTimer = setTimeout(() => resolve("grace"), settleMs);
  });
  const after = await Promise.race([settled, grace]);
  clearTimeout(graceTimer);
  if (after === "settled") {
    const outcome = await running.then(
      (result) => result,
      () => undefined,
    );
    if (outcome && (outcome.sawFinal || outcome.sawSkip || outcome.sawError)) {
      return { kind: "result", result: outcome };
    }
  }
  return { kind: "stuck", lastStep, settled: after === "settled" };
}
