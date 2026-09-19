import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  IDLE_RUN,
  markCancelling,
  type RunView,
  reduceRun,
} from '../../../../src/renderer/src/model/run-state';
import type { RunConfirmation, RunEvent } from '../../../../src/shared/types';
import { motivatingResult } from '../../../helpers/motivating-run';

const SQL = await initSqlJs();
const RESULT = motivatingResult(SQL);

const CONFIRMATION: RunConfirmation = {
  reason: 'estimate',
  total: 5_758_374,
  estimatedMs: 25_001,
  thresholdMs: 60_000,
  cost: { perVectorUs: 0, perTermNs: 7 },
  message: 'scoring 5758374 class vectors would take about 25 s',
};

const progress = (runId: number, done: number): RunEvent => ({
  runId,
  type: 'progress',
  progress: { done, total: 128, elapsedMs: done * 10, etaMs: (128 - done) * 10 },
});

function viewAfter(...events: RunEvent[]): RunView {
  return events.reduce(reduceRun, IDLE_RUN);
}

const STARTED: RunEvent = { runId: 4, type: 'started', total: 128, estimatedMs: 0.2 };

describe('reduceRun', () => {
  it('follows a run from `started` through progress to its result', () => {
    expect(viewAfter(STARTED)).toEqual({
      phase: 'running',
      runId: 4,
      total: 128,
      estimatedMs: 0.2,
      progress: null,
      cancelling: false,
    });
    expect(viewAfter(STARTED, progress(4, 64))).toMatchObject({
      phase: 'running',
      progress: { done: 64, total: 128 },
    });
    expect(
      viewAfter(STARTED, progress(4, 64), { runId: 4, type: 'result', result: RESULT }),
    ).toEqual({
      phase: 'done',
      runId: 4,
      result: RESULT,
    });
  });

  it('waits at `needs-confirmation`, and runs on from there', () => {
    const asked = viewAfter(STARTED, {
      runId: 4,
      type: 'needs-confirmation',
      confirmation: CONFIRMATION,
    });
    expect(asked).toEqual({ phase: 'confirming', runId: 4, confirmation: CONFIRMATION });
    // Confirmed, the same run reports progress again.
    expect(reduceRun(asked, progress(4, 1))).toMatchObject({
      phase: 'running',
      runId: 4,
      total: 5_758_374,
      progress: { done: 1 },
    });
  });

  it('ends in `cancelled` with what was kept, or with nothing', () => {
    const partial = { ...RESULT, status: 'cancelled' as const, partial: true as const, done: 40 };
    expect(viewAfter(STARTED, { runId: 4, type: 'cancelled', result: partial })).toEqual({
      phase: 'cancelled',
      runId: 4,
      result: partial,
    });
    expect(viewAfter(STARTED, { runId: 4, type: 'cancelled', result: null })).toEqual({
      phase: 'cancelled',
      runId: 4,
      result: null,
    });
  });

  it('ends in `failed` with the message', () => {
    expect(viewAfter(STARTED, { runId: 4, type: 'error', message: 'boom' })).toEqual({
      phase: 'failed',
      runId: 4,
      message: 'boom',
    });
  });

  it('drops what an older run still says: a newer run is on screen', () => {
    const newer = viewAfter(STARTED, { runId: 5, type: 'started', total: 9, estimatedMs: 1 });
    expect(newer).toMatchObject({ phase: 'running', runId: 5, total: 9 });
    expect(reduceRun(newer, progress(4, 100))).toBe(newer);
    expect(reduceRun(newer, { runId: 4, type: 'result', result: RESULT })).toBe(newer);
    expect(reduceRun(newer, { runId: 4, type: 'cancelled', result: null })).toBe(newer);
  });

  it('lets a new run replace a finished one', () => {
    const done = viewAfter(STARTED, { runId: 4, type: 'result', result: RESULT });
    expect(reduceRun(done, { runId: 5, type: 'started', total: 9, estimatedMs: 1 })).toMatchObject({
      phase: 'running',
      runId: 5,
    });
  });

  it('takes up a run it never saw start — a window opened mid-run — at its next event', () => {
    expect(viewAfter(progress(7, 64))).toEqual({
      phase: 'running',
      runId: 7,
      total: null,
      estimatedMs: null,
      progress: { done: 64, total: 128, elapsedMs: 640, etaMs: 640 },
      cancelling: false,
    });
    expect(viewAfter({ runId: 7, type: 'result', result: RESULT })).toMatchObject({
      phase: 'done',
    });
  });

  it('keeps `cancelling` while progress still arrives, until the run ends', () => {
    const cancelling = markCancelling(viewAfter(STARTED, progress(4, 10)));
    expect(reduceRun(cancelling, progress(4, 20))).toMatchObject({
      cancelling: true,
      progress: { done: 20 },
    });
  });
});

describe('markCancelling', () => {
  it('marks a running run, and nothing else', () => {
    expect(markCancelling(viewAfter(STARTED))).toMatchObject({
      phase: 'running',
      cancelling: true,
    });
    const done = viewAfter(STARTED, { runId: 4, type: 'result', result: RESULT });
    expect(markCancelling(done)).toBe(done);
    expect(markCancelling(IDLE_RUN)).toBe(IDLE_RUN);
  });
});
