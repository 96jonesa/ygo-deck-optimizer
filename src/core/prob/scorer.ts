import { type Problem, partProblem, validateProblem } from '../model/problem';
import { binomialTable } from './binomial';
import { type SuccessSetOptions, successSet } from './success-set';

/**
 * The exact scorer (TDD §10.3): for class totals `n`,
 *
 *     P(n) = (1 / C(N, H)) · Σ over the success set of Π over classes of C(n_c, h_c)
 *
 * The numerator is an EXACT INTEGER held in a float64. Every product counts
 * some of the C(N, H) hands, and so does the whole sum, so nothing exceeds
 * C(60, 6) = 50,063,860 — far below 2^53. There is no rounding anywhere and no
 * BigInt; two decks tie iff their numerators are equal.
 */
export interface Fraction {
  num: number;
  den: number;
}

export interface Scorer {
  H: number;
  /** C(N, H): the same for every deck. */
  den: number;
  /** Products summed per score — the stored side of the success set: what a score costs. */
  terms: number;
  complemented: boolean;
  /** The numerator alone: the optimizer ranks by it, and allocates nothing. */
  numerator(n: ArrayLike<number>): number;
  /** `n` is the class totals, blank class included, summing to the deck size. */
  score(n: ArrayLike<number>): Fraction;
}

const TABLE = binomialTable();
const STRIDE = TABLE.maxR + 1;

export function createScorer(problem: Problem, H: number, opts: SuccessSetOptions = {}): Scorer {
  const { compositions, count, width, complemented } = successSet(problem, H, opts);
  const { deckSize } = problem;
  const classCount = problem.classes.length;
  const den = TABLE.values[deckSize * STRIDE + H]!;

  // Each stored composition as the classes it holds a card of — the blank
  // class included — since C(n, 0) = 1 for all the others. A factor is a
  // `code`: the class's row of `ways`, and how many of its cards are held.
  const hRow = H + 1;
  const starts = new Uint32Array(count + 1);
  // `H` cards are of at most `H` classes.
  const factors = new Uint16Array(count * H);
  let filled = 0;
  for (let row = 0; row < count; row++) {
    let blank = H;
    for (let cls = 1; cls < classCount; cls++) {
      const held = compositions[row * width + cls - 1]!;
      if (held > 0) factors[filled++] = cls * hRow + held;
      blank -= held;
    }
    if (blank > 0) factors[filled++] = blank;
    starts[row + 1] = filled;
  }
  /** `ways[c * (H + 1) + held]` is C(n_c, held) for the deck being scored. */
  const ways = new Float64Array(classCount * hRow);

  const numerator = (n: ArrayLike<number>): number => {
    if (n.length !== classCount)
      throw new RangeError(
        `expected a total for each of the ${classCount} classes, got ${n.length}`,
      );
    let cards = 0;
    for (let cls = 0; cls < classCount; cls++) {
      const total = n[cls]!;
      if (!Number.isInteger(total) || total < 0 || total > deckSize)
        throw new RangeError(
          `class ${cls}: a total is a whole number from 0 to ${deckSize}, not ${total}`,
        );
      cards += total;
      for (let held = 0; held <= H; held++)
        ways[cls * hRow + held] = TABLE.values[total * STRIDE + held]!;
    }
    if (cards !== deckSize)
      throw new RangeError(
        `the class totals hold ${cards} cards, not the deck size of ${deckSize}`,
      );

    let sum = 0;
    for (let row = 0; row < count; row++) {
      let product = 1;
      for (let at = starts[row]!; at < starts[row + 1]!; at++) product *= ways[factors[at]!]!;
      sum += product;
    }
    return complemented ? den - sum : sum;
  };

  return {
    H,
    den,
    terms: count,
    complemented,
    numerator,
    score: (n) => ({ num: numerator(n), den }),
  };
}

export interface BlendPart extends Fraction {
  H: number;
  weight: number;
}

/** A score over every hand size of the problem: one exact fraction each. */
export interface BlendScore {
  parts: BlendPart[];
  /**
   * FOR DISPLAY ONLY — the one float the engine produces: the weighted mean
   * `Σ weight · num / den / Σ weight`. Never rank by it; `compareScores` ranks.
   */
  pDisplay: number;
}

export interface BlendScorer {
  /** One per hand size, in the order of `problem.handSizes`. */
  scorers: Scorer[];
  score(n: ArrayLike<number>): BlendScore;
  /**
   * One exact integer that orders the decks of THIS problem exactly as
   * `compareScores` orders their scores — the blend's numerator over the least
   * common denominator, `Σ weight · num · (common / den)` — for a heap that
   * ranks by a number. For one hand size of weight 1 it is the numerator.
   * Throws if the weights are so large that it could pass 2^53.
   */
  rankKey(n: ArrayLike<number>): number;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** `value`, which must have come out an exact integer. */
function exact(value: number): number {
  if (!Number.isSafeInteger(value))
    throw new RangeError(
      'these scores cannot be ranked in exact integers: a term is past 2^53 — use smaller weights',
    );
  return value;
}

/**
 * Scorers for every hand size of `problem` (TDD §10.3: a first/second blend).
 *
 * Each part is scored against ITS OWN criteria (`partProblem`) and all of them
 * against the SAME classes, so that the parts of an average are two readings
 * of one deck; `score` hands the one class-total vector to each in turn.
 */
export function createBlendScorer(problem: Problem, opts: SuccessSetOptions = {}): BlendScorer {
  validateProblem(problem);
  const scorers = problem.handSizes.map((hand) =>
    createScorer(partProblem(problem, hand), hand.H, opts),
  );
  const weights = problem.handSizes.map(({ weight }) => weight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  // No key can exceed `totalWeight · common`: if that is exact, every key is.
  const common = scorers.reduce((lcm, { den }) => (lcm / gcd(lcm, den)) * den, 1);
  const rankable = Number.isSafeInteger(totalWeight * common);
  const multipliers = scorers.map(({ den }, at) => weights[at]! * (common / den));
  return {
    scorers,
    rankKey: (n) => {
      if (!rankable) exact(totalWeight * common);
      let key = 0;
      for (let at = 0; at < scorers.length; at++)
        key += multipliers[at]! * scorers[at]!.numerator(n);
      return key;
    },
    score: (n) => {
      const parts = scorers.map((scorer, at) => ({
        H: scorer.H,
        weight: weights[at]!,
        ...scorer.score(n),
      }));
      const weighted = parts.reduce((sum, { weight, num, den }) => sum + (weight * num) / den, 0);
      return { parts, pDisplay: weighted / totalWeight };
    },
  };
}

/** One deck, scored once; to score many, keep a `createBlendScorer`. */
export function scoreBlend(problem: Problem, n: ArrayLike<number>): BlendScore {
  return createBlendScorer(problem).score(n);
}

/**
 * Ranks two scores of the same shape — the same hand sizes and weights —
 * EXACTLY: negative when `a` is the worse, positive when it is the better, 0
 * only on a true tie. It is `Σ weight · (a.num / a.den − b.num / b.den)`
 * cross-multiplied onto the least common denominator, so every term is an
 * integer; for one hand size of one problem that is `a.num − b.num`. The
 * denominators of neighbouring hand sizes share almost all their factors
 * (C(N, 6) = C(N, 5) · (N − 5) / 6), so the integers stay far below 2^53; if
 * they ever would not, this throws rather than answer by rounding.
 */
export function compareScores(a: BlendScore, b: BlendScore): number {
  const sameShape =
    a.parts.length === b.parts.length &&
    a.parts.every((part, at) => part.H === b.parts[at]!.H && part.weight === b.parts[at]!.weight);
  if (!sameShape)
    throw new RangeError('only scores over the same hand sizes and weights can be compared');

  let common = 1;
  for (const { den } of [...a.parts, ...b.parts]) common = exact((common / gcd(common, den)) * den);
  let difference = 0;
  a.parts.forEach((mine, at) => {
    const theirs = b.parts[at]!;
    const lead = mine.num * (common / mine.den) - theirs.num * (common / theirs.den);
    difference = exact(difference + exact(mine.weight * lead));
  });
  return difference > 0 ? 1 : difference < 0 ? -1 : 0;
}
