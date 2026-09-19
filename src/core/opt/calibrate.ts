import { type CostModel, DEFAULT_COST } from '../model/analyze';
import type { Problem } from '../model/problem';
import { createScorer, type Scorer } from '../prob/scorer';
import { type Count, countToNumber } from '../util/count';

/**
 * What a score costs on THIS machine (TDD §11.3): the wall in front of an
 * infeasible search needs an estimate before the search starts, so the scorer
 * is timed once, at startup, on two synthetic problems — few terms and many —
 * and a line is put through the two: `perVectorUs + perTermNs × terms`.
 */

export interface CalibrationSample {
  /** `Scorer.terms` of the problem timed. */
  terms: number;
  calls: number;
  elapsedMs: number;
}

export interface Calibration {
  cost: CostModel;
  samples: CalibrationSample[];
}

export interface CalibrateOptions {
  /** The clock, in milliseconds — fractions welcome; injected by tests. Default `Date.now`. */
  now?: () => number;
  /** How long to time each sample for. Default 20 ms: `Date.now` ticks in whole milliseconds. */
  minMs?: number;
  /** Calls between two readings of the clock. Default 64. */
  batch?: number;
}

const DECK = 40;
const HAND = 5;

/** `classCount` classes, any card of a non-blank one succeeding: all but one composition is a term. */
function benchmark(classCount: number): { scorer: Scorer; totals: Int32Array } {
  const problem: Problem = {
    deckSize: DECK,
    handSizes: [{ H: HAND, weight: 1 }],
    classes: Array.from({ length: classCount }, () => ({ lineIds: [], min: 0, max: DECK })),
    criteria: [{ slots: [2 ** classCount - 2], limits: [] }],
  };
  const totals = new Int32Array(classCount).fill(Math.floor(DECK / classCount));
  totals[0]! += DECK % classCount;
  // The successes, not the single failing hand: the point is a known, large number of terms.
  return { scorer: createScorer(problem, HAND, { storage: 'successes' }), totals };
}

/** The line through two samples; the benchmarked default when the clock could not tell them apart. */
export function fitCost(samples: readonly CalibrationSample[]): CostModel {
  const [small, large] = samples as [CalibrationSample, CalibrationSample];
  const nsPerCall = ({ calls, elapsedMs }: CalibrationSample) => (elapsedMs * 1e6) / calls;
  const perTermNs = (nsPerCall(large) - nsPerCall(small)) / (large.terms - small.terms);
  if (!(perTermNs > 0) || !Number.isFinite(perTermNs)) return DEFAULT_COST;
  return {
    perVectorUs: Math.max(0, nsPerCall(small) - perTermNs * small.terms) / 1000,
    perTermNs,
  };
}

export function calibrateCost(opts: CalibrateOptions = {}): Calibration {
  const now = opts.now ?? Date.now;
  const minMs = opts.minMs ?? 20;
  const batch = opts.batch ?? 64;
  const samples = [3, 12].map((classCount): CalibrationSample => {
    const { scorer, totals } = benchmark(classCount);
    const start = now();
    let calls = 0;
    let elapsedMs = 0;
    while (elapsedMs < minMs) {
      for (let call = 0; call < batch; call++) scorer.numerator(totals);
      calls += batch;
      elapsedMs = now() - start;
    }
    return { terms: scorer.terms, calls, elapsedMs };
  });
  return { cost: fitCost(samples), samples };
}

/** The time a search of `vectors` class vectors takes, scoring each at every hand size (TDD §11.3). */
export function estimateMs(vectors: Count, terms: readonly number[], cost: CostModel): number {
  const perVectorNs = terms.reduce(
    (sum, count) => sum + cost.perVectorUs * 1000 + cost.perTermNs * count,
    0,
  );
  return (countToNumber(vectors) * perVectorNs) / 1e6;
}
