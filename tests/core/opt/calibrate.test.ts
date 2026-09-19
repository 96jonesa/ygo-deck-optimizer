import { describe, expect, it } from 'vitest';
import { calibrateCost, estimateMs, fitCost } from '../../../src/core/opt/calibrate';

/** A clock that moves only when it is read: `stepMs(read)` further at each read, the reads counted from 0. */
function steppingClock(stepMs: (read: number) => number) {
  let at = 5_000;
  let reads = 0;
  return {
    now: () => {
      at += stepMs(reads++);
      return at;
    },
    reads: () => reads,
  };
}

describe('fitCost', () => {
  it('fits cost = perVector + perTerm · terms through the two samples', () => {
    // 100 terms cost 650 ns a call, 1,100 terms 6,650 ns: 6 ns a term on top of 50 ns.
    const cost = fitCost([
      { terms: 100, calls: 1000, elapsedMs: 0.65 },
      { terms: 1100, calls: 1000, elapsedMs: 6.65 },
    ]);
    expect(cost.perTermNs).toBeCloseTo(6, 9);
    expect(cost.perVectorUs).toBeCloseTo(0.05, 9);
  });

  it('never reports a negative fixed cost', () => {
    const cost = fitCost([
      { terms: 100, calls: 1000, elapsedMs: 0.1 },
      { terms: 1100, calls: 1000, elapsedMs: 6.6 },
    ]);
    expect(cost.perVectorUs).toBe(0);
    expect(cost.perTermNs).toBeCloseTo(6.5, 9);
  });

  it('falls back to the benchmarked default when the clock could not tell the samples apart', () => {
    const flat = fitCost([
      { terms: 100, calls: 1000, elapsedMs: 5 },
      { terms: 1100, calls: 1000, elapsedMs: 5 },
    ]);
    expect(flat).toEqual({ perVectorUs: 0.05, perTermNs: 6 });
    const unread = fitCost([
      { terms: 100, calls: 1000, elapsedMs: 0 },
      { terms: 1100, calls: 1000, elapsedMs: 0 },
    ]);
    expect(unread).toEqual({ perVectorUs: 0.05, perTermNs: 6 });
  });
});

describe('calibrateCost', () => {
  it('times a small and a large scorer on the injected clock until each has run long enough', () => {
    // One read to start each sample, then one per batch: the first sample's batches
    // seem to take 1 ms each, the second's 5 ms.
    const clock = steppingClock((read) => (read <= 20 ? 1 : 5));
    const { cost, samples } = calibrateCost({ now: clock.now, minMs: 20, batch: 10 });
    expect(samples).toHaveLength(2);
    const [small, large] = samples as [(typeof samples)[0], (typeof samples)[0]];
    expect(small.terms).toBeLessThan(large.terms);
    expect(small).toMatchObject({ calls: 200, elapsedMs: 20 });
    expect(large).toMatchObject({ calls: 40, elapsedMs: 20 });
    expect(cost).toEqual(fitCost(samples));
    expect(clock.reads()).toBe(21 + 5);
  });

  it('measures something plausible on the real clock', () => {
    const { cost } = calibrateCost({ minMs: 5 });
    expect(cost.perTermNs).toBeGreaterThan(0);
    expect(cost.perTermNs).toBeLessThan(1000);
    expect(cost.perVectorUs).toBeGreaterThanOrEqual(0);
  });
});

describe('estimateMs', () => {
  it('is vectors × (the fixed cost + the per-term cost × terms), summed over hand sizes', () => {
    const cost = { perVectorUs: 0.05, perTermNs: 6 };
    // 1e6 vectors × (0.05 µs + 100 × 6 ns) = 1e6 × 0.65 µs = 650 ms.
    expect(estimateMs(1_000_000, [100], cost)).toBeCloseTo(650, 9);
    expect(estimateMs(1_000_000, [100, 1100], cost)).toBeCloseTo(650 + 6650, 9);
  });

  it('takes a count past 2^53 as its nearest float', () => {
    expect(estimateMs('48000000000000000000', [0], { perVectorUs: 1, perTermNs: 0 })).toBeCloseTo(
      4.8e16,
      -6,
    );
  });
});
