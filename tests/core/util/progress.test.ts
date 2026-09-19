import { describe, expect, it } from 'vitest';
import { createProgressReporter, type Progress } from '../../../src/core/util/progress';

/** A clock the test moves by hand. */
function fakeClock(start = 1000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

describe('createProgressReporter', () => {
  describe('tick', () => {
    it('stays silent until the interval has passed, then reports', () => {
      const clock = fakeClock();
      const seen: Progress[] = [];
      const reporter = createProgressReporter(100, (p) => seen.push(p), { now: clock.now });
      clock.advance(499);
      reporter.tick(10);
      expect(seen).toEqual([]);
      clock.advance(1);
      reporter.tick(20);
      expect(seen).toEqual([{ done: 20, total: 100, elapsedMs: 500, etaMs: 2000 }]);
    });

    it('measures the interval from the last REPORT, not the last call', () => {
      const clock = fakeClock();
      const seen: Progress[] = [];
      const reporter = createProgressReporter(100, (p) => seen.push(p), { now: clock.now });
      for (let done = 1; done <= 30; done++) {
        clock.advance(100);
        reporter.tick(done);
      }
      // 3,000 ms of calls every 100 ms: one report per 500 ms.
      expect(seen.map((p) => p.done)).toEqual([5, 10, 15, 20, 25, 30]);
    });

    it('honours a custom interval', () => {
      const clock = fakeClock();
      const seen: Progress[] = [];
      const reporter = createProgressReporter(10, (p) => seen.push(p), {
        now: clock.now,
        intervalMs: 100,
      });
      clock.advance(100);
      reporter.tick(1);
      expect(seen).toHaveLength(1);
    });

    it('reports an ETA of 0 when nothing has been done yet', () => {
      const clock = fakeClock();
      const seen: Progress[] = [];
      const reporter = createProgressReporter(100, (p) => seen.push(p), { now: clock.now });
      clock.advance(600);
      reporter.tick(0);
      expect(seen).toEqual([{ done: 0, total: 100, elapsedMs: 600, etaMs: 0 }]);
    });
  });

  describe('finish', () => {
    it('reports done === total whatever the interval says', () => {
      const clock = fakeClock();
      const seen: Progress[] = [];
      const reporter = createProgressReporter(100, (p) => seen.push(p), { now: clock.now });
      clock.advance(3);
      reporter.finish();
      expect(seen).toEqual([{ done: 100, total: 100, elapsedMs: 3, etaMs: 0 }]);
    });
  });

  it('does nothing, and never reads the clock, without a callback', () => {
    const reporter = createProgressReporter(100, undefined, {
      now: () => {
        throw new Error('the clock was read');
      },
    });
    reporter.tick(50);
    reporter.finish();
  });

  it('defaults to the wall clock', () => {
    const seen: Progress[] = [];
    const reporter = createProgressReporter(4, (p) => seen.push(p));
    reporter.finish();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ done: 4, total: 4, etaMs: 0 });
    expect(seen[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
