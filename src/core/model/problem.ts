/**
 * What the exact engine scores (TDD §8): a template with everything symbolic
 * resolved into CLASSES of interchangeable cards and bitmasks over them, so
 * that scoring never touches a description again. `compile` produces it;
 * `src/core/prob` consumes it.
 */

import { MAX_RANGES } from '../criteria/ast';

/** Classes, the blank class included: a class mask is a non-negative 32-bit integer. */
export const MAX_CLASSES = 30;

/**
 * The largest deck and hand the engine scores. Exactness rests on them (TDD
 * §10.3): every numerator is at most C(60, 6) = 50,063,860, far below 2^53.
 */
export const MAX_DECK_SIZE = 60;
export const MAX_HAND_SIZE = 6;

/** Bit 0: the blank class, which fills no requirement and counts against no limit. */
export const BLANK_BIT = 1;

export interface ClassInfo {
  /** The template lines merged into this class; the blank class may have none. */
  lineIds: string[];
  /** The range of the class TOTAL: the sum of its lines' ranges. */
  min: number;
  max: number;
}

export interface CompiledLimit {
  /** The classes whose cards count against the limit. */
  mask: number;
  n: number;
}

/** One requirement: between `min` and `max` of the hand's cards of `mask` are assigned to it. */
export interface CompiledRequirement {
  /** The classes that fill it. */
  mask: number;
  min: number;
  /** `null` is no ceiling, which is what a plain `n×` means. */
  max: number | null;
}

export interface CompiledCriterion {
  /**
   * One class bitmask per requirement slot: the classes that can fill it.
   * A requirement contributes its LOWER bound in slots — `n×` is `n` slots,
   * and `0-2×` is none. This is all a criterion without ceilings needs.
   */
  slots: number[];
  limits: CompiledLimit[];
  /**
   * Every requirement of the criterion, whole — present only when one of them
   * has a ceiling that can bind, so that a criterion in the language as it was
   * is byte for byte what it always was. `slots` is exactly these expanded by
   * their lower bounds, and `validateProblem` holds the two to that.
   *
   * A ceiling cannot be read off `slots`, and neither can it be kept apart
   * from its own lower bound: `1-2×` takes two cards in total, not one for its
   * slot and two more under its ceiling.
   */
  reqs?: CompiledRequirement[];
}

export interface HandSize {
  H: number;
  /**
   * The hand size's share of a first/second blend, as a RATIO of positive
   * whole numbers — `1 : 1` for a coin flip, `3 : 2` for going first 60% of
   * the time — never a fraction of 1: blends are ranked in exact integers.
   */
  weight: number;
  /**
   * Which of `Problem.criteria` this hand is judged against — indices, not
   * criteria — when the two hands are judged against different ones (PRD
   * §5.5: going first over the criteria for going first). Absent: all of them,
   * which is every problem that has one hand size and every blend of criteria
   * that apply either way.
   *
   * INDICES, and not a criteria list of its own, because the two hands must
   * score the SAME deck: a class vector means what `classes` says it means,
   * and a criterion compiled against other classes would read the same vector
   * as a different deck. Sharing one `criteria` list makes that unsayable
   * rather than merely untrue — and `partProblem` is the only way a part's
   * criteria are ever taken out of it.
   */
  criteria?: number[];
}

export interface Problem {
  /** N. */
  deckSize: number;
  /** `[{ H: 5, weight: 1 }]`, or a first/second blend. */
  handSizes: HandSize[];
  /** Index 0 is ALWAYS the blank class, even when it holds no card. */
  classes: ClassInfo[];
  /** Flat: a hand succeeds if it meets ANY of these. */
  criteria: CompiledCriterion[];
}

const isCount = (value: number) => Number.isInteger(value) && value >= 0;

function checkMask(mask: number, classCount: number, where: string, role: string): void {
  if (!isCount(mask))
    throw new RangeError(`${where}: a class mask is a non-negative whole number, not ${mask}`);
  if (mask >= 2 ** classCount)
    throw new RangeError(
      `${where}: the mask ${mask.toString(2)} names a class the problem does not have — it has only ${classCount} classes`,
    );
  if (mask % 2 === BLANK_BIT)
    throw new RangeError(`${where}: the blank class (bit 0) cannot ${role}`);
}

/** Throws unless `H` is a hand the engine can score from a deck of `deckSize`. */
export function checkHandSize(H: number, deckSize: number): void {
  if (!Number.isInteger(H) || H < 1 || H > MAX_HAND_SIZE || H > deckSize)
    throw new RangeError(
      `a hand size is a whole number from 1 to ${Math.min(MAX_HAND_SIZE, deckSize)}, not ${H}`,
    );
}

/**
 * Throws a `RangeError` naming the first thing wrong with `problem`. The
 * engine's entry points call it, so a malformed problem is an error where it
 * enters and never a silently wrong probability.
 */
export function validateProblem(problem: Problem): void {
  const { deckSize, handSizes, classes, criteria } = problem;
  if (!Number.isInteger(deckSize) || deckSize < 1 || deckSize > MAX_DECK_SIZE)
    throw new RangeError(
      `the deck size is a whole number from 1 to ${MAX_DECK_SIZE}, not ${deckSize}`,
    );

  if (handSizes.length === 0) throw new RangeError('a problem needs at least one hand size');
  const seen = new Set<number>();
  for (const { H, weight, criteria: own } of handSizes) {
    checkHandSize(H, deckSize);
    if (seen.has(H)) throw new RangeError(`hand size ${H} appears twice`);
    seen.add(H);
    if (!Number.isInteger(weight) || weight < 1)
      throw new RangeError(
        `hand size ${H}: a weight is a positive whole number — a blend is a ratio such as 1 : 1 — not ${weight}`,
      );
    if (own === undefined) continue;
    const taken = new Set<number>();
    for (const at of own) {
      if (!Number.isInteger(at) || at < 0 || at >= criteria.length)
        throw new RangeError(
          `hand size ${H}: \`criteria\` holds ${at}, which is not one of the problem's ${criteria.length} criteria`,
        );
      if (taken.has(at)) throw new RangeError(`hand size ${H}: criterion ${at} appears twice`);
      taken.add(at);
    }
  }

  if (classes.length === 0)
    throw new RangeError('a problem has at least the blank class, at index 0');
  if (classes.length > MAX_CLASSES)
    throw new RangeError(
      `a problem has at most ${MAX_CLASSES} classes, the blank class included, not ${classes.length}`,
    );
  classes.forEach(({ min, max }, cls) => {
    if (!isCount(min) || !isCount(max) || min > max)
      throw new RangeError(
        `class ${cls}: a range is 0 <= min <= max in whole cards, not ${min} to ${max}`,
      );
  });

  criteria.forEach(({ slots, limits, reqs }, criterion) => {
    slots.forEach((mask, slot) => {
      checkMask(mask, classes.length, `criterion ${criterion}, slot ${slot}`, 'fill a requirement');
    });
    limits.forEach(({ mask, n }, limit) => {
      const where = `criterion ${criterion}, limit ${limit}`;
      checkMask(mask, classes.length, where, 'count against a limit');
      if (!isCount(n))
        throw new RangeError(`${where}: a limit's count is a whole number, not ${n}`);
    });
    if (reqs === undefined) return;
    checkRequirements(reqs, slots, classes.length, criterion);
  });
}

/**
 * ONE part of a blend as a problem in its own right: the same deck, **the same
 * classes**, and only the criteria that part is judged against (TDD §10.3).
 *
 * The classes are the same object, not a copy of one: that is what makes the
 * two parts of an average score the same deck. A class vector is meaningless
 * on its own — it is `classes` that says which cards a total counts — so two
 * parts built from two class lists would be averaging two different decks, and
 * nothing downstream could tell. Here, `n` is handed to both scorers unchanged
 * and both read it against the list it came from.
 *
 * What differs is the SUCCESS SET, and only that: each part keeps its own
 * criteria, so a hand of five is judged by the criteria for going first and a
 * hand of six by those for going second.
 */
export function partProblem(problem: Problem, hand: HandSize): Problem {
  return {
    deckSize: problem.deckSize,
    handSizes: [{ H: hand.H, weight: 1 }],
    classes: problem.classes,
    criteria:
      hand.criteria === undefined
        ? problem.criteria
        : hand.criteria.map((at) => {
            const criterion = problem.criteria[at];
            if (criterion === undefined)
              throw new RangeError(
                `hand size ${hand.H}: there is no criterion ${at} — the problem has ${problem.criteria.length}`,
              );
            return criterion;
          }),
  };
}

/** The multiset of slot masks, as a string that two equal multisets share. */
const slotKey = (masks: readonly number[]) => [...masks].sort((a, b) => a - b).join(',');

/**
 * `reqs` is only there for the ceilings, and it may not quietly say something
 * else than `slots` does: the two are one requirement list, read two ways.
 */
function checkRequirements(
  reqs: readonly CompiledRequirement[],
  slots: readonly number[],
  classCount: number,
  criterion: number,
): void {
  const ceilings = reqs.filter(({ max }) => max !== null).length;
  if (ceilings === 0)
    throw new RangeError(
      `criterion ${criterion}: with no ceiling to keep, \`reqs\` is left out and \`slots\` says it all`,
    );
  if (ceilings > MAX_RANGES)
    throw new RangeError(
      `criterion ${criterion}: the engine judges at most ${MAX_RANGES} range requirements, not ${ceilings}`,
    );
  reqs.forEach(({ mask, min, max }, at) => {
    const where = `criterion ${criterion}, requirement ${at}`;
    checkMask(mask, classCount, where, 'fill a requirement');
    if (!isCount(min))
      throw new RangeError(`${where}: a lower bound is a whole number, not ${min}`);
    if (max === null) return;
    if (!isCount(max) || max < min)
      throw new RangeError(
        `${where}: a range is 0 <= min <= max in whole cards, not ${min} to ${max}`,
      );
    if (mask === 0)
      throw new RangeError(`${where}: a ceiling no class can reach binds nothing and is dropped`);
  });
  const expanded = reqs.flatMap(({ mask, min }) => new Array<number>(min).fill(mask));
  if (slotKey(expanded) !== slotKey(slots))
    throw new RangeError(
      `criterion ${criterion}: \`slots\` must be the requirements' lower bounds expanded — ${expanded.length} slot(s) expected, ${slots.length} given`,
    );
}
