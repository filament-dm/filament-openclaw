/** Small abort-aware helpers shared by connect.ts and poll-work.ts. */

/**
 * Sleep for `ms`, resolving early (without throwing) when `signal` aborts.
 * Callers must check `signal.aborted` afterward to tell the two apart.
 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
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

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
}

/**
 * Exponential backoff with full jitter, capped. `attempt` is 1-based (the
 * count of consecutive failures so far).
 */
export function nextBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1_000;
  const cap = opts.capMs ?? 60_000;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exp);
}
