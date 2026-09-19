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

/** Whether `h` — cards held of each class, blank included — meets `criterion`, slot by slot. */
export function bruteForceMeets(criterion: CompiledCriterion, h: ArrayLike<number>): boolean {
  const classCount = h.length;
  for (const { mask, n } of criterion.limits) {
    let counted = 0;
    for (const cls of classesOf(mask, classCount)) counted += h[cls]!;
    if (counted > n) return false;
  }
  const left = Array.from({ length: classCount }, (_, cls) => h[cls]!);
  const fillers = criterion.slots.map((mask) => classesOf(mask, classCount));
  const assign = (slot: number): boolean => {
    if (slot === fillers.length) return true;
    for (const cls of fillers[slot]!) {
      if (left[cls]! === 0) continue;
      left[cls]!--;
      const done = assign(slot + 1);
      left[cls]!++;
      if (done) return true;
    }
    return false;
  };
  return assign(0);
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
