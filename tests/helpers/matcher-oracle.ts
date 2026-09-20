import type { CompiledCriterion, Problem } from '../../src/core/model/problem';
import { choose, compositions } from './combinatorics';

/**
 * The oracles for the hand matcher and the scorer at the level of CLASSES
 * (TDD §15.1): brute-force assignment where the engine checks Hall's
 * condition, a plain walk over every composition where it keeps a success
 * set, and the multiplicative binomial where it reads Pascal's table.
 */

function classesOf(mask: number, classCount: number): number[] {
  const out: number[] = [];
  for (let cls = 0; cls < classCount; cls++)
    if (Math.floor(mask / 2 ** cls) % 2 === 1) out.push(cls);
  return out;
}

/**
 * Whether `h` — cards held of each class, blank included — meets `criterion`.
 *
 * Every limit is counted over the whole hand, then the cards are handed out
 * one at a time by exhaustive search: a card of class `c` may go to any slot
 * or ceiling whose mask holds `c` and that still has room, or to nothing at
 * all — the last only when no CEILING would have had to count it, which is
 * rule 3 of `FlatCriterion`. A slot is a unit of lower bound, so a slot is
 * satisfied by having been filled, and a ceiling by not overflowing; a
 * requirement that is both contributes its slots and its ceiling separately,
 * and the search may put a card in either.
 *
 * It owes nothing to the matcher, which answers the same question by counting
 * classes against precomputed subset conditions and never searches.
 */
export function bruteForceMeets(criterion: CompiledCriterion, h: ArrayLike<number>): boolean {
  const classCount = h.length;
  for (const { mask, n } of criterion.limits) {
    let counted = 0;
    for (const cls of classesOf(mask, classCount)) counted += h[cls]!;
    if (counted > n) return false;
  }
  // A criterion without ceilings says everything in `slots`: one requirement
  // of exactly one card each, none of them capped.
  const reqs = criterion.reqs ?? criterion.slots.map((mask) => ({ mask, min: 1, max: null }));
  /** The cards the hand holds, one entry each, as the class they are of. */
  const cards = classesOf(2 ** classCount - 1, classCount).flatMap((cls) =>
    new Array<number>(h[cls]!).fill(cls),
  );
  const taken = reqs.map(() => 0);
  /** A card of this class must go somewhere: some capped requirement would otherwise count it. */
  const trapped = (cls: number) =>
    reqs.some(({ mask, max }) => max !== null && (mask & (1 << cls)) !== 0);

  const place = (at: number): boolean => {
    if (at === cards.length) return reqs.every(({ min }, req) => taken[req]! >= min);
    const cls = cards[at]!;
    for (let req = 0; req < reqs.length; req++) {
      const { mask, max } = reqs[req]!;
      if ((mask & (1 << cls)) === 0 || (max !== null && taken[req]! >= max)) continue;
      taken[req]!++;
      const done = place(at + 1);
      taken[req]!--;
      if (done) return true;
    }
    return !trapped(cls) && place(at + 1);
  };
  return place(0);
}

export function bruteForceSucceeds(problem: Problem, h: ArrayLike<number>): boolean {
  return problem.criteria.some((criterion) => bruteForceMeets(criterion, h));
}

/** The exact numerator the slow way: every composition of `H`, judged by brute force. */
export function referenceNumerator(problem: Problem, n: ArrayLike<number>, H: number): number {
  let sum = 0;
  for (const h of compositions(problem.classes.length, H)) {
    if (!bruteForceSucceeds(problem, h)) continue;
    let ways = 1;
    h.forEach((held, cls) => {
      ways *= choose(n[cls]!, held);
    });
    sum += ways;
  }
  return sum;
}
