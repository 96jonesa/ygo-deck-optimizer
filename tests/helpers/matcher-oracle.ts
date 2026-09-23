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
 * A `unique` requirement takes at most ONE card of each class — a class in its
 * mask is one card, however many copies (`compileProblem` makes it so) — and is
 * met by holding cards of `n` different classes. Without a `max` it is no
 * ceiling: a card it could take is free to go unassigned. WITH one it holds at
 * most `max` classes, and a card left unassigned that it could take must be of
 * a class it DOES hold — another copy of a card already counted, and not a new
 * different card. That is a question about where the search ENDS, not where it
 * is, so it is asked once every card is placed.
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
  const uniques = criterion.uniques ?? [];
  /** The cards the hand holds, one entry each, as the class they are of. */
  const cards = classesOf(2 ** classCount - 1, classCount).flatMap((cls) =>
    new Array<number>(h[cls]!).fill(cls),
  );
  const taken = reqs.map(() => 0);
  /** The classes each `unique` requirement holds a card of: one card of each, never two. */
  const holding = uniques.map(() => new Set<number>());
  /** A card of this class must go somewhere: some capped requirement would otherwise count it. */
  const trapped = (cls: number) =>
    reqs.some(({ mask, max }) => max !== null && (mask & (1 << cls)) !== 0);
  /** The cards given to nothing so far, for the capped `unique` requirements to judge at the end. */
  const left: number[] = [];

  const place = (at: number): boolean => {
    if (at === cards.length)
      return (
        reqs.every(({ min }, req) => taken[req]! >= min) &&
        uniques.every(({ n }, req) => holding[req]!.size >= n) &&
        left.every((cls) =>
          uniques.every(
            ({ mask, max }, req) =>
              max === undefined || (mask & (1 << cls)) === 0 || holding[req]!.has(cls),
          ),
        )
      );
    const cls = cards[at]!;
    for (let req = 0; req < reqs.length; req++) {
      const { mask, max } = reqs[req]!;
      if ((mask & (1 << cls)) === 0 || (max !== null && taken[req]! >= max)) continue;
      taken[req]!++;
      const done = place(at + 1);
      taken[req]!--;
      if (done) return true;
    }
    for (let req = 0; req < uniques.length; req++) {
      const { mask, max } = uniques[req]!;
      if ((mask & (1 << cls)) === 0 || holding[req]!.has(cls)) continue;
      if (max !== undefined && holding[req]!.size >= max) continue;
      holding[req]!.add(cls);
      const done = place(at + 1);
      holding[req]!.delete(cls);
      if (done) return true;
    }
    if (trapped(cls)) return false;
    left.push(cls);
    const done = place(at + 1);
    left.pop();
    return done;
  };
  return place(0);
}

export function bruteForceSucceeds(problem: Problem, h: ArrayLike<number>): boolean {
  return problem.criteria.some((criterion) => bruteForceMeets(criterion, h));
}

/**
 * What one hand is WORTH: the highest weight among the criteria it meets, and
 * 0 when it meets none (PRD §5.6 weighting). Every criterion is asked — there
 * is no ordering and no short circuit here, which is the whole of what the
 * engine's weigher does differently.
 */
export function bruteForceWeight(problem: Problem, h: ArrayLike<number>): number {
  let best = 0;
  for (const criterion of problem.criteria)
    if (bruteForceMeets(criterion, h)) best = Math.max(best, criterion.weight ?? 1);
  return best;
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

/**
 * The weighted numerator the slow way, in BigInt: `Σ_h w(h) · Π_c C(n_c, h_c)`
 * over every composition, `w` being the highest weight of the criteria the
 * composition meets. It owes nothing to the success set — no storage side, no
 * complement, no sorting — and nothing to float64, so it is also the check that
 * the engine's exact integer really is the integer.
 */
export function referenceWeightedNumerator(
  problem: Problem,
  n: ArrayLike<number>,
  H: number,
): bigint {
  let sum = 0n;
  for (const h of compositions(problem.classes.length, H)) {
    const weight = bruteForceWeight(problem, h);
    if (weight === 0) continue;
    let ways = 1n;
    h.forEach((held, cls) => {
      ways *= BigInt(choose(n[cls]!, held));
    });
    sum += BigInt(weight) * ways;
  }
  return sum;
}
