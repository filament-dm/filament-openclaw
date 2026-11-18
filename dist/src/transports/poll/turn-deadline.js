const TURN_START_TIMEOUT_MS = 9e4;
const STUCK_TURN_SETTLE_MS = 1e4;
const RUN_STARTED = /* @__PURE__ */ new Set(["run:start", "model:selected"]);
async function runTurnWithStartDeadline(turn, opts) {
  const startTimeoutMs = opts.startTimeoutMs ?? TURN_START_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? STUCK_TURN_SETTLE_MS;
  const stuck = new AbortController();
  let lastStep;
  let markStarted = () => {
  };
  const started = new Promise((resolve) => {
    markStarted = () => resolve("started");
  });
  const running = turn({
    abortSignal: AbortSignal.any([opts.abortSignal, stuck.signal]),
    onProgress: (step) => {
      lastStep = step;
      if (RUN_STARTED.has(step)) markStarted();
    }
  });
  const settled = running.then(
    () => "settled",
    () => "settled"
  );
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), startTimeoutMs);
  });
  const first = await Promise.race([settled, started, deadline]);
  clearTimeout(timer);
  if (first !== "timeout") return { kind: "result", result: await running };
  stuck.abort(new Error(`the turn did not start within ${startTimeoutMs} ms`));
  let graceTimer;
  const grace = new Promise((resolve) => {
    graceTimer = setTimeout(() => resolve("grace"), settleMs);
  });
  const after = await Promise.race([settled, grace]);
  clearTimeout(graceTimer);
  if (after === "settled") {
    const outcome = await running.then(
      (result) => result,
      () => void 0
    );
    if (outcome && (outcome.sawFinal || outcome.sawSkip || outcome.sawError)) {
      return { kind: "result", result: outcome };
    }
  }
  return { kind: "stuck", lastStep, settled: after === "settled" };
}
export {
  STUCK_TURN_SETTLE_MS,
  TURN_START_TIMEOUT_MS,
  runTurnWithStartDeadline
};
