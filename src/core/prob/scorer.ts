import { maxCriterionWeight, type Problem, partProblem, validateProblem } from '../model/problem';
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
 *
 * WEIGHTED CRITERIA (PRD §5.6) change one thing: each composition contributes
 * `w · Π C(n_c, h_c)` rather than the product alone, `w` being the highest
 * weight among the criteria that composition meets. The sum is then the
 * EXPECTED WEIGHT per hand times C(N, H), bounded by `max(w) · C(N, H)` —
 * `validateProblem` refuses weights that would take that past 2^53, so the
 * numerator is still an exact integer and a tie is still an exact tie.
 *
 * The plain success count comes out of the same walk (`successNum`), so a
 * weighted run reports the probability beside its score for nothing.
 */
export interface Fraction {
  num: number;
  den: number;
}

/** One scored deck: the weighted numerator, and the plain one beside it. */
export interface Score extends Fraction {
  /**
   * The hands that meet ANY criterion, over the same `den`: P(success), the
   * number the tool reported before weights existed. Equal to `num` whenever
   * no criterion is weighted.
   */
  successNum: number;
}

export interface Scorer {
  H: number;
  /** C(N, H): the same for every deck. */
  den: number;
  /** Products summed per score — the stored side of the success set: what a score costs. */
  terms: number;
  complemented: boolean;
  /** The largest weight any criterion carries; 1 when none is weighted. */
  maxWeight: number;
  /** The numerator alone: the optimizer ranks by it, and allocates nothing. */
  numerator(n: ArrayLike<number>): number;
  /** `n` is the class totals, blank class included, summing to the deck size. */
  score(n: ArrayLike<number>): Score;
}

const TABLE = binomialTable();
const STRIDE = TABLE.maxR + 1;

export function createScorer(problem: Problem, H: number, opts: SuccessSetOptions = {}): Scorer {
  const { compositions, count, width, complemented, values, maxWeight } = successSet(
    problem,
    H,
    opts,
  );
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
  /**
   * Every stored row worth the same. True of every UNWEIGHTED problem, whichever
   * side is stored, and then the inner loop is the one it always was — the unit
   * is applied once to the whole sum instead of once per term.
   */
  const unit = count === 0 ? 1 : values[0]!;
  const uniform = values.every((value) => value === unit);
  /** Rows that count toward the plain success total; only read when a weight is in play. */
  const plainly = new Float64Array(count).fill(1);
  if (complemented)
    for (let row = 0; row < count; row++) plainly[row] = values[row] === maxWeight ? 1 : 0;

  /** Fills `ways` for this deck, and refuses class totals that are not one. */
  const prepare = (n: ArrayLike<number>): void => {
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
  };

  const numerator = (n: ArrayLike<number>): number => {
    prepare(n);
    let sum = 0;
    if (uniform) {
      // The loop as it was before weights: no per-term multiply, and the unit
      // — 1 for every unweighted problem — applied once at the end.
      for (let row = 0; row < count; row++) {
        let product = 1;
        for (let at = starts[row]!; at < starts[row + 1]!; at++) product *= ways[factors[at]!]!;
        sum += product;
      }
      sum *= unit;
    } else {
      for (let row = 0; row < count; row++) {
        let product = values[row]!;
        for (let at = starts[row]!; at < starts[row + 1]!; at++) product *= ways[factors[at]!]!;
        sum += product;
      }
    }
    return complemented ? maxWeight * den - sum : sum;
  };

  /**
   * The weighted numerator and the plain one in ONE walk. Under direct storage
   * every stored row is a hand that succeeds; under complement storage the rows
   * worth `maxWeight` are the ones worth nothing before the flip — the hands
   * that fail — so the plain count is `den` less those.
   */
  const score = (n: ArrayLike<number>): Score => {
    if (maxWeight === 1) {
      const num = numerator(n);
      return { num, den, successNum: num };
    }
    prepare(n);
    let sum = 0;
    let plain = 0;
    for (let row = 0; row < count; row++) {
      let product = 1;
      for (let at = starts[row]!; at < starts[row + 1]!; at++) product *= ways[factors[at]!]!;
      sum += values[row]! * product;
      plain += plainly[row]! * product;
    }
    return {
      num: complemented ? maxWeight * den - sum : sum,
      den,
      successNum: complemented ? den - plain : plain,
    };
  };

  return { H, den, terms: count, complemented, maxWeight, numerator, score };
}

export interface BlendPart extends Score {
  H: number;
  /** The hand size's share of the blend — NOT a criterion weight. */
  weight: number;
}

/** A score over every hand size of the problem: one exact fraction each. */
export interface BlendScore {
  parts: BlendPart[];
  /**
   * FOR DISPLAY ONLY — the one float the engine produces: the weighted mean
   * `Σ weight · num / den / Σ weight`. Never rank by it; `compareScores` ranks.
   * With weighted criteria it is an expected weight per hand rather than a
   * probability, and can exceed 1.
   */
  pDisplay: number;
}

/** The two exact keys of one score, both over `BlendScorer.rankDen`. */
export interface BlendKeys {
  /** What the run RANKS by: the weighted score, or the probability when nothing is weighted. */
  blend: number;
  /** P(at least one criterion), whatever the weights. Equal to `blend` when none is weighted. */
  success: number;
}

export interface BlendScorer {
  /** One per hand size, in the order of `problem.handSizes`. */
  scorers: Scorer[];
  /** The largest weight any criterion carries; 1 when none is weighted. */
  maxWeight: number;
  /** `Σ weight` times the parts' least common denominator: what both keys are over. */
  rankDen: number;
  score(n: ArrayLike<number>): BlendScore;
  /**
   * One exact integer that orders the decks of THIS problem exactly as
   * `compareScores` orders their scores — the blend's numerator over the least
   * common denominator, `Σ weight · num · (common / den)` — for a heap that
   * ranks by a number. For one hand size of weight 1 it is the numerator.
   * Throws if the weights are so large that it could pass 2^53.
   */
  rankKey(n: ArrayLike<number>): number;
  /**
   * The same two keys off a score already computed, so that a row which is
   * being shown pays for one walk of the success set and not three.
   */
  keysOf(score: BlendScore): BlendKeys;
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
  const maxWeight = maxCriterionWeight(problem);
  // No key can exceed `maxCriterionWeight · totalWeight · common`: a part's
  // numerator is at most `maxCriterionWeight · den`, so if THAT is exact, every
  // key is. Without weighted criteria it is the bound this always had.
  const common = scorers.reduce((lcm, { den }) => (lcm / gcd(lcm, den)) * den, 1);
  const ceiling = maxWeight * totalWeight * common;
  const rankable = Number.isSafeInteger(ceiling);
  const multipliers = scorers.map(({ den }, at) => weights[at]! * (common / den));
  const rankDen = totalWeight * common;
  const keysOf = ({ parts }: BlendScore): BlendKeys => {
    if (!rankable) exact(ceiling);
    let blend = 0;
    let success = 0;
    for (let at = 0; at < parts.length; at++) {
      blend += multipliers[at]! * parts[at]!.num;
      success += multipliers[at]! * parts[at]!.successNum;
    }
    return { blend, success };
  };
  return {
    scorers,
    maxWeight,
    rankDen,
    keysOf,
    rankKey: (n) => {
      if (!rankable) exact(ceiling);
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
 *
 * A numerator carrying CRITERION weights is up to `max(w)` times a
 * probability's, so each cross-multiplied term is checked and not only the
 * difference of the two: a subtraction can bring a pair of rounded products
 * back into range and answer confidently with the wrong sign.
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
    const lead = exact(mine.num * (common / mine.den)) - exact(theirs.num * (common / theirs.den));
    difference = exact(difference + exact(mine.weight * lead));
  });
  return difference > 0 ? 1 : difference < 0 ? -1 : 0;
}
