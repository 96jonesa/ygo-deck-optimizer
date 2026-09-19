/** What long-running work reports (TDD §11.3): work done of a known total, time spent, and time left. */
export interface Progress {
  done: number;
  total: number;
  elapsedMs: number;
  /** Time left at the rate so far; 0 when nothing is left, or when nothing has been done yet. */
  etaMs: number;
}

export type OnProgress = (progress: Progress) => void;

export interface ProgressOptions {
  /** The least time between two reports. Default 500 ms. */
  intervalMs?: number;
  /** The clock, in milliseconds; injected by tests. Default `Date.now`. */
  now?: () => number;
}

export interface ProgressReporter {
  /** Report `done` if the interval has passed since the last report; cheap enough for a hot loop's chunk boundary. */
  tick(done: number): void;
  /** The closing report, `done === total`, whatever the interval says. Call it exactly once, last. */
  finish(): void;
}

/**
 * Throttled progress for a loop whose `total` is known up front. Reports are
 * monotone in `done`, at most one per `intervalMs`, and the last one — from
 * `finish` — always says `done === total`. Without a callback it does nothing.
 */
export function createProgressReporter(
  total: number,
  onProgress: OnProgress | undefined,
  opts: ProgressOptions = {},
): ProgressReporter {
  if (onProgress === undefined) return { tick: () => {}, finish: () => {} };
  const intervalMs = opts.intervalMs ?? 500;
  const now = opts.now ?? Date.now;
  const start = now();
  let last = start;
  const report = (done: number, at: number) => {
    const elapsedMs = at - start;
    const etaMs = done > 0 ? (elapsedMs * (total - done)) / done : 0;
    onProgress({ done, total, elapsedMs, etaMs });
  };
  return {
    tick: (done) => {
      const at = now();
      if (at - last < intervalMs) return;
      last = at;
      report(done, at);
    },
    finish: () => report(total, now()),
  };
}
