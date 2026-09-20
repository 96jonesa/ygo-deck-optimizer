/**
 * What the exact engine scores (TDD §8): a template with everything symbolic
 * resolved into CLASSES of interchangeable cards and bitmasks over them, so
 * that scoring never touches a description again. `compile` produces it;
 * `src/core/prob` consumes it.
 */

import { MAX_RANGES, MAX_SIXTH_SLOTS } from '../criteria/ast';
import { choose } from '../prob/binomial';

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

/**
 * The SIXTH CARD's part of a split criterion: the same three fields, judged
 * against the ONE card drawn (PRD §5.6). `slots` holds at most one mask — it
 * is one card — and a limit there is a census over that card alone, so `no
 * trap` says the card drawn is not a trap. A ceiling of 1 or more, and a limit
 * of 1 or more, can never bind on one card and `compile` drops them.
 */
export interface SixthCard {
  slots: number[];
  limits: CompiledLimit[];
  reqs?: CompiledRequirement[];
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
  /**
   * What a hand meeting it is WORTH (PRD §5.6, weighted criteria). A positive
   * whole number; absent is 1, which is every criterion of an unweighted run
   * and is why such a run is byte for byte what it always was.
   *
   * A hand meeting several criteria is worth the HIGHEST of their weights, not
   * their sum — it is one hand, and the best thing it can do is the best thing
   * it can do. Whole numbers, because the score is `Σ w · ways` and exactness
   * (TDD §10.3) rests on that sum being an integer; `validateProblem` holds the
   * largest weight to what `C(N, H)` leaves below 2^53.
   */
  weight?: number;
  /**
   * The SIXTH CARD's own part (PRD §5.6). Present: `slots`, `limits` and
   * `reqs` above are about the OPENING FIVE — the hand less its last card —
   * and this is about the card drawn. Absent: the criterion is judged over the
   * whole hand, which is every criterion the language had before this and is
   * why such a run is byte for byte what it always was.
   *
   * It may only be judged by a hand size marked `drawn`, and `validateProblem`
   * holds it to that: the split is a statement about a hand you draw in two
   * pieces, and going first there is no sixth card to speak of.
   */
  sixth?: SixthCard;
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
  /**
   * Whether this hand's LAST card is DRAWN: going second you see five cards
   * and then draw one (PRD §5.5), and a criterion may then speak of that card
   * on its own (`CompiledCriterion.sixth`).
   *
   * It changes the SAMPLE SPACE, and that is the whole of what it does. A hand
   * stops being a set of `H` cards and becomes the ordered pair (the opening
   * `H - 1`, the card drawn), of which there are `H` per set — so every count
   * is `H` times what it was, `outcomesOf` is that `H`, and a run in which
   * nothing is split scores exactly what it always scored with both sides of
   * the fraction multiplied by it (a fact pinned by a test).
   *
   * It is a property of the HAND and not of the criteria, so that every score
   * of one run — the headline and each criterion's own row — is a fraction over
   * one denominator. `compileProblem` sets it wherever a criterion the hand
   * judges is split, and honours it wherever a caller asks for it.
   */
  drawn?: boolean;
}

/**
 * The outcomes one hand of `hand.H` cards holds: `H` when its last card is
 * drawn separately — a set of `H` cards is `H` different (opening, drawn)
 * pairs — and 1 otherwise, which is every hand the engine had before.
 */
export function outcomesOf(hand: Pick<HandSize, 'H' | 'drawn'>): number {
  return hand.drawn === true ? hand.H : 1;
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

/**
 * The largest weight any criterion of `problem` carries, and never below 1: a
 * problem with no criteria, and one whose criteria are all unweighted, both
 * answer 1, which is what makes the weighted score of an unweighted problem
 * the probability it always was.
 */
export function maxCriterionWeight(problem: Pick<Problem, 'criteria'>): number {
  let most = 1;
  for (const { weight } of problem.criteria)
    if (weight !== undefined && weight > most) most = weight;
  return most;
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
  for (const hand of handSizes) {
    const { H, weight, criteria: own, drawn } = hand;
    checkHandSize(H, deckSize);
    if (seen.has(H)) throw new RangeError(`hand size ${H} appears twice`);
    seen.add(H);
    if (!Number.isInteger(weight) || weight < 1)
      throw new RangeError(
        `hand size ${H}: a weight is a positive whole number — a blend is a ratio such as 1 : 1 — not ${weight}`,
      );
    // One card drawn leaves none to open on, and the split says something
    // about both halves of the hand.
    if (drawn === true && H < 2)
      throw new RangeError(
        `hand size ${H}: a hand whose last card is drawn separately holds at least 2 cards — one to open on, and the one drawn`,
      );
    const taken = new Set<number>();
    for (const at of own ?? criteria.map((_, index) => index)) {
      if (!Number.isInteger(at) || at < 0 || at >= criteria.length)
        throw new RangeError(
          `hand size ${H}: \`criteria\` holds ${at}, which is not one of the problem's ${criteria.length} criteria`,
        );
      if (taken.has(at)) throw new RangeError(`hand size ${H}: criterion ${at} appears twice`);
      taken.add(at);
      // A split criterion is a statement about a hand drawn in two pieces, so
      // the hand judging it has to be one — going first there is no sixth card.
      if (criteria[at]!.sixth !== undefined && drawn !== true)
        throw new RangeError(
          `hand size ${H}: criterion ${at} is about the card you draw, but this hand does not draw one — a split criterion is judged only by a hand marked \`drawn\``,
        );
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

  criteria.forEach(({ weight, sixth, ...part }, criterion) => {
    if (weight !== undefined && (!Number.isSafeInteger(weight) || weight < 1))
      throw new RangeError(
        `criterion ${criterion}: a weight is a positive whole number — the score is a sum of weights, and exactness rests on that — not ${weight}`,
      );
    checkPart(part, classes.length, `criterion ${criterion}`);
    if (sixth === undefined) return;
    if (sixth.slots.length > MAX_SIXTH_SLOTS)
      throw new RangeError(
        `criterion ${criterion}: the sixth card is one card, and its part asks for ${sixth.slots.length}`,
      );
    checkPart(sixth, classes.length, `criterion ${criterion}, the sixth card`);
  });

  for (const hand of problem.handSizes)
    checkWeightBound(deckSize, hand.H, maxCriterionWeight(problem), outcomesOf(hand));
}

/** The slots, limits and ranges of one window: a whole hand, or the card drawn. */
function checkPart({ slots, limits, reqs }: SixthCard, classCount: number, where: string): void {
  slots.forEach((mask, slot) => {
    checkMask(mask, classCount, `${where}, slot ${slot}`, 'fill a requirement');
  });
  limits.forEach(({ mask, n }, limit) => {
    const at = `${where}, limit ${limit}`;
    checkMask(mask, classCount, at, 'count against a limit');
    if (!isCount(n)) throw new RangeError(`${at}: a limit's count is a whole number, not ${n}`);
  });
  if (reqs !== undefined) checkRequirements(reqs, slots, classCount, where);
}

/**
 * THE EXACTNESS BOUND for weighted criteria (TDD §10.3). A weighted numerator
 * is `Σ_h w(h) · Π_c C(n_c, h_c)`, and every hand is counted once by exactly
 * one composition, so the whole sum is at most `max(w) · C(N, H)` — with
 * `C(60, 6) = 50,063,860` that leaves room for weights up to 179,914,198, and
 * far more for a smaller deck. Past it the sum would be ROUNDED and two decks
 * could then tie, or fail to, by accident. So this throws rather than answer
 * inexactly, which is the choice `compareScores` and `rankKey` already make
 * about a blend.
 *
 * Checked per HAND SIZE, since `C(N, 6) > C(N, 5)`: a weight a going-first run
 * can score exactly is not necessarily one an average can.
 *
 * `outcomes` is `outcomesOf` the hand — 6 where the sixth card is drawn
 * separately, since every hand is then six (opening, drawn) pairs and every
 * count is six times what it was. It multiplies the headroom away exactly as a
 * weight does, so it is part of the SAME bound and not a second one:
 * `6 × C(60, 6) = 300,383,160` leaves room for weights up to 29,985,699, and
 * far more for a smaller deck. The editor's cap of 1,000 is nowhere near it —
 * which is the point of having the number rather than trusting it.
 */
export function checkWeightBound(
  deckSize: number,
  H: number,
  maxWeight: number,
  outcomes = 1,
): void {
  const den = choose(deckSize, H) * outcomes;
  if (Number.isSafeInteger(maxWeight * den)) return;
  const drawn = outcomes === 1 ? '' : `${outcomes} × `;
  throw new RangeError(
    `a weight of ${maxWeight} cannot be scored exactly at a hand of ${H}: the score would reach ${maxWeight} × ${drawn}C(${deckSize}, ${H}) = ${maxWeight} × ${den}, past 2^53 — the largest weight this deck and hand allow is ${Math.floor(Number.MAX_SAFE_INTEGER / den)}`,
  );
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
    // `drawn` travels with the part: it says what a HAND is, and a part that
    // forgot it would answer over a sample space its siblings do not share.
    handSizes: [
      hand.drawn === true ? { H: hand.H, weight: 1, drawn: true } : { H: hand.H, weight: 1 },
    ],
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
  owner: string,
): void {
  const ceilings = reqs.filter(({ max }) => max !== null).length;
  if (ceilings === 0)
    throw new RangeError(
      `${owner}: with no ceiling to keep, \`reqs\` is left out and \`slots\` says it all`,
    );
  if (ceilings > MAX_RANGES)
    throw new RangeError(
      `${owner}: the engine judges at most ${MAX_RANGES} range requirements, not ${ceilings}`,
    );
  reqs.forEach(({ mask, min, max }, at) => {
    const where = `${owner}, requirement ${at}`;
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
      `${owner}: \`slots\` must be the requirements' lower bounds expanded — ${expanded.length} slot(s) expected, ${slots.length} given`,
    );
}
