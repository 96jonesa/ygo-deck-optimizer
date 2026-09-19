/**
 * What the exact engine scores (TDD §8): a template with everything symbolic
 * resolved into CLASSES of interchangeable cards and bitmasks over them, so
 * that scoring never touches a description again. `compile` produces it;
 * `src/core/prob` consumes it.
 */

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

export interface CompiledCriterion {
  /** One class bitmask per requirement slot — `n×` is `n` slots: the classes that can fill it. */
  slots: number[];
  limits: CompiledLimit[];
}

export interface HandSize {
  H: number;
  /**
   * The hand size's share of a first/second blend, as a RATIO of positive
   * whole numbers — `1 : 1` for a coin flip, `3 : 2` for going first 60% of
   * the time — never a fraction of 1: blends are ranked in exact integers.
   */
  weight: number;
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
  for (const { H, weight } of handSizes) {
    checkHandSize(H, deckSize);
    if (seen.has(H)) throw new RangeError(`hand size ${H} appears twice`);
    seen.add(H);
    if (!Number.isInteger(weight) || weight < 1)
      throw new RangeError(
        `hand size ${H}: a weight is a positive whole number — a blend is a ratio such as 1 : 1 — not ${weight}`,
      );
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

  criteria.forEach(({ slots, limits }, criterion) => {
    slots.forEach((mask, slot) => {
      checkMask(mask, classes.length, `criterion ${criterion}, slot ${slot}`, 'fill a requirement');
    });
    limits.forEach(({ mask, n }, limit) => {
      const where = `criterion ${criterion}, limit ${limit}`;
      checkMask(mask, classes.length, where, 'count against a limit');
      if (!isCount(n))
        throw new RangeError(`${where}: a limit's count is a whole number, not ${n}`);
    });
  });
}
