import { describe, expect, it } from 'vitest';
import type { Expr, FlatCriterion } from '../../../src/core/criteria/ast';
import { expandAll } from '../../../src/core/criteria/expand';
import { type CompiledCriterion, type Problem, partProblem } from '../../../src/core/model/problem';
import { estimate } from '../../../src/core/prob/montecarlo';
import {
  type BlendPart,
  type BlendScore,
  compareScores,
  createBlendScorer,
  createScorer,
  scoreBlend,
} from '../../../src/core/prob/scorer';
import { same } from '../../helpers/assert';
// The multiplicative formula and plain listing: the routes the engine does not take.
import { choose, combinations } from '../../helpers/combinatorics';
import { satisfiesAnyFlat, satisfiesFlat, satisfiesTree } from '../../helpers/criteria-oracle';
import { genClassProblem, genCriterion, genMask } from '../../helpers/gen-class-problem';
import {
  columnOf,
  deckOf,
  fillsOf,
  type Generated,
  genProblem,
  hasRange,
  hasSplit,
  smallProblems,
  smallRangedProblems,
  smallSplitProblems,
} from '../../helpers/gen-problem';
import { referenceNumerator, referenceWeightedNumerator } from '../../helpers/matcher-oracle';
import { type Rng, seededRng } from '../../helpers/prng';
import { problemFromMatrix } from '../../helpers/problem-from-matrix';

function problemOf(
  deckSize: number,
  classCount: number,
  criteria: CompiledCriterion[],
  handSizes: Problem['handSizes'] = [{ H: 5, weight: 1 }],
): Problem {
  return {
    deckSize,
    handSizes,
    classes: Array.from({ length: classCount }, (_, cls) => ({
      lineIds: [`class${cls}`],
      min: 0,
      max: deckSize,
    })),
    criteria,
  };
}

const A = 0b010;
const B = 0b100;

/**
 * An UNWEIGHTED score: the weighted numerator and the plain success count are
 * one and the same number when no criterion carries a weight, which is the
 * whole of what makes a template without weighting behave exactly as it did.
 */
const plain = (num: number, den: number) => ({ num, den, successNum: num });

/** In BigInt, for the exact-mean checks: no float is ever the thing compared. */
function lcmOf(a: bigint, b: bigint): bigint {
  let [x, y] = [a, b];
  while (y !== 0n) [x, y] = [y, x % y];
  return (a / x) * b;
}

/** Blank and one class; success is drawing a card of it (TDD §15.1's anchor). */
const ONE_CLASS = problemOf(40, 2, [{ slots: [A], limits: [] }]);

/**
 * The motivating example (PRD §4.2, TDD §11.1) over its five classes, built by
 * hand: blank, card A, card B, `level 4 monster`, and the merged `monster` +
 * `level 7 FIRE beast-warrior monster`. The criterion is `1x [A], 1x [B],
 * 1x monster`, and card A — a Level 4 monster — fills the third slot too.
 */
const MOTIVATING = problemOf(40, 5, [{ slots: [0b00010, 0b00100, 0b11010], limits: [] }]);
/** Every line at its maximum: A 3, B 3, level 4 monster 3, monster 5 + 3, and 23 blank. */
const MOTIVATING_AT_MAX = [23, 3, 3, 3, 8];

describe('createScorer', () => {
  // S1 — closed-form anchors: exact equality, never a tolerance.
  it('scores three copies in forty, five drawn, as exactly 222,111 / 658,008', () => {
    expect(createScorer(ONE_CLASS, 5).score([37, 3])).toEqual(plain(222111, 658008));
  });

  it('scores the same deck at a hand of six as 1 - C(37,6)/C(40,6)', () => {
    expect(choose(40, 6)).toBe(3838380);
    expect(createScorer(ONE_CLASS, 6).score([37, 3])).toEqual(
      plain(3838380 - choose(37, 6), 3838380),
    );
  });

  it('scores "at least 2 of 6" as the sum of its hypergeometric terms', () => {
    const problem = problemOf(40, 2, [{ slots: [A, A], limits: [] }]);
    let num = 0;
    for (let drawn = 2; drawn <= 5; drawn++) num += choose(6, drawn) * choose(34, 5 - drawn);
    expect(num).toBe(15 * 5984 + 20 * 561 + 15 * 34 + 6);
    expect(createScorer(problem, 5).score([34, 6])).toEqual(plain(num, 658008));
  });

  it('scores "exactly one", written with a limit, as one hypergeometric term', () => {
    const problem = problemOf(40, 2, [{ slots: [A], limits: [{ mask: A, n: 1 }] }]);
    expect(createScorer(problem, 5).score([34, 6])).toEqual(plain(6 * choose(34, 4), 658008));
  });

  it('scores two classes that share a slot by inclusion and exclusion', () => {
    // `1x A, 1x (A or B)`: at least two of A-or-B, not all of them B.
    const problem = problemOf(40, 3, [{ slots: [A, A | B], limits: [] }]);
    const twoOfEither = choose(40, 5) - choose(33, 5) - 7 * choose(33, 4);
    let allB = 0;
    for (let drawn = 2; drawn <= 4; drawn++) allB += choose(4, drawn) * choose(33, 5 - drawn);
    expect(createScorer(problem, 5).score([33, 3, 4])).toEqual(plain(twoOfEither - allB, 658008));
  });

  it('scores the motivating example at its maximum counts as exactly 46,185 / 658,008', () => {
    expect(createScorer(MOTIVATING, 5).score(MOTIVATING_AT_MAX)).toEqual(plain(46185, 658008));
    // The oracle agrees with the figure the TDD derives three other ways.
    expect(referenceNumerator(MOTIVATING, MOTIVATING_AT_MAX, 5)).toBe(46185);
  });

  it('scores any number of decks from one success set', () => {
    const scorer = createScorer(ONE_CLASS, 5);
    for (let copies = 0; copies <= 40; copies++)
      expect(scorer.score([40 - copies, copies])).toEqual(
        plain(658008 - choose(40 - copies, 5), 658008),
      );
    // And again, in another order: no state is carried from deck to deck.
    expect(scorer.score([37, 3]).num).toBe(222111);
    expect(scorer.score([40, 0]).num).toBe(0);
    expect(scorer.score([0, 40]).num).toBe(658008);
  });

  it('returns the numerator alone, for a hot loop that ranks by it', () => {
    const scorer = createScorer(MOTIVATING, 5);
    expect(scorer.numerator(MOTIVATING_AT_MAX)).toBe(46185);
    expect(scorer.numerator([40, 0, 0, 0, 0])).toBe(0);
  });

  it('reports its denominator, how many terms a score sums, and which side it stored', () => {
    const scorer = createScorer(ONE_CLASS, 5);
    // a = 0..5: five succeed, so the one failure is stored.
    expect(scorer).toMatchObject({ H: 5, den: 658008, terms: 1, complemented: true });
    const motivating = createScorer(MOTIVATING, 5);
    expect(motivating.complemented).toBe(false);
    expect(motivating.terms).toBeGreaterThan(0);
    expect(motivating.terms).toBeLessThan(126 / 2);
  });

  it('scores 0 without criteria, and den with a criterion every hand meets', () => {
    expect(createScorer(problemOf(40, 3, []), 5).score([30, 5, 5])).toEqual(plain(0, 658008));
    expect(
      createScorer(problemOf(40, 3, [{ slots: [], limits: [] }]), 5).score([30, 5, 5]),
    ).toEqual(plain(658008, 658008));
  });

  it('scores a deck with an EMPTY blank class, and the blank class alone', () => {
    const problem = problemOf(40, 3, [{ slots: [A], limits: [{ mask: B, n: 4 }] }]);
    // No blank cards: at least one A and not five Bs is everything but the all-B hands.
    expect(createScorer(problem, 5).score([0, 10, 30])).toEqual(
      plain(658008 - choose(30, 5), 658008),
    );
    expect(createScorer(problemOf(40, 1, [{ slots: [], limits: [] }]), 5).score([40])).toEqual(
      plain(658008, 658008),
    );
    expect(createScorer(problemOf(40, 1, []), 5).score([40]).num).toBe(0);
  });

  it('restricts itself to one criterion when asked to', () => {
    const problem = problemOf(40, 3, [
      { slots: [A], limits: [] },
      { slots: [B], limits: [] },
    ]);
    const n = [34, 3, 3];
    expect(createScorer(problem, 5, { criterion: 0 }).score(n).num).toBe(222111);
    expect(createScorer(problem, 5, { criterion: 1 }).score(n).num).toBe(222111);
    expect(createScorer(problem, 5).score(n).num).toBe(658008 - choose(34, 5));
    expect(() => createScorer(problem, 5, { criterion: 2 })).toThrow(/no criterion 2/);
  });

  it('reads class totals from a typed array', () => {
    expect(createScorer(ONE_CLASS, 5).score(Uint8Array.of(37, 3)).num).toBe(222111);
  });

  it('rejects class totals that are not the deck', () => {
    const scorer = createScorer(MOTIVATING, 5);
    expect(() => scorer.score([23, 3, 3, 3])).toThrow(/5 classes/);
    expect(() => scorer.score([24, 3, 3, 3, 8])).toThrow(/41 cards, not the deck size of 40/);
    expect(() => scorer.score([22, 3, 3, 3, 8])).toThrow(/39 cards/);
    expect(() => scorer.score([27, -1, 3, 3, 8])).toThrow(RangeError);
    expect(() => scorer.score([22.5, 3.5, 3, 3, 8])).toThrow(RangeError);
    expect(() => scorer.numerator([24, 3, 3, 3, 8])).toThrow(RangeError);
  });

  it('rejects a hand size outside 1 to 6, and validates the problem', () => {
    expect(() => createScorer(ONE_CLASS, 7)).toThrow(/hand size/);
    expect(() => createScorer(ONE_CLASS, 0)).toThrow(/hand size/);
    expect(() => createScorer(problemOf(40, 2, [{ slots: [A | 1], limits: [] }]), 5)).toThrow(
      /blank class/,
    );
  });
});

const FIRST_OR_SECOND: Problem['handSizes'] = [
  { H: 5, weight: 1 },
  { H: 6, weight: 1 },
];

describe('createBlendScorer', () => {
  it('scores every hand size of the problem, exactly, and keeps the weights beside them', () => {
    const blend = createBlendScorer({ ...ONE_CLASS, handSizes: FIRST_OR_SECOND });
    const score = blend.score([37, 3]);
    expect(score.parts).toEqual([
      { H: 5, weight: 1, ...plain(222111, 658008) },
      { H: 6, weight: 1, ...plain(3838380 - choose(37, 6), 3838380) },
    ]);
    expect(blend.scorers.map((scorer) => scorer.H)).toEqual([5, 6]);
  });

  it('gives one float, for display: the weighted mean of the parts', () => {
    const p5 = 222111 / 658008;
    const p6 = (3838380 - choose(37, 6)) / 3838380;
    const even = createBlendScorer({ ...ONE_CLASS, handSizes: FIRST_OR_SECOND }).score([37, 3]);
    expect(even.pDisplay).toBeCloseTo((p5 + p6) / 2, 12);
    const uneven = createBlendScorer({
      ...ONE_CLASS,
      handSizes: [
        { H: 5, weight: 3 },
        { H: 6, weight: 1 },
      ],
    }).score([37, 3]);
    expect(uneven.pDisplay).toBeCloseTo((3 * p5 + p6) / 4, 12);
    expect(uneven.parts.map((part) => part.weight)).toEqual([3, 1]);
  });

  it('is a plain score when there is one hand size', () => {
    const score = createBlendScorer(MOTIVATING).score(MOTIVATING_AT_MAX);
    expect(score.parts).toEqual([{ H: 5, weight: 1, ...plain(46185, 658008) }]);
    expect(score.pDisplay).toBeCloseTo(0.0702, 4);
  });

  it('gives one exact integer to rank by, which orders decks exactly as compareScores does', () => {
    const handSizes = [
      { H: 5, weight: 3 },
      { H: 6, weight: 2 },
    ];
    const blend = createBlendScorer({ ...MOTIVATING, handSizes });
    const decks: number[][] = [];
    for (let a = 0; a <= 3; a++)
      for (let b = 0; b <= 3; b++)
        for (let level4 = 0; level4 <= 3; level4++)
          decks.push([40 - a - b - level4 - 8, a, b, level4, 8]);
    const keys = decks.map((deck) => blend.rankKey(deck));
    const scores = decks.map((deck) => blend.score(deck));
    let ties = 0;
    decks.forEach((_, i) => {
      expect(Number.isSafeInteger(keys[i])).toBe(true);
      decks.forEach((_, j) => {
        same(Math.sign(keys[i]! - keys[j]!), compareScores(scores[i]!, scores[j]!), () => ({
          a: decks[i],
          b: decks[j],
        }));
        if (i < j && keys[i] === keys[j]) ties++;
      });
    });
    // The 28 decks without an A or without a B all score 0 — exact ties; the other 36 all differ.
    expect(new Set(keys).size).toBe(37);
    expect(ties).toBe((28 * 27) / 2);
    // C(40,6) = C(40,5) · 35/6: on the common denominator a hand of five weighs 35, a hand of six 6.
    const [five, six] = scores[63]!.parts;
    expect(keys[63]).toBe(3 * 35 * five!.num + 2 * 6 * six!.num);
  });

  it('ranks by the numerator itself when there is one hand size of weight 1', () => {
    const blend = createBlendScorer(MOTIVATING);
    expect(blend.rankKey(MOTIVATING_AT_MAX)).toBe(46185);
    const heavy = createBlendScorer({ ...MOTIVATING, handSizes: [{ H: 5, weight: 7 }] });
    expect(heavy.rankKey(MOTIVATING_AT_MAX)).toBe(7 * 46185);
  });

  it('throws from rankKey, and only from rankKey, when the key would leave exact integers', () => {
    const blend = createBlendScorer({
      ...ONE_CLASS,
      handSizes: [
        { H: 5, weight: 2 ** 40 },
        { H: 6, weight: 1 },
      ],
    });
    expect(blend.score([37, 3]).parts[0]!.num).toBe(222111);
    expect(() => blend.rankKey([37, 3])).toThrow(/exact/);
  });

  it('restricts every part to one criterion when asked to', () => {
    const problem = problemOf(
      40,
      3,
      [
        { slots: [A], limits: [] },
        { slots: [B], limits: [] },
      ],
      FIRST_OR_SECOND,
    );
    const parts = createBlendScorer(problem, { criterion: 1 }).score([34, 3, 3]).parts;
    expect(parts.map((part) => part.num)).toEqual([222111, 3838380 - choose(37, 6)]);
  });

  /**
   * Each hand judged by ITS OWN criteria (PRD §5.5): going first over the
   * criteria for going first, going second over those for going second, and
   * both over the SAME classes, so the average is an average of two readings
   * of one deck.
   */
  describe('criteria per part', () => {
    /** Draw A going first; draw B going second. Three classes: blank, A, B. */
    const TWO_WAYS = problemOf(
      40,
      3,
      [
        { slots: [A], limits: [] },
        { slots: [B], limits: [] },
      ],
      [
        { H: 5, weight: 1, criteria: [0] },
        { H: 6, weight: 1, criteria: [1] },
      ],
    );

    it('scores each hand against the criteria named for it', () => {
      // Three copies of A and three of B: going first asks only for an A,
      // going second only for a B, and a hand of six sees more cards.
      const parts = createBlendScorer(TWO_WAYS).score([34, 3, 3]).parts;
      expect(parts).toEqual([
        { H: 5, weight: 1, ...plain(658008 - choose(37, 5), 658008) },
        { H: 6, weight: 1, ...plain(3838380 - choose(37, 6), 3838380) },
      ]);
    });

    it('is the same as judging each part alone, at its own hand size', () => {
      const totals = [30, 4, 6];
      const both = createBlendScorer(TWO_WAYS).score(totals).parts;
      const alone = (criterion: number, H: number) =>
        createScorer({ ...TWO_WAYS, handSizes: [{ H, weight: 1 }] }, H, { criterion }).score(
          totals,
        );
      expect(both[0]).toMatchObject(alone(0, 5));
      expect(both[1]).toMatchObject(alone(1, 6));
    });

    it('ranks by the exact mean of the two, which is `rankKey` over the common denominator', () => {
      const blend = createBlendScorer(TWO_WAYS);
      const totals = [30, 4, 6];
      const [first, second] = blend.score(totals).parts as unknown as [BlendPart, BlendPart];
      // C(40,6) = C(40,5) · 35/6, so the common denominator is C(40,6) · 6.
      expect(blend.rankKey(totals)).toBe(35 * first.num + 6 * second.num);
      expect(blend.score(totals).pDisplay).toBeCloseTo(
        (first.num / first.den + second.num / second.den) / 2,
        12,
      );
    });

    it('scores a part with NO criteria as 0, and averages the other in halved', () => {
      const lonely = {
        ...TWO_WAYS,
        handSizes: [TWO_WAYS.handSizes[0]!, { H: 6, weight: 1, criteria: [] }],
      };
      const score = createBlendScorer(lonely).score([34, 3, 3]);
      expect(score.parts[1]).toEqual({ H: 6, weight: 1, ...plain(0, 3838380) });
      expect(score.pDisplay).toBeCloseTo((658008 - choose(37, 5)) / 658008 / 2, 12);
    });

    it('hands both parts the same class vector, read against the same classes', () => {
      // A total of 3 in class 1 is three copies of A to BOTH parts: they are
      // built from one `classes`, so a vector cannot mean two things.
      const blend = createBlendScorer(TWO_WAYS);
      expect(() => blend.score([34, 3])).toThrow(/3 classes/);
      expect(() => blend.score([34, 3, 2])).toThrow(/not the deck size/);
    });

    it("refuses criteria indices that are not the problem's", () => {
      const bad = { ...TWO_WAYS, handSizes: [{ H: 5, weight: 1, criteria: [0, 2] }] };
      expect(() => createBlendScorer(bad)).toThrow(/not one of the problem's 2 criteria/);
      const twice = { ...TWO_WAYS, handSizes: [{ H: 5, weight: 1, criteria: [1, 1] }] };
      expect(() => createBlendScorer(twice)).toThrow(/criterion 1 appears twice/);
    });
  });
});

describe('scoreBlend', () => {
  it('is the one-shot form of createBlendScorer', () => {
    const problem = { ...MOTIVATING, handSizes: FIRST_OR_SECOND };
    const score = scoreBlend(problem, MOTIVATING_AT_MAX);
    expect(score).toEqual(createBlendScorer(problem).score(MOTIVATING_AT_MAX));
    expect(score.parts[0]).toEqual({ H: 5, weight: 1, ...plain(46185, 658008) });
    expect(score.parts[1]!.num).toBe(referenceNumerator(problem, MOTIVATING_AT_MAX, 6));
    expect(score.parts[1]!.den).toBe(3838380);
  });
});

/** A blend score over C(40,5) and C(40,6), or C(60,5) and C(60,6); `pDisplay` is deliberately junk. */
function blendOf(nums: readonly [number, number], weights = [1, 1], deckSize = 40): BlendScore {
  return {
    parts: [5, 6].map((H, at) => ({
      H,
      weight: weights[at]!,
      ...plain(nums[at]!, choose(deckSize, H)),
    })),
    pDisplay: Number.NaN,
  };
}

describe('compareScores', () => {
  const single = (num: number, den = 658008): BlendScore => ({
    parts: [{ H: 5, weight: 1, ...plain(num, den) }],
    pDisplay: Number.NaN,
  });

  it('ranks plain scores by their numerators', () => {
    expect(compareScores(single(222111), single(222110))).toBe(1);
    expect(compareScores(single(222110), single(222111))).toBe(-1);
    expect(compareScores(single(222111), single(222111))).toBe(0);
  });

  it('sorts ascending as an Array comparator', () => {
    const scores = [5, 1, 4, 1, 3].map((num) => single(num));
    expect(scores.sort(compareScores).map((score) => score.parts[0]!.num)).toEqual([1, 1, 3, 4, 5]);
  });

  it('compares across denominators by cross-multiplying', () => {
    // 1/3 of each deck, then one hand more.
    expect(compareScores(single(219336, 658008), single(1279460, 3838380))).toBe(0);
    expect(compareScores(single(219337, 658008), single(1279460, 3838380))).toBe(1);
    expect(compareScores(single(219336, 658008), single(1279461, 3838380))).toBe(-1);
  });

  it('calls an exact tie of a blend a tie', () => {
    // C(40,6) = C(40,5) · 35/6, so 6 hands of five weigh exactly what 35 hands of six do.
    expect(compareScores(blendOf([100006, 200000]), blendOf([100000, 200035]))).toBe(0);
    expect(compareScores(blendOf([100006, 200001]), blendOf([100000, 200035]))).toBe(1);
    expect(compareScores(blendOf([100006, 200000]), blendOf([100000, 200036]))).toBe(-1);
  });

  it('weighs each part by ITS weight', () => {
    // Even weights tie; 3:2 tips towards the better hand of five, 2:3 towards the better hand of six.
    const a = [100006, 200000] as const;
    const b = [100000, 200035] as const;
    expect(compareScores(blendOf(a, [3, 2]), blendOf(b, [3, 2]))).toBe(1);
    expect(compareScores(blendOf(a, [2, 3]), blendOf(b, [2, 3]))).toBe(-1);
    // And 3:2 has exact ties of its own: 3 · 4/C(40,5) = 2 · 35/C(40,6).
    expect(
      compareScores(blendOf([100004, 200000], [3, 2]), blendOf([100000, 200035], [3, 2])),
    ).toBe(0);
  });

  it('ignores the display float entirely', () => {
    const better = { ...blendOf([100001, 200000]), pDisplay: 0 };
    const worse = { ...blendOf([100000, 200000]), pDisplay: 1 };
    expect(compareScores(better, worse)).toBe(1);
  });

  it('agrees with exact rational arithmetic on generated blends, at the largest denominators', () => {
    const rng = seededRng(77);
    const exactSign = (a: BlendScore, b: BlendScore): number => {
      // Test code may use BigInt; the engine may not.
      let diff = 0n;
      const [five, six] = [BigInt(a.parts[0]!.den), BigInt(a.parts[1]!.den)];
      diff += BigInt(a.parts[0]!.weight) * BigInt(a.parts[0]!.num - b.parts[0]!.num) * six;
      diff += BigInt(a.parts[1]!.weight) * BigInt(a.parts[1]!.num - b.parts[1]!.num) * five;
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    };
    const seen = { [-1]: 0, 0: 0, 1: 0 };
    for (let round = 0; round < 4000; round++) {
      const deckSize = rng.pick([40, 60]);
      const weights = [rng.int(1, 9), rng.int(1, 9)];
      const den5 = choose(deckSize, 5);
      const den6 = choose(deckSize, 6);
      const a = [rng.int(0, den5), rng.int(0, den6)] as const;
      // Near `a`, the two parts pulling in opposite directions by amounts that cancel exactly
      // (C(N,6) = C(N,5) · (N - 5)/6) — then, two times in three, nudged by one hand.
      const sixesPerFive = deckSize - 5;
      const step = rng.int(-3, 3);
      const b = [
        Math.min(den5, Math.max(0, a[0] + step * weights[1]! * 6)),
        Math.min(den6, Math.max(0, a[1] - step * weights[0]! * sixesPerFive + rng.int(-1, 1))),
      ] as const;
      const [x, y] = [blendOf(a, weights, deckSize), blendOf(b, weights, deckSize)];
      const sign = compareScores(x, y);
      same(sign, exactSign(x, y), () => ({ x, y }));
      same(compareScores(y, x), -sign, () => ({ x, y, flipped: true }));
      seen[sign as -1 | 0 | 1]++;
    }
    // All three outcomes are well represented, exact ties included.
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(400);
  });

  it('refuses to compare scores of different shapes', () => {
    expect(() => compareScores(single(1), blendOf([1, 1]))).toThrow(/same hand sizes and weights/);
    expect(() => compareScores(blendOf([1, 1], [1, 1]), blendOf([1, 1], [1, 2]))).toThrow(
      /same hand sizes and weights/,
    );
  });

  it('throws rather than answer inexactly when the integers would leave float64', () => {
    const huge = [2 ** 50, 1];
    expect(() => compareScores(blendOf([9, 1], huge, 60), blendOf([1, 9], huge, 60))).toThrow(
      /exact/,
    );
  });
});

// ---------------------------------------------------------------------------
// S2 — exhaustive enumeration, the main oracle: exact, nothing sampled. Every
// one of the C(N, H) hands of the CONCRETE deck is judged by the criteria
// oracle; the count of successes is the numerator.
// ---------------------------------------------------------------------------

/** Other line counts for the same problem, zeros included: one success set scores them all. */
function otherCounts(rng: Rng, g: Generated): number[] {
  for (;;) {
    const counts = g.counts.map(() => rng.int(0, 3));
    if (counts.reduce((sum, n) => sum + n, 0) <= g.problem.deckSize) return counts;
  }
}

function enumerate(g: Generated, counts: readonly number[], flat: readonly FlatCriterion[]) {
  const hands = combinations(deckOf(g.problem, counts), g.handSize);
  const fills = fillsOf(g.problem);
  return {
    hands: hands.length,
    successes: hands.filter((hand) => satisfiesAnyFlat(flat, hand, fills)).length,
  };
}

describe('exact scorer against exhaustive enumeration of small decks', () => {
  const generated = smallProblems();

  it('generates problems worth testing', () => {
    expect(generated.length).toBeGreaterThanOrEqual(200);
    const flats = generated.flatMap((g) => g.problem.flat);
    // Limits, n× counts, criterion-level `or` (several alternatives), nested `or`…
    expect(flats.filter((f) => f.limits.length > 0).length).toBeGreaterThanOrEqual(100);
    expect(flats.filter((f) => f.reqs.some((r) => r.n > 1)).length).toBeGreaterThanOrEqual(100);
    expect(generated.filter((g) => g.problem.flat.length > 1).length).toBeGreaterThanOrEqual(80);
    const nestedOr = generated.filter((g) =>
      g.exprs.some((e) => e.op === 'and' && e.args.some((arg) => arg.op === 'or')),
    );
    expect(nestedOr.length).toBeGreaterThanOrEqual(40);
    // …lines that fill several columns, and remainders that are not blank.
    const overlapping = generated.filter(({ problem }) =>
      problem.matrix.some((row) => row.filter(Boolean).length > 1),
    );
    expect(overlapping.length).toBeGreaterThanOrEqual(150);
    const emptyBlank = generated.filter(({ problem }) => problem.matrix.at(-1)!.some(Boolean));
    expect(emptyBlank.length).toBeGreaterThanOrEqual(30);
    // Both storages are exercised, and most problems are decided by chance.
    const scorers = generated.map((g) =>
      createScorer(problemFromMatrix(g.problem, [g.handSize]).problem, g.handSize),
    );
    expect(scorers.filter((scorer) => scorer.complemented).length).toBeGreaterThanOrEqual(30);
    expect(scorers.filter((scorer) => !scorer.complemented).length).toBeGreaterThanOrEqual(100);
    const p = generated.map((g) => {
      const { hands, successes } = enumerate(g, g.counts, g.flat);
      return successes / hands;
    });
    expect(p.filter((value) => value > 0.02 && value < 0.98).length).toBeGreaterThanOrEqual(150);
  });

  it('counts exactly the successful hands of every deck, problem by problem', () => {
    let decks = 0;
    let hands = 0;
    generated.forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const scorer = createScorer(converted.problem, g.handSize);
      const rng = seededRng(41_000 + i);
      for (const counts of [g.counts, otherCounts(rng, g), otherCounts(rng, g)]) {
        const exact = enumerate(g, counts, g.flat);
        const context = () => ({ index: i, counts, problem: g.problem, handSize: g.handSize });
        same(exact.hands, choose(g.problem.deckSize, g.handSize), context);
        const { num, den } = scorer.score(converted.totals(counts));
        same(num, exact.successes, context);
        same(den, exact.hands, context);
        decks++;
        hands += exact.hands;
      }
    });
    // Pinned so the size of the check is on record; it moves only if the generator does.
    expect({ decks, hands }).toEqual({ decks: 720, hands: 288_933 });
  });

  it('counts the same hands as the UNEXPANDED criteria do', () => {
    generated.slice(0, 80).forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const fills = fillsOf(g.problem);
      const successes = combinations(deckOf(g.problem, g.counts), g.handSize).filter((hand) =>
        g.exprs.some((expr) => satisfiesTree(expr, hand, fills)),
      ).length;
      const { num } = createScorer(converted.problem, g.handSize).score(converted.totals(g.counts));
      same(num, successes, () => ({ index: i, problem: g.problem }));
    });
  });

  it('counts the successful hands of each criterion alone', () => {
    let criteria = 0;
    generated.slice(0, 120).forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const hands = combinations(deckOf(g.problem, g.counts), g.handSize);
      const fills = fillsOf(g.problem);
      g.flat.forEach((flat, criterion) => {
        const scorer = createScorer(converted.problem, g.handSize, { criterion });
        const successes = hands.filter((hand) => satisfiesFlat(flat, hand, fills)).length;
        same(scorer.score(converted.totals(g.counts)).num, successes, () => ({
          index: i,
          criterion,
          problem: g.problem,
        }));
        criteria++;
      });
    });
    expect(criteria).toBeGreaterThanOrEqual(200);
  });
});

/**
 * The two-part blend against exhaustive enumeration (PRD §5.5). The route
 * under test runs the whole way — criterion trees tagged one hand or the
 * other; `expandAll`'s deduplication and its `sources`; ONE class partition,
 * from the union of both sets; a success set per part over only its own
 * alternatives; and the blend over both — and the oracle takes none of it: it
 * lists every hand of the concrete deck, twice, and judges each against the
 * ORIGINAL criterion trees of that part with `satisfiesTree`.
 *
 * What this really holds is that the two parts score ONE deck. The oracle
 * deals both hand lists off the same physical deck, so a partition that meant
 * different things to the two parts would put the answer somewhere it never
 * goes.
 */
describe('a hand of five and a hand of six, each judged by its own criteria', () => {
  interface Split {
    g: Generated;
    problem: Problem;
    totals: number[];
    deck: number[];
    hands: [number, number];
    /** The criterion trees of each part, as written. */
    exprs: [Expr[], Expr[]];
  }

  /**
   * A generated problem read as two tagged criteria sets: criterion 0 going
   * first, criterion 1 going second, any others counting for both. The union
   * is expanded at the LARGER hand, as a blend must be (TDD §8).
   */
  function split(g: Generated): Split | null {
    const hands: [number, number] = [g.handSize, g.handSize + 1];
    if (g.exprs.length < 2 || hands[1] > 6 || hands[1] > g.problem.deckSize) return null;
    const mine: [Set<number>, Set<number>] = [new Set(), new Set()];
    g.exprs.forEach((_, at) => {
      if (at !== 1) mine[0].add(at);
      if (at !== 0) mine[1].add(at);
    });
    const all = expandAll(g.exprs, { maxHandSize: hands[1] });
    if (!all.ok) return null;
    const flat = all.flat.map(({ reqs, limits }) => ({
      reqs: reqs.map(({ n, max, desc }) => {
        const at = columnOf(desc);
        return max === undefined ? { n, desc: at } : { n, max, desc: at };
      }),
      limits: limits.map(({ n, desc }) => ({ n, desc: columnOf(desc) })),
    }));
    const converted = problemFromMatrix({ ...g.problem, flat }, hands);
    return {
      g,
      problem: {
        ...converted.problem,
        handSizes: converted.problem.handSizes.map((hand, part) => ({
          ...hand,
          criteria: all.sources.flatMap((owners, at) =>
            owners.some((who) => mine[part]!.has(who)) ? [at] : [],
          ),
        })),
      },
      totals: converted.totals(g.counts),
      deck: deckOf(g.problem, g.counts),
      hands,
      exprs: [
        g.exprs.filter((_, at) => mine[0]!.has(at)),
        g.exprs.filter((_, at) => mine[1]!.has(at)),
      ],
    };
  }

  const splits = smallProblems()
    .map(split)
    .filter((s): s is Split => s !== null);

  it('generates two-part problems worth testing', () => {
    expect(splits.length).toBeGreaterThanOrEqual(80);
    // The parts really are judged differently: their alternative lists differ.
    const differing = splits.filter(
      ({ problem }) =>
        problem.handSizes[0]!.criteria!.join(',') !== problem.handSizes[1]!.criteria!.join(','),
    );
    expect(differing.length).toBeGreaterThanOrEqual(80);
    // The partition is the UNION's: some class is told apart by a description
    // only one part's criteria ever mention.
    const refined = splits.filter(
      ({ problem }) => problem.classes.length > problem.handSizes[0]!.criteria!.length + 1,
    );
    expect(refined.length).toBeGreaterThanOrEqual(20);
  });

  it('counts each part over its own criteria, both over the same deck', () => {
    let parts = 0;
    let hands = 0;
    splits.slice(0, 120).forEach((s, i) => {
      const fills = fillsOf(s.g.problem);
      const score = createBlendScorer(s.problem).score(s.totals);
      s.hands.forEach((H, part) => {
        const own = s.exprs[part]!;
        const all = combinations(s.deck, H);
        const successes = all.filter((hand) =>
          own.some((expr) => satisfiesTree(expr, hand, fills)),
        ).length;
        same(score.parts[part]!.num, successes, () => ({ index: i, part, problem: s.g.problem }));
        same(score.parts[part]!.den, all.length, () => ({ index: i, part }));
        parts++;
        hands += all.length;
      });
    });
    // Pinned so the size of the check is on record; it moves only if the generator does.
    expect({ parts, hands }).toEqual({ parts: 210, hands: 120_699 });
  });

  it('shows the mean of the two, and ranks by an integer that orders decks the same way', () => {
    splits.slice(0, 60).forEach((s, i) => {
      const blend = createBlendScorer(s.problem);
      const score = blend.score(s.totals);
      const [a, b] = score.parts as [BlendPart, BlendPart];
      expect(score.pDisplay).toBeCloseTo((a.num / a.den + b.num / b.den) / 2, 12);
      // `rankKey` is the mean over ONE denominator: cross-multiplied in
      // BigInt, with no float anywhere, it is the same rational.
      const common = lcmOf(BigInt(a.den), BigInt(b.den));
      same(
        BigInt(blend.rankKey(s.totals)),
        BigInt(a.num) * (common / BigInt(a.den)) + BigInt(b.num) * (common / BigInt(b.den)),
        () => ({ index: i }),
      );
    });
  });

  it('agrees with judging each part as a problem of its own', () => {
    splits.slice(0, 120).forEach((s, i) => {
      const together = createBlendScorer(s.problem).score(s.totals);
      s.problem.handSizes.forEach((hand, part) => {
        const alone = createBlendScorer(partProblem(s.problem, hand)).score(s.totals);
        same(alone.parts[0]!.num, together.parts[part]!.num, () => ({ index: i, part }));
      });
    });
  });
});

describe('exact scorer against exhaustive enumeration, with range requirements', () => {
  const generated = smallRangedProblems();

  it('generates problems worth testing', () => {
    expect(generated.filter(hasRange).length).toBeGreaterThanOrEqual(150);
    const reqs = generated.flatMap((g) => g.problem.flat.flatMap((f) => f.reqs));
    // Ceilings that bind, ceilings at zero, and ranges wider than one card.
    expect(reqs.filter((r) => r.max !== undefined).length).toBeGreaterThanOrEqual(200);
    expect(reqs.filter((r) => r.max === 0).length).toBeGreaterThanOrEqual(10);
    expect(reqs.filter((r) => r.max !== undefined && r.max > r.n).length).toBeGreaterThanOrEqual(
      100,
    );
    // And a healthy mix of verdicts, or the agreement would be vacuous.
    const p = generated.map((g) => {
      const { hands, successes } = enumerate(g, g.counts, g.flat);
      return successes / hands;
    });
    expect(p.filter((value) => value > 0.02 && value < 0.98).length).toBeGreaterThanOrEqual(100);
  });

  it('counts exactly the successful hands of every deck, every C(N, H) hand judged both ways', () => {
    let decks = 0;
    let hands = 0;
    generated.forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const scorer = createScorer(converted.problem, g.handSize);
      const rng = seededRng(43_000 + i);
      for (const counts of [g.counts, otherCounts(rng, g)]) {
        const exact = enumerate(g, counts, g.flat);
        const context = () => ({ index: i, counts, problem: g.problem, handSize: g.handSize });
        const { num, den } = scorer.score(converted.totals(counts));
        same(num, exact.successes, context);
        same(den, exact.hands, context);
        decks++;
        hands += exact.hands;
      }
    });
    expect({ decks, hands }).toEqual({ decks: 480, hands: 183_044 });
  });

  it('counts the same hands as the UNEXPANDED criteria do', () => {
    generated.slice(0, 80).forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const fills = fillsOf(g.problem);
      const successes = combinations(deckOf(g.problem, g.counts), g.handSize).filter((hand) =>
        g.exprs.some((expr) => satisfiesTree(expr, hand, fills)),
      ).length;
      const { num } = createScorer(converted.problem, g.handSize).score(converted.totals(g.counts));
      same(num, successes, () => ({ index: i, problem: g.problem }));
    });
  });

  it('counts the successful hands of each criterion alone', () => {
    let criteria = 0;
    generated.slice(0, 120).forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const hands = combinations(deckOf(g.problem, g.counts), g.handSize);
      const fills = fillsOf(g.problem);
      g.flat.forEach((flat, criterion) => {
        const scorer = createScorer(converted.problem, g.handSize, { criterion });
        const successes = hands.filter((hand) => satisfiesFlat(flat, hand, fills)).length;
        same(scorer.score(converted.totals(g.counts)).num, successes, () => ({
          index: i,
          criterion,
          problem: g.problem,
        }));
        criteria++;
      });
    });
    expect(criteria).toBeGreaterThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// S4 — the differential gate (TDD §15.1): the exact engine and the Monte Carlo
// oracle share no code, and must agree at the sizes the app runs at.
// ---------------------------------------------------------------------------

describe('exact scorer against the Monte Carlo oracle', () => {
  const PROBLEMS = 56;
  const SAMPLES = 100_000;
  const realistic = Array.from({ length: PROBLEMS }, (_, i) =>
    genProblem(seededRng(88_000 + i), {
      lines: [5, 10],
      columns: [3, 6],
      deckSize: [40, 40],
      handSize: [5, 6],
      copies: [1, 3],
      fill: 0.4,
    }),
  );

  it('agrees within five standard errors on every realistic problem', () => {
    let nonDegenerate = 0;
    let uncertain = 0;
    let worst = 0;
    let sumOfSquares = 0;
    realistic.forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const { num, den } = createScorer(converted.problem, g.handSize).score(
        converted.totals(g.counts),
      );
      const result = estimate(g.problem, g.counts, {
        handSize: g.handSize,
        samples: SAMPLES,
        seed: 500 + i,
      });
      const context = () => ({ index: i, num, den, hits: result.hits, problem: g.problem });
      if (num === 0 || num === den) {
        // A certain outcome must be hit exactly.
        same(result.hits, num === 0 ? 0 : SAMPLES, context);
        return;
      }
      const p = num / den;
      const z = (result.hits / SAMPLES - p) / Math.sqrt((p * (1 - p)) / SAMPLES);
      if (Math.abs(z) > 5)
        throw new Error(`${z.toFixed(2)} standard errors apart: ${JSON.stringify(context())}`);
      worst = Math.max(worst, Math.abs(z));
      sumOfSquares += z * z;
      uncertain++;
      if (p > 0.02 && p < 0.98) nonDegenerate++;
    });
    expect(realistic.length).toBeGreaterThanOrEqual(40);
    expect(realistic.filter((g) => g.handSize === 5).length).toBeGreaterThanOrEqual(15);
    expect(realistic.filter((g) => g.handSize === 6).length).toBeGreaterThanOrEqual(15);
    // The gate means something only where the outcome is in doubt.
    expect(nonDegenerate).toBeGreaterThanOrEqual(40);
    // Deterministic, given the seeds: on record, and a drift in either engine moves them.
    expect({ nonDegenerate, uncertain, worst: worst.toFixed(2) }).toEqual({
      nonDegenerate: 41,
      uncertain: 47,
      worst: '2.35',
    });
    // Unbiased agreement has z-scores of unit variance; a bias of a few parts in a thousand does not.
    expect(Math.sqrt(sumOfSquares / uncertain)).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// S5 — complement storage is an encoding, never a different answer.
// ---------------------------------------------------------------------------

describe('complement storage', () => {
  it('never changes a numerator, whichever side is stored', () => {
    let complementedByChoice = 0;
    smallProblems().forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const n = converted.totals(g.counts);
      const auto = createScorer(converted.problem, g.handSize);
      const kept = createScorer(converted.problem, g.handSize, { storage: 'successes' });
      const complement = createScorer(converted.problem, g.handSize, { storage: 'complement' });
      expect(kept.complemented).toBe(false);
      expect(complement.complemented).toBe(true);
      expect(auto.terms).toBe(Math.min(kept.terms, complement.terms));
      same(kept.numerator(n), auto.numerator(n), () => ({ index: i, storage: 'successes' }));
      same(complement.numerator(n), auto.numerator(n), () => ({ index: i, storage: 'complement' }));
      if (auto.complemented) complementedByChoice++;
    });
    expect(complementedByChoice).toBeGreaterThanOrEqual(30);
  });

  it('holds at realistic size too, where the numerators are large', () => {
    for (let seed = 0; seed < 40; seed++) {
      const { problem, H, totals } = genClassProblem(seededRng(93_000 + seed), {
        classes: [4, 9],
        deckSize: [40, 60],
        handSize: [5, 6],
        slots: [0, 4],
        criteria: [1, 3],
      });
      const kept = createScorer(problem, H, { storage: 'successes' }).numerator(totals);
      const complement = createScorer(problem, H, { storage: 'complement' }).numerator(totals);
      same(complement, kept, () => ({ seed, problem, totals }));
    }
  });
});

// ---------------------------------------------------------------------------
// S6 — properties.
// ---------------------------------------------------------------------------

const CLASS_PROBLEMS = {
  classes: [2, 6],
  deckSize: [40, 60],
  handSize: [1, 6],
  slots: [0, 4],
  criteria: [1, 3],
} as const;

describe('properties of the exact score', () => {
  const ROUNDS = 150;
  const cases = Array.from({ length: ROUNDS }, (_, seed) => ({
    seed,
    rng: seededRng(74_000 + seed),
    ...genClassProblem(seededRng(73_000 + seed), CLASS_PROBLEMS),
  }));
  const numeratorOf = (problem: Problem, H: number, totals: readonly number[]) =>
    createScorer(problem, H).numerator(totals);

  it('lies between 0 and the denominator, in safe integers, and equals the slow reference sum', () => {
    let nonDegenerate = 0;
    for (const { seed, problem, H, totals } of cases) {
      const { num, den } = createScorer(problem, H).score(totals);
      expect(Number.isSafeInteger(num)).toBe(true);
      expect(Number.isSafeInteger(den)).toBe(true);
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThanOrEqual(den);
      same(den, choose(problem.deckSize, H), () => ({ seed }));
      same(num, referenceNumerator(problem, totals, H), () => ({ seed, problem, totals, H }));
      if (num > 0 && num < den) nonDegenerate++;
    }
    expect(nonDegenerate).toBeGreaterThanOrEqual(ROUNDS / 3);
  });

  it('never rises when a requirement slot is added', () => {
    let fell = 0;
    for (const { seed, rng, problem, H, totals } of cases) {
      const at = rng.int(0, problem.criteria.length - 1);
      const harder: Problem = {
        ...problem,
        criteria: problem.criteria.map((criterion, i) =>
          i === at
            ? { ...criterion, slots: [...criterion.slots, genMask(rng, problem.classes.length)] }
            : criterion,
        ),
      };
      const [before, after] = [numeratorOf(problem, H, totals), numeratorOf(harder, H, totals)];
      if (after > before) throw new Error(`rose from ${before} to ${after}: seed ${seed}`);
      if (after < before) fell++;
    }
    expect(fell).toBeGreaterThanOrEqual(20);
  });

  it('never falls when an alternative criterion is added', () => {
    let rose = 0;
    for (const { seed, rng, problem, H, totals } of cases) {
      const easier: Problem = {
        ...problem,
        criteria: [...problem.criteria, genCriterion(rng, problem.classes.length, [1, 3])],
      };
      const [before, after] = [numeratorOf(problem, H, totals), numeratorOf(easier, H, totals)];
      if (after < before) throw new Error(`fell from ${before} to ${after}: seed ${seed}`);
      if (after > before) rose++;
    }
    expect(rose).toBeGreaterThanOrEqual(20);
  });

  it('never falls when a limit is loosened: raised, narrowed, or dropped', () => {
    let rose = 0;
    let loosened = 0;
    for (const { seed, problem, H, totals } of cases) {
      const at = problem.criteria.findIndex((criterion) => criterion.limits.length > 0);
      if (at < 0) continue;
      const limits = problem.criteria[at]!.limits;
      const [first, ...rest] = limits;
      const variants = [
        [{ mask: first!.mask, n: first!.n + 1 }, ...rest],
        // Fewer classes counted: clear one bit of the mask.
        [{ mask: (first!.mask & (first!.mask - 1)) >>> 0, n: first!.n }, ...rest],
        rest,
      ];
      const before = numeratorOf(problem, H, totals);
      for (const looser of variants) {
        const easier: Problem = {
          ...problem,
          criteria: problem.criteria.map((criterion, i) =>
            i === at ? { ...criterion, limits: looser } : criterion,
          ),
        };
        const after = numeratorOf(easier, H, totals);
        if (after < before) throw new Error(`fell from ${before} to ${after}: seed ${seed}`);
        if (after > before) rose++;
        loosened++;
      }
    }
    expect(loosened).toBeGreaterThanOrEqual(100);
    expect(rose).toBeGreaterThanOrEqual(20);
  });

  it('does not depend on the order of the classes, the blank class staying first', () => {
    let moved = 0;
    for (const { seed, rng, problem, H, totals } of cases) {
      const k = problem.classes.length;
      // `to[c]` is where class `c` goes; a Fisher–Yates shuffle of 1..k-1.
      const to = Array.from({ length: k }, (_, cls) => cls);
      for (let i = k - 1; i > 1; i--) {
        const j = rng.int(1, i);
        [to[i], to[j]] = [to[j]!, to[i]!];
      }
      const permute = (mask: number) => {
        let out = 0;
        for (let cls = 0; cls < k; cls++) if ((mask & (1 << cls)) !== 0) out |= 1 << to[cls]!;
        return out >>> 0;
      };
      const permutedTotals = new Array<number>(k);
      const classes = new Array<Problem['classes'][number]>(k);
      for (let cls = 0; cls < k; cls++) {
        permutedTotals[to[cls]!] = totals[cls]!;
        classes[to[cls]!] = problem.classes[cls]!;
      }
      const permuted: Problem = {
        ...problem,
        classes,
        criteria: problem.criteria.map(({ slots, limits }) => ({
          slots: slots.map(permute),
          limits: limits.map(({ mask, n }) => ({ mask: permute(mask), n })),
        })),
      };
      same(numeratorOf(permuted, H, permutedTotals), numeratorOf(problem, H, totals), () => ({
        seed,
        to,
      }));
      if (to.some((cls, from) => cls !== from)) moved++;
    }
    expect(moved).toBeGreaterThanOrEqual(ROUNDS / 2);
  });

  it('does not depend on the order of the criteria, nor of the slots within one', () => {
    for (const { seed, problem, H, totals } of cases) {
      const reversed: Problem = {
        ...problem,
        criteria: [...problem.criteria]
          .reverse()
          .map(({ slots, limits }) => ({ slots: [...slots].reverse(), limits })),
      };
      same(numeratorOf(reversed, H, totals), numeratorOf(problem, H, totals), () => ({ seed }));
    }
  });

  it('stays in safe integers at the largest problem there is: 60 cards, hands of six, 30 classes', () => {
    // Success is any non-blank card, so the numerator has a closed form.
    const everyClass = 2 ** 30 - 2;
    const easy = problemOf(60, 30, [{ slots: [everyClass], limits: [] }], [{ H: 6, weight: 1 }]);
    const totals = [31, ...new Array<number>(29).fill(1)];
    const scorer = createScorer(easy, 6);
    expect(scorer.den).toBe(50063860);
    expect(scorer.score(totals)).toEqual(plain(50063860 - choose(31, 6), 50063860));
    // The thirtieth class twice over, and `no` anything else: both its copies and four blanks.
    const top = 2 ** 29;
    const hard = problemOf(
      60,
      30,
      [{ slots: [top, top], limits: [{ mask: everyClass - top, n: 0 }] }],
      [{ H: 6, weight: 1 }],
    );
    const deck = [30, ...new Array<number>(28).fill(1), 2];
    const { num, den } = createScorer(hard, 6).score(deck);
    expect(num).toBe(choose(30, 4));
    expect(Number.isSafeInteger(num) && Number.isSafeInteger(den)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S7 — weighted criteria (PRD §5.6). The score becomes the EXPECTED WEIGHT per
// hand: a hand is worth the highest weight among the criteria it meets, and
// the numerator is `Σ w · ways` over the same success set, the same walk and
// the same sample space. The oracle sums the same thing in BigInt over every
// composition, judging each by brute-force assignment.
// ---------------------------------------------------------------------------

/**
 * Three copies of A worth 3, six copies of B worth 1, in forty cards, five
 * drawn. Worked out by hand, and the numbers are all closed forms:
 *
 *     hands with an A            658,008 − C(37,5) = 222,111   → worth 3
 *     hands with a B but no A    C(37,5) − C(31,5) = 265,986   → worth 1
 *     Σ w · ways                 3 · 222,111 + 265,986 = 932,319
 *     P(either)                  658,008 − C(31,5) = 488,097
 *
 * The LIGHTER criterion is deliberately the likelier one (six copies against
 * three), so summing the two instead of taking the larger would give
 * 3 · 222,111 + 488,097 = 1,046,085 — a different number, visibly.
 */
const WEIGHTED_AB = problemOf(40, 3, [
  { slots: [A], limits: [], weight: 3 },
  { slots: [B], limits: [], weight: 1 },
]);
/** Blank 31, A 3, B 6. */
const WEIGHTED_AB_DECK = [31, 3, 6];

describe('createScorer with weighted criteria', () => {
  it('scores the expected weight per hand, worked out by hand', () => {
    expect(choose(37, 5)).toBe(435897);
    expect(choose(31, 5)).toBe(169911);
    const scorer = createScorer(WEIGHTED_AB, 5);
    expect(scorer.maxWeight).toBe(3);
    expect(scorer.score(WEIGHTED_AB_DECK)).toEqual({
      num: 3 * 222111 + 265986,
      den: 658008,
      successNum: 488097,
    });
    expect(scorer.score(WEIGHTED_AB_DECK).num).toBe(932319);
  });

  it('gives the HIGHEST weight to a hand meeting both, never the sum', () => {
    // Summing would reach 1,046,085; every hand holding an A and a B is the gap.
    const summed = 3 * 222111 + (658008 - choose(34, 5));
    expect(summed).toBe(1046085);
    expect(createScorer(WEIGHTED_AB, 5).numerator(WEIGHTED_AB_DECK)).toBeLessThan(summed);
    expect(summed - 932319).toBe(113766);
    // …which is exactly the hands holding both, counted the other way round.
    const both = 658008 - choose(37, 5) - choose(34, 5) + choose(31, 5);
    expect(both).toBe(113766);
  });

  it('is the plain probability again when every weight is 1, explicitly or by default', () => {
    const unweighted = createScorer(
      problemOf(40, 3, [
        { slots: [A], limits: [] },
        { slots: [B], limits: [] },
      ]),
      5,
    );
    const ones = createScorer(
      problemOf(40, 3, [
        { slots: [A], limits: [], weight: 1 },
        { slots: [B], limits: [], weight: 1 },
      ]),
      5,
    );
    expect(ones.score(WEIGHTED_AB_DECK)).toEqual(unweighted.score(WEIGHTED_AB_DECK));
    expect(ones.score(WEIGHTED_AB_DECK)).toEqual(plain(488097, 658008));
    expect(ones.maxWeight).toBe(1);
  });

  it('scales the whole score when every criterion carries the SAME weight', () => {
    const doubled = createScorer(
      problemOf(40, 3, [
        { slots: [A], limits: [], weight: 2 },
        { slots: [B], limits: [], weight: 2 },
      ]),
      5,
    );
    expect(doubled.score(WEIGHTED_AB_DECK)).toEqual({
      num: 2 * 488097,
      den: 658008,
      successNum: 488097,
    });
  });

  it('never changes a numerator between the two storages', () => {
    const kept = createScorer(WEIGHTED_AB, 5, { storage: 'successes' });
    const complement = createScorer(WEIGHTED_AB, 5, { storage: 'complement' });
    expect(kept.complemented).toBe(false);
    expect(complement.complemented).toBe(true);
    expect(complement.score(WEIGHTED_AB_DECK)).toEqual(kept.score(WEIGHTED_AB_DECK));
  });

  it('agrees with the BigInt oracle over generated problems, both storages', () => {
    let nonDegenerate = 0;
    let spread = 0;
    for (let seed = 0; seed < 120; seed++) {
      const rng = seededRng(99_000 + seed);
      const { problem, H, totals } = genClassProblem(seededRng(98_000 + seed), CLASS_PROBLEMS);
      const weighted: Problem = {
        ...problem,
        criteria: problem.criteria.map((criterion) => ({ ...criterion, weight: rng.int(1, 9) })),
      };
      const expected = referenceWeightedNumerator(weighted, totals, H);
      const context = () => ({ seed, problem: weighted, totals, H });
      for (const storage of ['successes', 'complement', 'auto'] as const) {
        const scorer = createScorer(weighted, H, { storage });
        const { num, den, successNum } = scorer.score(totals);
        same(BigInt(num), expected, () => ({ ...context(), storage }));
        expect(Number.isSafeInteger(num)).toBe(true);
        same(num, scorer.numerator(totals), () => ({ ...context(), storage }));
        same(successNum, referenceNumerator(weighted, totals, H), () => ({
          ...context(),
          storage,
        }));
        expect(num).toBeGreaterThanOrEqual(successNum);
        expect(num).toBeLessThanOrEqual(scorer.maxWeight * den);
      }
      const weights = new Set(weighted.criteria.map(({ weight }) => weight));
      if (weights.size > 1) spread++;
      const { num, den } = createScorer(weighted, H).score(totals);
      if (num > 0 && num < den) nonDegenerate++;
    }
    expect(spread).toBeGreaterThanOrEqual(60);
    expect(nonDegenerate).toBeGreaterThanOrEqual(20);
  });
});

describe('the exactness bound on a weight', () => {
  /** The largest weight a deck of 40 and a hand of five leave below 2^53. */
  const LARGEST = Math.floor(Number.MAX_SAFE_INTEGER / 658008);

  it('is `floor((2^53 - 1) / C(N, H))`, and the boundary is where it throws', () => {
    expect(LARGEST).toBe(13_688_586_240);
    const at = problemOf(40, 2, [{ slots: [A], limits: [], weight: LARGEST }]);
    expect(createScorer(at, 5).score([37, 3]).num).toBe(LARGEST * 222111);
    expect(Number.isSafeInteger(LARGEST * 222111)).toBe(true);
    const over = problemOf(40, 2, [{ slots: [A], limits: [], weight: LARGEST + 1 }]);
    expect(() => createScorer(over, 5)).toThrow(/past 2\^53/);
    expect(() => createScorer(over, 5)).toThrow(
      /largest weight this deck and hand allow is 13688586240/,
    );
  });

  it('is measured against the hand the deck is scored at, not the largest there is', () => {
    // C(40,6) is bigger than C(40,5), so a blend refuses what a hand of five allows.
    const weight = LARGEST;
    expect(() => createScorer(problemOf(40, 2, [{ slots: [A], limits: [], weight }]), 6)).toThrow(
      /hand of 6/,
    );
    expect(() =>
      createBlendScorer(problemOf(40, 2, [{ slots: [A], limits: [], weight }], FIRST_OR_SECOND)),
    ).toThrow(/hand of 6/);
  });

  it('refuses a weight that is not a positive whole number, rather than rounding it', () => {
    for (const weight of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => createScorer(problemOf(40, 2, [{ slots: [A], limits: [], weight }]), 5)).toThrow(
        /a weight is a positive whole number/,
      );
    }
  });
});

describe('createBlendScorer with weighted criteria', () => {
  const BLENDED = { ...WEIGHTED_AB, handSizes: FIRST_OR_SECOND };

  it('carries the plain probability of every hand beside its weighted score', () => {
    const score = createBlendScorer(BLENDED).score(WEIGHTED_AB_DECK);
    expect(score.parts[0]).toEqual({
      H: 5,
      weight: 1,
      num: 932319,
      den: 658008,
      successNum: 488097,
    });
    const six = createScorer({ ...WEIGHTED_AB, handSizes: [{ H: 6, weight: 1 }] }, 6);
    expect(score.parts[1]).toMatchObject(six.score(WEIGHTED_AB_DECK));
    // The display float is an EXPECTED WEIGHT, and may pass 1.
    expect(score.pDisplay).toBeGreaterThan(1);
  });

  it('gives two keys over one denominator: the weighted rank, and the probability', () => {
    const blend = createBlendScorer(BLENDED);
    const score = blend.score(WEIGHTED_AB_DECK);
    const keys = blend.keysOf(score);
    const [five, six] = score.parts as [BlendPart, BlendPart];
    // C(40,6) = C(40,5) · 35/6: a hand of five weighs 35, a hand of six 6.
    expect(keys.blend).toBe(35 * five.num + 6 * six.num);
    expect(keys.success).toBe(35 * five.successNum + 6 * six.successNum);
    expect(blend.rankKey(WEIGHTED_AB_DECK)).toBe(keys.blend);
    expect(blend.rankDen).toBe(2 * 6 * 3838380);
    expect(blend.maxWeight).toBe(3);
  });

  it('ranks by the WEIGHTED numerator, so compareScores and rankKey still agree', () => {
    const blend = createBlendScorer(BLENDED);
    const decks: number[][] = [];
    for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) decks.push([40 - a - b, a, b]);
    const keys = decks.map((deck) => blend.rankKey(deck));
    const scores = decks.map((deck) => blend.score(deck));
    decks.forEach((_, i) => {
      expect(Number.isSafeInteger(keys[i])).toBe(true);
      decks.forEach((_, j) => {
        same(Math.sign(keys[i]! - keys[j]!), compareScores(scores[i]!, scores[j]!), () => ({
          a: decks[i],
          b: decks[j],
        }));
      });
    });
  });

  it('throws from rankKey when the criterion weights would take a key past 2^53', () => {
    // Each part's numerator is up to `maxWeight · den`, which the blend's own
    // common denominator then multiplies: the bound is the product of all three.
    const heavy = {
      ...problemOf(40, 2, [{ slots: [A], limits: [], weight: 1_000_000_000 }]),
      handSizes: FIRST_OR_SECOND,
    };
    const blend = createBlendScorer(heavy);
    expect(blend.score([37, 3]).parts[0]!.num).toBe(1_000_000_000 * 222111);
    expect(() => blend.rankKey([37, 3])).toThrow(/exact/);
    expect(() => blend.keysOf(blend.score([37, 3]))).toThrow(/exact/);
  });
});

// ---------------------------------------------------------------------------
// The sixth card, split from the opening five (PRD §5.6, TDD §10.2)
// ---------------------------------------------------------------------------

/**
 * THE HAND CALCULATION. Ten cards: two of `A`, two of `B`, and six that fill
 * nothing. Going second you see five cards and THEN draw one, so a hand is the
 * ordered pair (the five, the card drawn) and there are `N · C(N − 1, 5)`
 * = `6 · C(N, 6)` = 1,260 of them.
 *
 *   SPLIT     the opening five hold an `A`, and the card drawn is a `B`
 *   ALL SIX   the six cards, between them, hold an `A` and a `B`
 *
 * The card drawn is uniform over the deck and the five are uniform over what is
 * left, so
 *
 *   P(split) = (2/10) · P(five of {2 A, 1 B, 6 blank} hold an A)
 *            = (1/5) · (1 − C(7,5)/C(9,5)) = (1/5)(105/126) = 1/6
 *
 * and over 1,260 outcomes that numerator is 210 — the two `B`s, each with the
 * 105 five-card hands out of C(9,5) = 126 that hold an `A`.
 *
 * Asking the same of all six cards is a different question and a different
 * number: 1 − 2·C(8,6)/C(10,6) + C(6,6)/C(10,6) = (210 − 28 − 28 + 1)/210
 * = 155/210 = 31/42. The two AGREE on nothing — 1/6 against 31/42 — which is
 * the point: the split fixes which card is which.
 */
describe('the sixth card split, by hand', () => {
  const TEN = [6, 2, 2];
  const deckOfTen = (criteria: CompiledCriterion[], drawn: boolean): Problem => ({
    deckSize: 10,
    handSizes: [{ H: 6, weight: 1, ...(drawn ? { drawn: true } : {}) }],
    classes: [
      { lineIds: ['blank'], min: 6, max: 6 },
      { lineIds: ['a'], min: 2, max: 2 },
      { lineIds: ['b'], min: 2, max: 2 },
    ],
    criteria,
  });

  /** `1x A then 1x B`: the five hold an `A`, the card drawn is a `B`. */
  const SPLIT = deckOfTen([{ slots: [A], limits: [], sixth: { slots: [B], limits: [] } }], true);
  /** `1x A and 1x B`, over all six cards. */
  const ALL_SIX = deckOfTen([{ slots: [A, B], limits: [] }], false);

  it('scores the split at 210/1260 — one hand in six', () => {
    expect(createScorer(SPLIT, 6).score(TEN)).toEqual({ num: 210, den: 1260, successNum: 210 });
    expect(210 / 1260).toBeCloseTo(1 / 6, 12);
  });

  it('scores the same question of all six cards at 155/210, which is not the same number', () => {
    expect(createScorer(ALL_SIX, 6).score(TEN)).toEqual({ num: 155, den: 210, successNum: 155 });
    expect(155 / 210).toBeCloseTo(31 / 42, 12);
    // The whole point of the feature: 1/6 is not 31/42.
    expect(210 / 1260).not.toBeCloseTo(155 / 210, 3);
  });

  it('agrees with the Monte Carlo oracle, which shares none of this code', () => {
    const problem = {
      deckSize: 10,
      // `a`, `b`, then the remainder row, which fills nothing.
      matrix: [
        [true, false],
        [false, true],
        [false, false],
      ],
      flat: [
        { reqs: [{ n: 1, desc: 0 }], limits: [], sixth: { reqs: [{ n: 1, desc: 1 }], limits: [] } },
      ],
    };
    const { p, ci95 } = estimate(problem, [2, 2], {
      handSize: 6,
      samples: 400_000,
      seed: 20260920,
    });
    expect(p).toBeCloseTo(1 / 6, 2);
    expect(ci95[0]).toBeLessThan(1 / 6);
    expect(ci95[1]).toBeGreaterThan(1 / 6);
  });

  /**
   * Both stores must answer the same, and with the sixth card there are TWO
   * ceilings to flip over rather than one: the weighted `maxValue` and the plain
   * `maxPlain`, which is the outcomes per hand and no longer 1.
   */
  it('answers the same either way round the store, weights and outcomes included', () => {
    const weighted = deckOfTen(
      [
        { slots: [A], limits: [], sixth: { slots: [B], limits: [] }, weight: 7 },
        { slots: [B], limits: [] },
      ],
      true,
    );
    const direct = createScorer(weighted, 6, { storage: 'successes' }).score(TEN);
    const flipped = createScorer(weighted, 6, { storage: 'complement' }).score(TEN);
    expect(createScorer(weighted, 6, { storage: 'successes' }).complemented).toBe(false);
    expect(createScorer(weighted, 6, { storage: 'complement' }).complemented).toBe(true);
    expect(flipped).toEqual(direct);
    // A weight really is in play, so the two numerators are not the same number.
    expect(direct.successNum).toBeLessThan(direct.num);
    expect(direct.den).toBe(1260);
  });

  it('is the ordinary score six times over when nothing is split', () => {
    // Every outcome of a hand is worth the same when no criterion names the
    // card drawn, so distinguishing it multiplies BOTH sides by six and says
    // exactly what it always said.
    const drawn = deckOfTen([{ slots: [A, B], limits: [] }], true);
    const plainScore = createScorer(ALL_SIX, 6).score(TEN);
    const drawnScore = createScorer(drawn, 6).score(TEN);
    expect(drawnScore).toEqual({
      num: 6 * plainScore.num,
      den: 6 * plainScore.den,
      successNum: 6 * plainScore.successNum,
    });
  });
});

/**
 * EVERY OUTCOME of a drawn hand, listed: each card of the deck as the one
 * drawn, and every `H - 1` subset of what is left as the cards opened on. There
 * are `N · C(N - 1, H - 1)` = `H · C(N, H)` of them, which is the denominator
 * the scorer reports, and nothing here knows that — it counts what it lists.
 *
 * The hand handed to the oracle is `[...opening, drawn]`, the card drawn LAST,
 * which is the one convention the split rests on: `satisfiesFlat` reads the
 * last card as the sixth and the rest as the five, and judges an unsplit
 * alternative over all of them as it always did.
 */
function enumerateDrawn(g: Generated, counts: readonly number[], flat: readonly FlatCriterion[]) {
  const deck = deckOf(g.problem, counts);
  const fills = fillsOf(g.problem);
  let outcomes = 0;
  let successes = 0;
  for (let drawn = 0; drawn < deck.length; drawn++) {
    const rest = deck.filter((_, at) => at !== drawn);
    for (const opening of combinations(rest, g.handSize - 1)) {
      outcomes++;
      if (satisfiesAnyFlat(flat, [...opening, deck[drawn]!], fills)) successes++;
    }
  }
  return { outcomes, successes };
}

describe('the sixth card against exhaustive enumeration of every outcome', () => {
  const generated = smallSplitProblems();

  it('generates problems worth testing', () => {
    expect(generated.length).toBeGreaterThanOrEqual(200);
    const split = generated.filter(hasSplit);
    // Split criteria, and problems that MIX split and unsplit ones — the case a
    // sum of separate probabilities would get wrong.
    expect(split.length).toBeGreaterThanOrEqual(120);
    const mixed = generated.filter(
      (g) =>
        g.flat.some(({ sixth }) => sixth !== undefined) &&
        g.flat.some(({ sixth }) => sixth === undefined),
    );
    expect(mixed.length).toBeGreaterThanOrEqual(15);
    // The sixth card's part is sometimes limits alone, sometimes a requirement,
    // and sometimes both; and some criteria leave the opening five unasked about.
    const sixths = generated.flatMap((g) => g.flat.flatMap(({ sixth }) => (sixth ? [sixth] : [])));
    expect(sixths.filter(({ reqs }) => reqs.length === 0).length).toBeGreaterThanOrEqual(20);
    expect(sixths.filter(({ reqs }) => reqs.length > 0).length).toBeGreaterThanOrEqual(80);
    expect(sixths.filter(({ limits }) => limits.length > 0).length).toBeGreaterThanOrEqual(20);
    expect(
      generated.filter((g) =>
        g.flat.some(
          ({ sixth, reqs, limits }) =>
            sixth !== undefined && reqs.length === 0 && limits.length === 0,
        ),
      ).length,
    ).toBeGreaterThanOrEqual(10);
    // Both storages, and probabilities that are actually decided by chance.
    const scorers = split.map((g) =>
      createScorer(problemFromMatrix(g.problem, [g.handSize]).problem, g.handSize),
    );
    expect(scorers.filter(({ complemented }) => complemented).length).toBeGreaterThanOrEqual(5);
    expect(scorers.filter(({ complemented }) => !complemented).length).toBeGreaterThanOrEqual(60);
    const p = split.map((g) => {
      const { outcomes, successes } = enumerateDrawn(g, g.counts, g.flat);
      return successes / outcomes;
    });
    expect(p.filter((value) => value > 0.02 && value < 0.98).length).toBeGreaterThanOrEqual(60);
  });

  it('counts exactly the successful outcomes of every deck, problem by problem', () => {
    let decks = 0;
    let outcomes = 0;
    generated.forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const scorer = createScorer(converted.problem, g.handSize);
      const rng = seededRng(84_000 + i);
      for (const counts of [g.counts, otherCounts(rng, g)]) {
        const exact = enumerateDrawn(g, counts, g.flat);
        const context = () => ({ index: i, counts, problem: g.problem, handSize: g.handSize });
        same(exact.outcomes, g.handSize * choose(g.problem.deckSize, g.handSize), context);
        const { num, den } = scorer.score(converted.totals(counts));
        // A problem with nothing split scores over SETS of `H` cards, and this
        // enumeration lists each set `H` times — once per card that could have
        // been the one drawn. So the scale between the two is `H` there and 1
        // where the card drawn is named, which is the same identity as
        // "distinguishing it changes no probability", now over generated
        // problems rather than one worked by hand.
        const factor = hasSplit(g) ? 1 : g.handSize;
        same(num * factor, exact.successes, context);
        same(den * factor, exact.outcomes, context);
        decks++;
        outcomes += exact.outcomes;
      }
    });
    // Pinned so the size of the check is on record; it moves only if the generator does.
    expect({ decks, outcomes }).toEqual({ decks: 480, outcomes: 710_552 });
  });

  it('counts the same outcomes as the UNEXPANDED criteria do', () => {
    generated.slice(0, 80).forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const fills = fillsOf(g.problem);
      const deck = deckOf(g.problem, g.counts);
      let successes = 0;
      for (let drawn = 0; drawn < deck.length; drawn++) {
        const rest = deck.filter((_, at) => at !== drawn);
        for (const opening of combinations(rest, g.handSize - 1))
          if (g.exprs.some((expr) => satisfiesTree(expr, [...opening, deck[drawn]!], fills)))
            successes++;
      }
      const { num } = createScorer(converted.problem, g.handSize).score(converted.totals(g.counts));
      same(num * (hasSplit(g) ? 1 : g.handSize), successes, () => ({
        index: i,
        problem: g.problem,
      }));
    });
  });

  it('agrees with the Monte Carlo oracle on the whole family', () => {
    smallSplitProblems()
      .filter(hasSplit)
      .slice(0, 40)
      .forEach((g, i) => {
        const converted = problemFromMatrix(g.problem, [g.handSize]);
        const { num, den } = createScorer(converted.problem, g.handSize).score(
          converted.totals(g.counts),
        );
        const { ci95 } = estimate(g.problem, g.counts, {
          handSize: g.handSize,
          samples: 60_000,
          seed: 91_000 + i,
        });
        const p = num / den;
        if (p < ci95[0] - 1e-9 || p > ci95[1] + 1e-9)
          throw new Error(
            `exact ${p} outside the 95% interval [${ci95[0]}, ${ci95[1]}] for problem ${i}: ${JSON.stringify(g.problem)}`,
          );
      });
  });
});
