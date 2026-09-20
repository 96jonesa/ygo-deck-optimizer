import {
  checkHandSize,
  checkWeightBound,
  maxCriterionWeight,
  outcomesOf,
  type Problem,
} from '../model/problem';
import { choose } from './binomial';
import { compileValuer, type MatcherOptions, type Worth } from './matcher';

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
 *
 * THE SIXTH CARD (PRD §5.6) generalises the stored value once more, and again
 * not the enumeration. Where the hand's last card is drawn separately a set of
 * `H` cards is `H` outcomes rather than one, so a composition is stored with
 * what all of them are worth together — `Σ_c h_c · best(h − e_c, c)`, which
 * `compileValuer` computes — over a denominator `H` times as large. The walk,
 * the compositions and the scorer's inner loop are untouched: a split costs
 * one pass at build time and nothing per deck.
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
   * What each stored composition contributes, one per row: its own value, or
   * `maxValue` less its value when `complemented`. Every entry is a positive
   * whole number — a row worth nothing is not stored — and every entry is 1 for
   * an unweighted problem whose hand draws no card of its own, either way round.
   */
  values: Float64Array;
  /**
   * Parallel to `values`: what each stored composition contributes to the
   * PLAIN success count — how many of its outcomes meet any criterion at all,
   * or `maxPlain` less that when `complemented`. Equal to `values` exactly
   * when nothing is weighted, which is why an unweighted run pays for one walk.
   */
  plains: Float64Array;
  /** The largest weight any criterion of the problem carries; 1 when none is weighted. */
  maxWeight: number;
  /** `outcomesOf` the hand: `H` when the sixth card is drawn separately, else 1. */
  outcomes: number;
  /** The most one composition can be worth: `outcomes · maxWeight`. */
  maxValue: number;
  /** The most one composition's plain value can be, which is `outcomes`. */
  maxPlain: number;
  /**
   * Whether `compositions` holds the OTHER side: the score is then
   * `maxValue · ways - sum`, which for an unweighted problem drawing no card
   * of its own is the old `den - sum` over the hands that fail.
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
  checkHandSize(H, problem.deckSize);
  const classCount = problem.classes.length;
  const width = classCount - 1;
  const total = countCompositions(classCount, H);
  // Whether the hand's last card is DRAWN is a property of the hand and comes
  // off the problem's own declaration of it — `partProblem` carries it into
  // every part — rather than off the criteria this set happens to judge, so
  // that every score of one run is a fraction over one denominator.
  const outcomes = outcomesOf(problem.handSizes.find((hand) => hand.H === H) ?? { H });
  const valuer = compileValuer(problem, H, { ...opts, drawn: outcomes > 1 });
  // The bound `maxWeight` is over the WHOLE problem, not over the criteria
  // this set judges: the two sides of the store have to agree on one `W`, and
  // a part of a blend must not answer over a different one than its siblings.
  const maxWeight = maxCriterionWeight(problem);
  const maxValue = outcomes * maxWeight;
  const maxPlain = outcomes;
  // `H` is an argument of its own, not read off `problem.handSizes`, so the
  // bound is checked against the hand actually being scored and not only
  // against the hands the problem declares.
  checkWeightBound(problem.deckSize, H, maxWeight, outcomes);

  const h = new Uint8Array(classCount);
  const worth = new Float64Array(total);
  const plainly = new Float64Array(total);
  const into: Worth = { value: 0, plain: 0 };
  let successes = 0;
  /** Compositions worth less than the most one can be worth: what the other side holds. */
  let below = 0;
  let at = 0;
  forEachComposition(h, H, () => {
    valuer.worth(h, into);
    plainly[at] = into.plain;
    worth[at++] = into.value;
    if (into.value > 0) successes++;
    if (into.value < maxValue) below++;
  });

  const storage = opts.storage ?? 'auto';
  const complemented = storage === 'auto' ? below < successes : storage === 'complement';
  const count = complemented ? below : successes;
  const compositions = new Uint8Array(count * width);
  const values = new Float64Array(count);
  const plains = new Float64Array(count);
  let row = 0;
  at = 0;
  forEachComposition(h, H, () => {
    const value = complemented ? maxValue - worth[at]! : worth[at]!;
    const plain = complemented ? maxPlain - plainly[at]! : plainly[at]!;
    at++;
    // A row worth nothing contributes nothing to EITHER sum: a composition
    // worth the most on the weighted side is worth the most on the plain side
    // too, since every one of its outcomes met a criterion to get there.
    if (value === 0) return;
    compositions.set(h.subarray(1), row * width);
    plains[row] = plain;
    values[row++] = value;
  });

  return {
    H,
    classCount,
    width,
    compositions,
    count,
    values,
    plains,
    maxWeight,
    outcomes,
    maxValue,
    maxPlain,
    complemented,
    successes,
    total,
  };
}
