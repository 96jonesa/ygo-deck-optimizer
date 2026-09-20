import { maxCriterionWeight, type Problem, partProblem, validateProblem } from '../model/problem';
import { binomialTable } from './binomial';
import { drawSet, hasDrawCards } from './draw-set';
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
 *
 * THE SIXTH CARD (PRD §5.6) changes the DENOMINATOR and nothing else. Where the
 * hand's last card is drawn separately, a set of `H` cards is `H` ordered
 * (opening, drawn) outcomes, so `den` is `H · C(N, H)` and each composition's
 * stored value is what all of its outcomes come to (`compileValuer`). The
 * products, the table, the inner loop and the exactness argument are untouched:
 * the sum is at most `max(w) · H · C(N, H)`, which `checkWeightBound` holds
 * below 2^53 — 6 × C(60, 6) = 300,383,160, leaving room for weights up to
 * 29,985,699 against an editor that caps them at 1,000.
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
  /**
   * The PREFIX of the deck this part scores, when the problem holds draw cards
   * (PRD §5.7): the hand is then a prefix of the shuffled deck, and a problem
   * has one part per length the draw cards can reach. Absent is every problem
   * without them, whose one part IS the hand of `H`.
   */
  prefix?: number;
  /**
   * The outcomes this hand holds: `outcomes · C(N, H)`, the same for every
   * deck. With the sixth card drawn separately a SET of `H` cards is `H`
   * ordered (opening, drawn) pairs, so both sides of the fraction are `H`
   * times what they were and the value it means is unchanged. With DRAW CARDS
   * it is what the prefix's ordering factors are put over instead.
   */
  den: number;
  /** `outcomesOf` the hand: `H` when the sixth card is drawn separately, else 1. */
  outcomes: number;
  /** Products summed per score — the stored side of the success set: what a score costs. */
  terms: number;
  complemented: boolean;
  /**
   * Rational groups combined per score — with draw cards, the ordering factors
   * applied outside the float64 sums; 1 without them. It is a real per-deck
   * cost that a term count cannot show, so `analyze` reports it.
   */
  groups: number;
  /** The largest weight any criterion carries; 1 when none is weighted. */
  maxWeight: number;
  /** The numerator alone: the optimizer ranks by it, and allocates nothing. */
  numerator(n: ArrayLike<number>): number;
  /** `n` is the class totals, blank class included, summing to the deck size. */
  score(n: ArrayLike<number>): Score;
}

const TABLE = binomialTable();
const STRIDE = TABLE.maxR + 1;

/**
 * Every part of one hand size: ONE without draw cards, and one per prefix
 * length the draw cards can reach with them (PRD §5.7). It is what
 * `createBlendScorer` builds a blend out of, and the only place the two routes
 * are told apart.
 *
 * Every problem with a draw class takes the prefix route, whatever its criteria
 * say about stopping: a template whose every criterion would stop still DRAWS
 * when the opening meets none of them, so there is no template with draw cards
 * whose answer the plain success set can give.
 */
export function createScorers(problem: Problem, H: number, opts: SuccessSetOptions = {}): Scorer[] {
  return hasDrawCards(problem)
    ? createDrawScorers(problem, H, opts)
    : [createScorer(problem, H, opts)];
}

export function createScorer(problem: Problem, H: number, opts: SuccessSetOptions = {}): Scorer {
  if (hasDrawCards(problem))
    throw new RangeError(
      'this problem holds draw cards, so a hand is a prefix of the deck and has more than one length — score it through `createScorers`',
    );
  const {
    compositions,
    count,
    width,
    complemented,
    values,
    plains,
    maxWeight,
    outcomes,
    maxValue,
    maxPlain,
  } = successSet(problem, H, opts);
  const { deckSize } = problem;
  const classCount = problem.classes.length;
  /** C(N, H): the SETS of `H` cards, which is what the products count. */
  const sets = TABLE.values[deckSize * STRIDE + H]!;
  const den = outcomes * sets;

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
    return complemented ? maxValue * sets - sum : sum;
  };

  /**
   * The weighted numerator and the plain one in ONE walk. Under direct storage
   * every stored row is worth what its own outcomes come to; under complement
   * storage each row holds what it FALLS SHORT of the most a row can be worth,
   * so both sums are the ceiling less what is stored.
   */
  const score = (n: ArrayLike<number>): Score => {
    // Nothing weighted: a row's plain value IS its value, and one walk answers
    // both — which is every run the tool made before weights existed, and every
    // split run that does not weight its criteria.
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
      plain += plains[row]! * product;
    }
    return {
      num: complemented ? maxValue * sets - sum : sum,
      den,
      successNum: complemented ? maxPlain * sets - plain : plain,
    };
  };

  return { H, den, outcomes, terms: count, complemented, groups: 1, maxWeight, numerator, score };
}

/**
 * One scorer per prefix length (PRD §5.7). Each is an exact fraction of its
 * own, and the hand's score is their sum — which is why a draw template's
 * blend has a part per length rather than one per hand size.
 *
 * The inner loop is the one it always was, with one thing around it: the rows
 * are grouped by their ORDERING FACTOR, each group summed as a plain integer,
 * and the factors applied to the group sums. Both the largest group sum and the
 * largest numerator the combination can reach are checked when the set is built
 * (`drawSet`), so nothing here can round.
 */
function createDrawScorers(problem: Problem, H: number, opts: SuccessSetOptions): Scorer[] {
  const set = drawSet(problem, H, opts);
  const { deckSize, classes } = problem;
  const classCount = classes.length;
  const { maxWeight, width } = set;
  /** The longest prefix any part reads, which is how wide one class's row of `ways` is. */
  const longest = set.parts.reduce((most, part) => Math.max(most, part.prefix), H);
  const stride = longest + 1;

  /**
   * `ways[c * stride + held]` is C(n_c, held), SHARED by every part of this
   * hand size: the parts are scored one after another on the same deck, so
   * filling this once per deck rather than once per part is most of what a
   * draw score costs outside the sums themselves.
   */
  const ways = new Float64Array(classCount * stride);
  const ready = new Float64Array(classCount).fill(-1);

  /**
   * Fills `ways`, and refuses class totals the set was not built for. The
   * enumeration PRUNES each class by its `max` — sound, since `C(n_c, v_c)` is
   * 0 above it — so a deck that breaks a class range would be scored against
   * rows that were never stored, and silently too low.
   */
  const prepare = (n: ArrayLike<number>): void => {
    if (n.length !== classCount)
      throw new RangeError(
        `expected a total for each of the ${classCount} classes, got ${n.length}`,
      );
    let cards = 0;
    let same = true;
    for (let cls = 0; cls < classCount; cls++) {
      const total = n[cls]!;
      if (!Number.isInteger(total) || total < 0 || total > deckSize)
        throw new RangeError(
          `class ${cls}: a total is a whole number from 0 to ${deckSize}, not ${total}`,
        );
      if (total > classes[cls]!.max)
        throw new RangeError(
          `class ${cls}: ${total} cards is outside its range of ${classes[cls]!.min}–${classes[cls]!.max}, and a draw template is enumerated within those ranges`,
        );
      cards += total;
      if (ready[cls] !== total) same = false;
    }
    if (cards !== deckSize)
      throw new RangeError(
        `the class totals hold ${cards} cards, not the deck size of ${deckSize}`,
      );
    if (same) return;
    for (let cls = 0; cls < classCount; cls++) {
      const total = n[cls]!;
      ready[cls] = total;
      // Straight off the exact table: `held` never exceeds `MAX_PREFIX`, which
      // is what the table's columns were sized for.
      for (let held = 0; held <= longest; held++)
        ways[cls * stride + held] = TABLE.values[total * STRIDE + held]!;
    }
  };

  return set.parts.map((part): Scorer => {
    const { prefix, den, multipliers } = part;
    const rows = part.terms;
    /** Row bounds per group, then factor bounds per row: two flat walks, no nesting. */
    const groupAt = new Uint32Array(part.groups.length + 1);
    const rowAt = new Uint32Array(rows + 1);
    const factors = new Uint16Array(rows * prefix);
    const values = new Float64Array(rows);
    const plains = new Float64Array(rows);
    let row = 0;
    let filled = 0;
    part.groups.forEach((group, at) => {
      for (let own = 0; own < group.count; own++) {
        let blank = prefix;
        for (let cls = 1; cls < classCount; cls++) {
          const held = group.compositions[own * width + cls - 1]!;
          if (held > 0) factors[filled++] = cls * stride + held;
          blank -= held;
        }
        if (blank > 0) factors[filled++] = blank;
        values[row] = group.values[own]!;
        plains[row] = group.plains[own]!;
        rowAt[++row] = filled;
      }
      groupAt[at + 1] = row;
    });
    /**
     * Every row worth the same — every unweighted template judged after its
     * draws, where a row is worth 1 — so the unit multiplies the whole group
     * sum instead of every term of it, and the inner loop is the one the plain
     * scorer runs.
     */
    const unit = rows === 0 ? 1 : values[0]!;
    const uniform = values.every((value) => value === unit);

    const numerator = (n: ArrayLike<number>): number => {
      prepare(n);
      let sum = 0;
      for (let group = 0; group < multipliers.length; group++) {
        let inner = 0;
        if (uniform) {
          for (let at = groupAt[group]!; at < groupAt[group + 1]!; at++) {
            let product = 1;
            for (let factor = rowAt[at]!; factor < rowAt[at + 1]!; factor++)
              product *= ways[factors[factor]!]!;
            inner += product;
          }
          inner *= unit;
        } else {
          for (let at = groupAt[group]!; at < groupAt[group + 1]!; at++) {
            let product = values[at]!;
            for (let factor = rowAt[at]!; factor < rowAt[at + 1]!; factor++)
              product *= ways[factors[factor]!]!;
            inner += product;
          }
        }
        sum += multipliers[group]! * inner;
      }
      return sum;
    };

    const score = (n: ArrayLike<number>): Score => {
      // Unweighted, a row's plain value IS its value: one walk answers both,
      // which is every draw template that does not weight its criteria.
      if (maxWeight === 1) {
        const num = numerator(n);
        return { num, den, successNum: num };
      }
      prepare(n);
      let sum = 0;
      let plain = 0;
      for (let group = 0; group < multipliers.length; group++) {
        let inner = 0;
        let innerPlain = 0;
        for (let at = groupAt[group]!; at < groupAt[group + 1]!; at++) {
          let product = 1;
          for (let factor = rowAt[at]!; factor < rowAt[at + 1]!; factor++)
            product *= ways[factors[factor]!]!;
          inner += values[at]! * product;
          innerPlain += plains[at]! * product;
        }
        sum += multipliers[group]! * inner;
        plain += multipliers[group]! * innerPlain;
      }
      return { num: sum, den, successNum: plain };
    };

    return {
      H,
      prefix,
      den,
      outcomes: 1,
      terms: rows,
      complemented: false,
      groups: part.groups.length,
      maxWeight,
      numerator,
      score,
    };
  });
}

export interface BlendPart extends Score {
  H: number;
  /** The hand size's share of the blend — NOT a criterion weight. */
  weight: number;
  /**
   * The prefix of the deck this part scores (PRD §5.7); absent without draw
   * cards. Several parts then share one `H` and one `weight`, and only this
   * tells them apart — which is why `compareScores` reads it.
   */
  prefix?: number;
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
      'these scores cannot be ranked in exact integers: a term is past 2^53 — use smaller criterion weights, or fewer copies of a draw card (every prefix length a draw card reaches is a fraction of its own, and they have to be put on one denominator to be compared)',
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
  const scorers: Scorer[] = [];
  /** Each scorer's hand size, by index: with draw cards several share one. */
  const owners: number[] = [];
  problem.handSizes.forEach((hand, at) => {
    for (const scorer of createScorers(partProblem(problem, hand), hand.H, opts)) {
      scorers.push(scorer);
      owners.push(at);
    }
  });
  const weights = owners.map((at) => problem.handSizes[at]!.weight);
  // Over the HAND SIZES, not over the parts. With draw cards a hand size has
  // several parts — one per prefix length — whose fractions SUM to its score,
  // so dividing by the parts' weights would report the score divided by the
  // number of lengths. It would rank correctly and show a wrong number, which
  // is the worst place for this to hide.
  const totalWeight = problem.handSizes.reduce((sum, { weight }) => sum + weight, 0);
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
      const parts = scorers.map((scorer, at): BlendPart => {
        const part: BlendPart = { H: scorer.H, weight: weights[at]!, ...scorer.score(n) };
        if (scorer.prefix !== undefined) part.prefix = scorer.prefix;
        return part;
      });
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
    a.parts.every(
      (part, at) =>
        part.H === b.parts[at]!.H &&
        part.weight === b.parts[at]!.weight &&
        part.prefix === b.parts[at]!.prefix,
    );
  if (!sameShape)
    throw new RangeError(
      'only scores over the same hand sizes, weights and prefix lengths can be compared',
    );

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
