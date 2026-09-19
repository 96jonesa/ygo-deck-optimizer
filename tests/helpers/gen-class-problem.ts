import type { CompiledCriterion, Problem } from '../../src/core/model/problem';
import type { Rng } from './prng';

/** Inclusive ranges. */
export interface GenClassProblemOptions {
  /** Classes, the blank class included. */
  classes: readonly [number, number];
  deckSize: readonly [number, number];
  handSize: readonly [number, number];
  /** Slots of a criterion; above the hand size on purpose now and then. */
  slots: readonly [number, number];
  criteria: readonly [number, number];
}

export interface GeneratedClassProblem {
  problem: Problem;
  H: number;
  /** Class totals, blank first, summing to the deck size. */
  totals: number[];
}

/** A set of NON-blank classes, as a mask; empty now and then, as a slot no line fills is. */
export function genMask(rng: Rng, classCount: number, density = 0.4): number {
  let mask = 0;
  for (let cls = 1; cls < classCount; cls++) if (rng.chance(density)) mask |= 1 << cls;
  return mask >>> 0;
}

export function genCriterion(
  rng: Rng,
  classCount: number,
  slots: readonly [number, number],
): CompiledCriterion {
  return {
    slots: Array.from({ length: rng.int(...slots) }, () => genMask(rng, classCount)),
    limits: Array.from({ length: rng.pick([0, 0, 1, 1, 2]) }, () => ({
      mask: genMask(rng, classCount),
      n: rng.pick([0, 0, 1, 1, 2, 3]),
    })),
  };
}

/** Class totals summing to `deckSize`: a few cards in each class, the blank class taking the rest. */
export function genTotals(rng: Rng, classCount: number, deckSize: number): number[] {
  for (;;) {
    const totals = Array.from({ length: classCount }, () => rng.int(0, 4));
    const others = totals.slice(1).reduce((sum, n) => sum + n, 0);
    if (others > deckSize) continue;
    totals[0] = deckSize - others;
    return totals;
  }
}

/** A problem written directly over classes and masks: what `compile` will hand the engine. */
export function genClassProblem(rng: Rng, options: GenClassProblemOptions): GeneratedClassProblem {
  const classCount = rng.int(...options.classes);
  const deckSize = rng.int(...options.deckSize);
  const H = rng.int(...options.handSize);
  const problem: Problem = {
    deckSize,
    handSizes: [{ H, weight: 1 }],
    classes: Array.from({ length: classCount }, (_, cls) => ({
      lineIds: [`class${cls}`],
      min: 0,
      max: deckSize,
    })),
    criteria: Array.from({ length: rng.int(...options.criteria) }, () =>
      genCriterion(rng, classCount, options.slots),
    ),
  };
  return { problem, H, totals: genTotals(rng, classCount, deckSize) };
}
