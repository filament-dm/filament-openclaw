function sleepAbortable(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function nextBackoffMs(attempt, opts = {}) {
  const base = opts.baseMs ?? 1e3;
  const cap = opts.capMs ?? 6e4;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exp);
}
export {
  nextBackoffMs,
  sleepAbortable
};
//# sourceMappingURL=util.js.map
