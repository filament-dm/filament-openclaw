const TURN_START_TIMEOUT_MS = 9e4;
const TURN_IDLE_TIMEOUT_MS = 5 * 6e4;
const STUCK_TURN_SETTLE_MS = 1e4;
const TURN_HEARTBEAT_MS = 6e4;
const RUN_STARTED = /* @__PURE__ */ new Set(["run:start", "model:selected"]);
async function runTurnWithStartDeadline(turn, opts) {
  const startTimeoutMs = opts.startTimeoutMs ?? TURN_START_TIMEOUT_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? STUCK_TURN_SETTLE_MS;
  const heartbeatMs = opts.heartbeatMs ?? TURN_HEARTBEAT_MS;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {
  });
  const t0 = now();
  const steps = [];
  let started = false;
  let lastMoveAt = t0;
  const secs = (ms) => (ms / 1e3).toFixed(1);
  const trail = () => steps.map((s) => `${s.step}@${secs(s.at - t0)}s`).join(" ") || "no steps";
  let wake = () => {
  };
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
    }
  });
  let done = false;
  const settled = running.then(
    () => void (done = true),
    () => void (done = true)
  );
  let nextHeartbeat = t0 + heartbeatMs;
  while (!done) {
    const deadline = started ? lastMoveAt + idleTimeoutMs : t0 + startTimeoutMs;
    const at = now();
    if (at >= deadline) break;
    if (at >= nextHeartbeat) {
      log(
        `turn still running after ${secs(at - t0)} s (${started ? "run started" : "run not started"}; last step: ${steps.at(-1)?.step ?? "none"})`
      );
      nextHeartbeat += heartbeatMs;
    }
    let timer;
    await Promise.race([
      settled,
      new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.max(0, Math.min(deadline, nextHeartbeat) - now()));
      })
    ]);
    clearTimeout(timer);
    wake = () => {
    };
  }
  if (done) return { kind: "result", result: await running, trail: trail() };
  stuck.abort(new Error(started ? "the turn stalled" : "the turn did not start in time"));
  let graceTimer;
  const grace = new Promise((resolve) => {
    graceTimer = setTimeout(() => resolve("grace"), settleMs);
  });
  const after = await Promise.race([settled.then(() => "settled"), grace]);
  clearTimeout(graceTimer);
  if (after === "settled") {
    const outcome = await running.then(
      (result) => result,
      () => void 0
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
    trail: trail()
  };
}
export {
  STUCK_TURN_SETTLE_MS,
  TURN_HEARTBEAT_MS,
  TURN_IDLE_TIMEOUT_MS,
  TURN_START_TIMEOUT_MS,
  runTurnWithStartDeadline
};
