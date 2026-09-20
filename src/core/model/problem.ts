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
 * The largest deck and OPENING hand the engine scores. Exactness rests on them
 * (TDD §10.3): every numerator is at most C(60, 6) = 50,063,860, far below
 * 2^53. With DRAW CARDS the hand grows past `MAX_HAND_SIZE` — `MAX_PREFIX` and
 * `MAX_HAND` below are the bounds that then apply.
 */
export const MAX_DECK_SIZE = 60;
export const MAX_HAND_SIZE = 6;

/**
 * The longest PREFIX of the deck a hand may reach through draw cards
 * (`longestPrefix`), in the `MAX_CLASSES` style: past it the template is an
 * error rather than a slow run.
 *
 * The justification is BUILD TIME alone. `analyze` rebuilds the success set on
 * every keystroke, and the enumeration grows with the prefix: at ten classes a
 * prefix of 16 stays under ~50 ms, where 23 costs 254 ms and 29 costs 705 ms.
 * It is NOT an exactness frontier — C(60, 16) = 149,608,375,854,525 is a long
 * way below 2^53, and `createScorer` checks the exactness of what it actually
 * builds rather than trusting a length.
 */
export const MAX_PREFIX = 16;

/**
 * The largest HAND the engine judges: the prefix less the copies that resolved
 * and left it (`largestHand`). It bounds the requirement slots a criterion may
 * ask for, and so the `2^slots` subset tables the matcher builds — 4,096
 * entries per alternative at this size. Three copies of a card that draws three
 * reach 11 from a hand of five and 12 from a hand of six, so it is the largest
 * hand any ordinary draw card builds; a card that drew ten at once would be
 * refused here rather than allocate for it.
 */
export const MAX_HAND = 12;

/** Bit 0: the blank class, which fills no requirement and counts against no limit. */
export const BLANK_BIT = 1;

/**
 * A class whose cards DRAW (PRD §5.7): a copy that RESOLVES leaves the hand and
 * is replaced by `n` cards off the top of the deck. Cards so drawn draw in
 * turn, so the hand is a PREFIX of a shuffled deck whose length is the least
 * fixed point of `ℓ = H + draws(first ℓ)` — not a fixed number of cards. A draw
 * card ALWAYS resolves once the player commits; whether an opening hand that
 * already works commits at all is the criteria's own `stop`.
 */
export interface DrawSpec {
  /**
   * How many cards one resolved copy draws: a positive whole number.
   *
   * A DELIBERATE SIMPLIFICATION, and the one most likely to be mistaken for a
   * bug: there is ONE decision point, before any card is drawn. Either no draws
   * at all, or every draw card in the prefix resolves — bounded only by
   * `oncePerTurn`. A player holding two Pots could activate the first, see the
   * hand is now fine and keep the second; the model resolves both. So for a
   * template that draws, **the number is a LOWER bound on careful play**, and
   * marking a criterion `stop` is the only escape hatch the model offers.
   * Anything finer would be a decision tree, where this is a single fraction.
   */
  n: number;
  /**
   * Only the FIRST copy resolves; further copies sit in the hand unactivated,
   * and are judged like any other card. It is a property of the CARD and not of
   * the class, which is why two once-per-turn lines never share a class
   * (`compileProblem`): each names its own card and each gets its own once.
   */
  oncePerTurn?: true;
}

export interface ClassInfo {
  /** The template lines merged into this class; the blank class may have none. */
  lineIds: string[];
  /** The range of the class TOTAL: the sum of its lines' ranges. */
  min: number;
  max: number;
  /** Set when the class's cards DRAW (PRD §5.7); absent is every class the engine had before. */
  draw?: DrawSpec;
}

/** One draw class with what bounds its copies: all the prefix arithmetic reads. */
export interface DrawClass extends DrawSpec {
  cls: number;
  /** The class's `max`: the most copies any deck of the template can hold. */
  max: number;
}

/** The draw classes of a problem, ascending; empty for every problem without them. */
export function drawClassesOf(classes: readonly ClassInfo[]): DrawClass[] {
  return classes.flatMap(({ draw, max }, cls) =>
    draw === undefined ? [] : [{ cls, max, ...draw }],
  );
}

/**
 * Copies of one draw class that RESOLVE when a prefix holds `held` of them:
 * all of them, or one when the card is once-per-turn.
 */
export function copiesUsed(held: number, { oncePerTurn }: DrawSpec): number {
  return oncePerTurn === true ? Math.min(held, 1) : held;
}

/** The cards the draw cards of a prefix ask for: `Σ n_c · used_c`. */
export function drawsOf(held: ArrayLike<number>, draws: readonly DrawClass[]): number {
  let sum = 0;
  for (const spec of draws) sum += spec.n * copiesUsed(held[spec.cls] ?? 0, spec);
  return sum;
}

/**
 * THE LONGEST PREFIX: `H + Σ n_c · (oncePerTurn ? 1 : max_c)`. It drives
 * `C(N, ℓ)`, the enumeration and the cost — and it is NOT the largest hand.
 * Three copies of Pot of Greed reach a prefix of 11 from a hand of five, and a
 * hand of 8; three Upstart Goblins reach a prefix of 8 and a hand of 5.
 */
export function longestPrefix(H: number, draws: readonly DrawClass[]): number {
  let out = H;
  for (const spec of draws) out += spec.n * (spec.oncePerTurn === true ? 1 : spec.max);
  return out;
}

/**
 * THE LARGEST HAND: the prefix less the copies that resolved and left it,
 * `H + Σ (n_c − 1) · (oncePerTurn ? 1 : max_c)`. It drives the requirement
 * slots, `MAX_HAND` and `expand`'s `maxHandSize` — everything about what a
 * criterion may ASK, where `longestPrefix` drives what a score COSTS.
 */
export function largestHand(H: number, draws: readonly DrawClass[]): number {
  let out = H;
  for (const spec of draws) out += (spec.n - 1) * (spec.oncePerTurn === true ? 1 : spec.max);
  return out;
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
  /**
   * A criterion the player would STOP for (PRD §5.7): if the OPENING hand
   * already meets it, no draw card is activated at all. Absent is the default,
   * and every criterion the engine had before draw cards.
   *
   * **It governs the stop DECISION and nothing else.** Whichever window that
   * decision lands on, EVERY criterion of the problem is then judged in it — a
   * criterion marked `stop` is not "a criterion that may only be read
   * pre-draw", and one left alone is not barred from the opening. Read the two
   * states as: unchecked (`stop`) is *"I would stop for this"*, and checked is
   * *"I am willing to lose this by drawing"*.
   *
   * ONE DECISION POINT, taken before any card is drawn (`compileValuer`'s
   * counterpart for prefixes, `drawSet`):
   *
   *     look at the opening H cards
   *       any `stop` criterion met?
   *         yes -> STOP. worth the best weight among ALL criteria the OPENING meets
   *         no  -> DRAW every draw card. worth the best weight among ALL criteria
   *                the POST-DRAW hand meets — 0 if drawing broke them, with no
   *                falling back on what the opening would have been worth
   *
   * There is deliberately no MAXIMUM over the two windows and no per-card
   * choice: the draw decision is *determined* by the opening, so exactly one
   * window is ever in play. A criterion worth 5 that draws into a 2 scores 2. A
   * hand that draws out of everything scores 0 even though its opening would
   * have scored. That is what makes the value strategy-achievable rather than an
   * upper bound with hindsight — and it is why the ordering factor exists at
   * all, since the continuation is fixed once the player commits.
   *
   * Without draw cards the two windows are the same hand, so this changes
   * nothing whichever way it is set — a fact a test pins.
   */
  stop?: true;
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
  classes.forEach(({ min, max, draw }, cls) => {
    if (!isCount(min) || !isCount(max) || min > max)
      throw new RangeError(
        `class ${cls}: a range is 0 <= min <= max in whole cards, not ${min} to ${max}`,
      );
    if (draw === undefined) return;
    if (!Number.isInteger(draw.n) || draw.n < 1)
      throw new RangeError(
        `class ${cls}: a draw card draws a positive whole number of cards, not ${draw.n} — a card that draws nothing is not a draw card`,
      );
    // The blank class is the cards no criterion can see. A card that DRAWS is
    // seen by every criterion at once, through the hand it builds.
    if (cls === 0)
      throw new RangeError('the blank class cannot draw: its cards are the ones nothing can see');
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

  const draws = drawClassesOf(classes);
  const most = maxCriterionWeight(problem);
  if (draws.length === 0) {
    for (const hand of problem.handSizes)
      checkWeightBound(deckSize, hand.H, most, outcomesOf(hand));
    return;
  }
  for (const hand of problem.handSizes) checkDraws(problem, hand, draws, most);
}

/**
 * What draw cards make of one hand size — the whole of the engine's refusal
 * list for them, in the `MAX_CLASSES` style: an error where it enters, never a
 * silently wrong probability.
 */
function checkDraws(
  problem: Problem,
  hand: HandSize,
  draws: readonly DrawClass[],
  maxWeight: number,
): void {
  const { deckSize, criteria } = problem;
  const { H } = hand;
  const where = `a hand of ${H}`;
  // `then` (PRD §5.6) reads a set of `H` cards as `H` equally likely (opening,
  // drawn) pairs. With draw cards it is not: a draw card has to land in the
  // first `H` positions or it never resolves, so the card at position `H − 1`
  // is biased towards them — measured at 0.3333 against the 0.2000 a uniform
  // reading assumes. The two features are refused together rather than one of
  // them quietly reading the other's sample space.
  const split = criteria.findIndex(({ sixth }) => sixth !== undefined);
  if (split >= 0)
    throw new RangeError(
      `criterion ${split} is about the card you draw, and this template has draw cards — \`then\` and draw cards cannot be judged together: the card you draw for turn is no longer one of six equally likely ones once a draw card has to be among the first ${H} to resolve`,
    );
  if (hand.drawn === true)
    throw new RangeError(
      `${where}: a hand whose last card is drawn separately cannot hold draw cards — the two read the same hand as two different sample spaces`,
    );

  const prefix = longestPrefix(H, draws);
  // DECK-OUT, refused rather than modelled: the model would drop that mass
  // rather than mis-count it, and refusing is what buys the standing invariant
  // that the reachable prefixes carry probability exactly 1.
  if (prefix > deckSize)
    throw new RangeError(
      `${where}: these draw cards can ask for ${prefix} cards from a deck of ${deckSize} — the deck would run out; hold fewer copies, or draw fewer cards`,
    );
  if (prefix > MAX_PREFIX)
    throw new RangeError(
      `${where}: these draw cards reach ${prefix} cards deep, and the engine scores at most ${MAX_PREFIX} — hold fewer copies of a draw card, or draw fewer cards`,
    );
  const largest = largestHand(H, draws);
  if (largest > MAX_HAND)
    throw new RangeError(
      `${where}: these draw cards build a hand of up to ${largest} cards, and the engine judges at most ${MAX_HAND}`,
    );
  // The prefix, not the hand: a score sums over the ℓ-card prefixes, so
  // `C(N, ℓ)` is what a numerator is bounded by.
  checkWeightBound(deckSize, prefix, maxWeight, 1, 'prefix');
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
  /** What `H` counts: the cards of a hand, or — with draw cards — of a prefix. */
  what: 'hand' | 'prefix' = 'hand',
): void {
  const den = choose(deckSize, H) * outcomes;
  if (Number.isSafeInteger(maxWeight * den)) return;
  const drawn = outcomes === 1 ? '' : `${outcomes} × `;
  throw new RangeError(
    `a weight of ${maxWeight} cannot be scored exactly at a ${what} of ${H}: the score would reach ${maxWeight} × ${drawn}C(${deckSize}, ${H}) = ${maxWeight} × ${den}, past 2^53 — the largest weight this deck and ${what} allow is ${Math.floor(Number.MAX_SAFE_INTEGER / den)}`,
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
