import { checkHandSize, type Problem } from '../model/problem';
import { choose } from './binomial';
import { compileMatcher, type MatcherOptions } from './matcher';

/**
 * The success set (TDD §10.2): every hand composition that succeeds, found
 * ONCE per problem and hand size — it does not depend on the deck ratio (PRD
 * §4.3), so every candidate deck is scored against the same set.
 */

/** Which side to store: `auto` is the smaller one; the other two are for tests. */
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
  /** Whether `compositions` holds the hands that FAIL: the score is then `den - sum`. */
  complemented: boolean;
  /** The compositions that succeed, whichever side is stored. */
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
  const matches = compileMatcher(problem, opts);
  checkHandSize(H, problem.deckSize);
  const classCount = problem.classes.length;
  const width = classCount - 1;
  const total = countCompositions(classCount, H);

  const h = new Uint8Array(classCount);
  const succeeded = new Uint8Array(total);
  let successes = 0;
  let at = 0;
  forEachComposition(h, H, () => {
    if (matches(h, H)) {
      succeeded[at] = 1;
      successes++;
    }
    at++;
  });

  const storage = opts.storage ?? 'auto';
  const complemented =
    storage === 'auto' ? successes > total - successes : storage === 'complement';
  const stored = complemented ? 0 : 1;
  const count = complemented ? total - successes : successes;
  const compositions = new Uint8Array(count * width);
  let row = 0;
  at = 0;
  forEachComposition(h, H, () => {
    if (succeeded[at++] === stored) compositions.set(h.subarray(1), row++ * width);
  });

  return { H, classCount, width, compositions, count, complemented, successes, total };
}
