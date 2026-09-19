import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import type { CostModel } from '../../src/core/model/analyze';
import type { WorkerMessage, WorkerResult } from '../../src/worker/protocol';
import { WorkerSession } from '../../src/worker/session';
import { motivatingRequest } from '../helpers/motivating-run';
import { cancelFlag, runRequest, wideProblem } from '../helpers/wide-compiled';

const SQL = await initSqlJs();

const COST: CostModel = { perVectorUs: 0.25, perTermNs: 7.5 };

/** 64 vectors; `EVERY_VECTOR` makes the search report — and ask about cancelling — after each. */
const SMALL = wideProblem({ lines: 3, max: 3 });
const EVERY_VECTOR = { checkEvery: 1, progressIntervalMs: 0 };

/** A started session, what it posts, and how often it calibrated. */
function harness(onPost: (message: WorkerMessage) => void = () => {}) {
  const posted: WorkerMessage[] = [];
  let calibrations = 0;
  const session = new WorkerSession(
    (message) => {
      posted.push(message);
      onPost(message);
    },
    {
      calibrate: () => {
        calibrations++;
        return COST;
      },
    },
  );
  const results = () =>
    posted.flatMap((message) => (message.type === 'result' ? [message.result] : []));
  return { session, posted, results, calibrations: () => calibrations };
}

function scored(result: WorkerResult | undefined) {
  if (result?.status !== 'done' && result?.status !== 'cancelled')
    throw new Error(`expected a scored result, got ${result?.status}`);
  return result;
}

describe('WorkerSession', () => {
  it('calibrates ONCE, at startup, however many runs follow', () => {
    const { session, results, calibrations } = harness();
    session.start();
    session.handle(runRequest(1, SMALL));
    session.handle(runRequest(2, SMALL));
    expect(results().map((result) => result.status)).toEqual(['done', 'done']);
    expect(calibrations()).toBe(1);
  });

  it('asks before a run over the threshold, and runs it when it is sent again with force', () => {
    const { session, posted } = harness();
    session.start();
    const request = runRequest(7, SMALL, { confirmThresholdMs: 0 });
    session.handle(request);
    expect(posted.at(-1)).toMatchObject({
      type: 'result',
      runId: 7,
      result: { status: 'needs-confirmation', reason: 'estimate', total: 64, thresholdMs: 0 },
    });
    // Nothing was scored: no progress came before the refusal.
    expect(posted.filter((message) => message.type === 'progress')).toEqual([]);

    session.handle({ ...request, options: { ...request.options, force: true } });
    expect(posted.at(-1)).toMatchObject({ type: 'result', runId: 7, result: { status: 'done' } });
  });

  describe('start', () => {
    it('posts `ready` with the cost it calibrated', () => {
      const { session, posted } = harness();
      session.start();
      expect(posted).toEqual([{ type: 'ready', cost: COST }]);
    });

    it('calibrates for real when no calibration is injected', () => {
      const posted: WorkerMessage[] = [];
      new WorkerSession((message) => posted.push(message)).start();
      expect(posted).toHaveLength(1);
      const [ready] = posted;
      if (ready?.type !== 'ready') throw new Error('expected `ready`');
      expect(ready.cost.perTermNs).toBeGreaterThan(0);
      expect(ready.cost.perVectorUs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('handle', () => {
    it('scores the motivating example exactly: 46,185 / 658,008', () => {
      const { session, results } = harness();
      session.start();
      session.handle(motivatingRequest(SQL, 1));
      const result = scored(results()[0]);
      expect(result).toMatchObject({ status: 'done', partial: false, done: 128, total: 128 });
      expect(result.best.blend).toEqual({ num: 46_185, den: 658_008 });
    });

    it('reports progress under the run’s id, then the result under it too', () => {
      const { session, posted } = harness();
      session.start();
      session.handle(runRequest(42, SMALL, EVERY_VECTOR));
      const progress = posted.filter((message) => message.type === 'progress');
      // One report per vector — the last vector's falls in with the closing one.
      expect(progress.length).toBeGreaterThanOrEqual(64);
      expect(progress.every((message) => message.runId === 42)).toBe(true);
      expect(progress.at(-1)).toMatchObject({ progress: { done: 64, total: 64, etaMs: 0 } });
      expect(posted.at(-1)).toMatchObject({ type: 'result', runId: 42 });
      expect(posted.filter((message) => message.type === 'result')).toHaveLength(1);
    });

    it('passes its calibrated cost to every search', () => {
      const { session, results } = harness();
      session.start();
      session.handle(runRequest(1, SMALL));
      expect(scored(results()[0]).cost).toEqual(COST);
    });

    it('stops early when the cancel flag is set mid-run, keeping what it has', () => {
      const flag = cancelFlag();
      let reports = 0;
      const { session, results } = harness((message) => {
        if (message.type === 'progress' && ++reports === 2)
          Atomics.store(new Int32Array(flag), 0, 1);
      });
      session.start();
      session.handle(runRequest(1, SMALL, EVERY_VECTOR, flag));
      const result = scored(results()[0]);
      expect(result).toMatchObject({ status: 'cancelled', partial: true, done: 2, total: 64 });
      // A partial result is shown like a whole one: it is expanded to lines too.
      expect(result.rankedRatios).toHaveLength(result.ranked.length);
      expect(result.breakdown).toHaveLength(SMALL.criteria.length);
    });

    it('runs to the end while the flag stays clear', () => {
      const { session, results } = harness();
      session.start();
      session.handle(runRequest(1, SMALL, EVERY_VECTOR));
      expect(scored(results()[0])).toMatchObject({ status: 'done', done: 64 });
    });

    it('honours the plateau cap and the table size it is given', () => {
      const { session, results } = harness();
      session.start();
      session.handle(
        runRequest(1, SMALL, { plateauDelta: { num: 1, den: 1 }, plateauCap: 5, topK: 7 }),
      );
      const result = scored(results()[0]);
      expect(result.plateau.vectors).toHaveLength(5);
      expect(result.plateau).toMatchObject({ truncated: true, size: 64, sizeExact: true });
      expect(result.ranked).toHaveLength(7);
    });

    it('adds the lines, and the best vector criterion by criterion', () => {
      const { session, results } = harness();
      session.start();
      session.handle(motivatingRequest(SQL, 1));
      const result = scored(results()[0]);
      expect(result.lines.map((line) => line.id)).toEqual([
        'A',
        'B',
        'monster',
        'level4',
        'fire-bw',
        'spell',
        'normal-spell',
        'remainder',
      ]);
      expect(result.lines.map((line) => line.cls)).toEqual([1, 2, 3, 4, 3, 0, 0, 0]);
      // c2 adds nothing to c1 (every hand that meets it meets c1), so c1 alone IS the whole score.
      expect(result.breakdown.map(({ id, name, blend }) => ({ id, name, blend }))).toEqual([
        { id: 'c1', name: 'A, B and any monster', blend: { num: 46_185, den: 658_008 } },
        { id: 'c2', name: 'A, B and a low-Level monster', blend: { num: 19_737, den: 658_008 } },
      ]);
    });

    it('expands the best vector and every ranked row to lines', () => {
      const { session, results } = harness();
      session.start();
      session.handle(motivatingRequest(SQL, 1));
      const result = scored(results()[0]);
      expect(result.best.classTotals).toEqual([23, 3, 3, 8, 3]);
      // One concrete deck: the lines in template order, the remainder last.
      expect(result.bestRatio.example).toEqual([3, 3, 5, 3, 3, 7, 3, 13]);
      expect(result.bestRatio.classes.map((cls) => cls.text)).toEqual([
        '23 copies among `spell`, `normal-spell`, `remainder` — any split',
        '3 copies of `A`',
        '3 copies of `B`',
        '8 copies among `monster`, `fire-bw` — any split',
        '3 copies of `level4`',
      ]);
      expect(result.bestRatio.classes[0]?.lines).toEqual([
        { id: 'spell', min: 0, max: 7 },
        { id: 'normal-spell', min: 0, max: 3 },
        { id: 'remainder', min: 13, max: 23 },
      ]);
      expect(result.rankedRatios).toHaveLength(result.ranked.length);
      expect(result.rankedRatios[0]).toEqual(result.bestRatio);
      result.rankedRatios.forEach((ratio, row) => {
        expect(ratio.example.reduce((sum, count) => sum + count, 0)).toBe(40);
        expect(ratio.classes.map((cls) => cls.total)).toEqual(result.ranked[row]?.classTotals);
      });
    });

    it('posts only what can be cloned across the thread boundary', () => {
      const { session, posted } = harness();
      session.start();
      session.handle(motivatingRequest(SQL, 1));
      for (const message of posted) expect(structuredClone(message)).toEqual(message);
    });

    it('passes on what `optimize` refuses, as a result: an infeasible template', () => {
      const { session, posted } = harness();
      session.start();
      // Three lines of at most 3 cannot fill a deck whose remainder holds nothing.
      const { compiled, criteria } = wideProblem({ lines: 3, max: 3 });
      compiled.problem.classes[0] = { ...compiled.problem.classes[0]!, max: 0 };
      session.handle({ ...runRequest(3, { compiled, criteria }) });
      expect(posted.at(-1)).toMatchObject({
        type: 'result',
        runId: 3,
        result: { status: 'infeasible', total: 0 },
      });
    });

    it('never throws: a failure outside the search comes back as an error under the run’s id', () => {
      const { session, posted } = harness();
      session.start();
      const request = runRequest(9, SMALL);
      // The breakdown reads the criteria; these are not criteria.
      const broken = { ...request, criteria: [{ id: 'c', alternatives: null }] };
      expect(() => session.handle(broken)).not.toThrow();
      const last = posted.at(-1);
      expect(last).toMatchObject({ type: 'error', runId: 9 });
      expect(last?.type === 'error' && last.message).not.toBe('');
    });

    it.each([
      ['nothing', undefined],
      ['not an object', 'run'],
      ['an unknown type', { type: 'walk', runId: 4 }],
      ['no cancel flag', { type: 'run', runId: 4, compiled: {}, criteria: [], options: {} }],
    ])(
      'answers a message that is no run request — %s — with an error, not a throw',
      (_, message) => {
        const { session, posted } = harness();
        session.start();
        expect(() => session.handle(message)).not.toThrow();
        expect(posted.at(-1)).toMatchObject({ type: 'error' });
      },
    );

    it('names the run in the error when the malformed message named one, and -1 otherwise', () => {
      const { session, posted } = harness();
      session.start();
      session.handle({ type: 'walk', runId: 4 });
      session.handle(null);
      expect(posted.slice(1).map((message) => 'runId' in message && message.runId)).toEqual([
        4, -1,
      ]);
    });
  });
});
