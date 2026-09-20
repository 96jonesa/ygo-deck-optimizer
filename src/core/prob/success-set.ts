import {
  checkHandSize,
  checkWeightBound,
  maxCriterionWeight,
  type Problem,
} from '../model/problem';
import { choose } from './binomial';
import { compileWeigher, type MatcherOptions } from './matcher';

/**
 * The success set (TDD §10.2): every hand composition that succeeds, found
 * ONCE per problem and hand size — it does not depend on the deck ratio (PRD
 * §4.3), so every candidate deck is scored against the same set.
 *
 * WEIGHTED CRITERIA (PRD §5.6) live here and nowhere else in the enumeration:
 * a composition is stored with what it is WORTH — the highest weight among the
 * criteria it meets — rather than with a 1, and the scorer sums `w · ways`
 * where it summed `ways`. The same walk, the same compositions, no new sample
 * space; an unweighted problem carries a 1 on every stored row and is the set
 * it always was.
 */

/**
 * Which side to store: `auto` is the smaller one; the other two are for tests.
 *
 * `complement` generalizes to weights through `Σ w · ways = W · C(N,H) − Σ (W − w) · ways`,
 * `W` being the largest weight: the rows worth the most contribute nothing to
 * the right-hand sum and are the ones left out. With `W = 1` that is exactly
 * the old "store the failures and answer `den − sum`".
 */
export type Storage = 'auto' | 'successes' | 'complement';

export interface SuccessSetOptions extends MatcherOptions {
  storage?: Storage;
}

export interface SuccessSet {
  H: number;
  /** k: the classes of the problem, the blank class included. */
  classCount: number;
  /** Entries per stored composition: `classCount - 1`. */
  width: number;
  /**
   * `count` compositions of `width` entries each, in lexicographic order: the
   * cards held of classes 1, 2, … — the blank count is `H` less their sum.
   */
  compositions: Uint8Array;
  count: number;
  /**
   * What each stored composition contributes, one per row: its own weight, or
   * `maxWeight` less its weight when `complemented`. Every entry is a positive
   * whole number — a row worth nothing is not stored — and every entry is 1 for
   * an unweighted problem, either way round.
   */
  values: Float64Array;
  /** The largest weight any criterion of the problem carries; 1 when none is weighted. */
  maxWeight: number;
  /**
   * Whether `compositions` holds the OTHER side: the score is then
   * `maxWeight · den - sum`, which for an unweighted problem is the old
   * `den - sum` over the hands that fail.
   */
  complemented: boolean;
  /** The compositions that succeed — worth anything at all — whichever side is stored. */
  successes: number;
  /** `countCompositions(classCount, H)`. */
  total: number;
}

/** The ways to hold `H` cards of `k` classes: C(H + k - 1, H). */
export function countCompositions(k: number, H: number): number {
  if (!Number.isInteger(k) || !Number.isInteger(H) || k < 1 || H < 0)
    throw new RangeError(`expected whole numbers k >= 1 and H >= 0, got ${k} and ${H}`);
  return choose(H + k - 1, H);
}

/**
 * Calls `visit` with every composition of `H` cards over `h.length` classes,
 * in lexicographic order of the non-blank counts; `h` is reused between calls.
 */
function forEachComposition(h: Uint8Array, H: number, visit: () => void): void {
  const extend = (cls: number, left: number): void => {
    if (cls === h.length) {
      h[0] = left;
      visit();
      return;
    }
    for (let held = 0; held <= left; held++) {
      h[cls] = held;
      extend(cls + 1, left - held);
    }
  };
  extend(1, H);
}

export function successSet(problem: Problem, H: number, opts: SuccessSetOptions = {}): SuccessSet {
  const weigh = compileWeigher(problem, opts);
  checkHandSize(H, problem.deckSize);
  const classCount = problem.classes.length;
  const width = classCount - 1;
  const total = countCompositions(classCount, H);
  // The bound `maxWeight` is over the WHOLE problem, not over the criteria
  // this set judges: the two sides of the store have to agree on one `W`, and
  // a part of a blend must not answer over a different one than its siblings.
  const maxWeight = maxCriterionWeight(problem);
  // `H` is an argument of its own, not read off `problem.handSizes`, so the
  // bound is checked against the hand actually being scored and not only
  // against the hands the problem declares.
  checkWeightBound(problem.deckSize, H, maxWeight);

  const h = new Uint8Array(classCount);
  const worth = new Float64Array(total);
  let successes = 0;
  /** Compositions worth less than the most one can be worth: what the other side holds. */
  let below = 0;
  let at = 0;
  forEachComposition(h, H, () => {
    const weight = weigh(h, H);
    worth[at++] = weight;
    if (weight > 0) successes++;
    if (weight < maxWeight) below++;
  });

  const storage = opts.storage ?? 'auto';
  const complemented = storage === 'auto' ? below < successes : storage === 'complement';
  const count = complemented ? below : successes;
  const compositions = new Uint8Array(count * width);
  const values = new Float64Array(count);
  let row = 0;
  at = 0;
  forEachComposition(h, H, () => {
    const weight = worth[at++]!;
    const value = complemented ? maxWeight - weight : weight;
    if (value === 0) return;
    compositions.set(h.subarray(1), row * width);
    values[row++] = value;
  });

  return {
    H,
    classCount,
    width,
    compositions,
    count,
    values,
    maxWeight,
    complemented,
    successes,
    total,
  };
}
