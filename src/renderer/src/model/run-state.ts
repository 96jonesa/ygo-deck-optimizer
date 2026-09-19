import type {
  Count,
  OptimizeProgress,
  RunConfirmation,
  RunEvent,
  RunResult,
} from '../../../shared/types';

/** What the screen shows of the optimizer: the latest run, and where it stands. */
export type RunView =
  | { phase: 'idle' }
  | {
      phase: 'running';
      runId: number;
      /** As `started` had them; `null` for a run first seen mid-way. */
      total: Count | null;
      estimatedMs: number | null;
      /** The latest report; `null` until the first. */
      progress: OptimizeProgress | null;
      /** A graceful stop was asked for and the partial result is awaited. */
      cancelling: boolean;
    }
  | { phase: 'confirming'; runId: number; confirmation: RunConfirmation }
  | { phase: 'done'; runId: number; result: RunResult }
  /** `result` is what a graceful stop kept; `null` when the run was abandoned. */
  | { phase: 'cancelled'; runId: number; result: RunResult | null }
  | { phase: 'failed'; runId: number; message: string };

export const IDLE_RUN: RunView = { phase: 'idle' };

/**
 * The view after one `run:event`. Main sends the events of ONE run at a time
 * and numbers the runs upwards, so: an event of an older run than the one on
 * screen is dropped (the view comes back as it was, the same object); an event
 * of a newer run takes the screen over — `started` normally, but any event
 * will do, since `started` may have gone by before this window was listening.
 */
export function reduceRun(view: RunView, event: RunEvent): RunView {
  const current = view.phase === 'idle' ? -1 : view.runId;
  if (event.runId < current) return view;
  const { runId } = event;
  switch (event.type) {
    case 'started':
      return {
        phase: 'running',
        runId,
        total: event.total,
        estimatedMs: event.estimatedMs,
        progress: null,
        cancelling: false,
      };
    case 'progress': {
      const running = view.phase === 'running' && view.runId === runId ? view : null;
      // After a confirmation, the size that was asked about is the size of the run.
      const asked = view.phase === 'confirming' && view.runId === runId ? view.confirmation : null;
      return {
        phase: 'running',
        runId,
        total: running?.total ?? asked?.total ?? null,
        estimatedMs: running?.estimatedMs ?? asked?.estimatedMs ?? null,
        progress: event.progress,
        cancelling: running?.cancelling ?? false,
      };
    }
    case 'needs-confirmation':
      return { phase: 'confirming', runId, confirmation: event.confirmation };
    case 'result':
      return { phase: 'done', runId, result: event.result };
    case 'cancelled':
      return { phase: 'cancelled', runId, result: event.result };
    case 'error':
      return { phase: 'failed', runId, message: event.message };
  }
}

/** The user pressed Cancel: say so until the partial result arrives. Anything but a running run is left as it is. */
export function markCancelling(view: RunView): RunView {
  return view.phase === 'running' ? { ...view, cancelling: true } : view;
}
