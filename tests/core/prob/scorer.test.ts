import { describe, expect, it } from 'vitest';
import type { FlatCriterion } from '../../../src/core/criteria/ast';
import type { CompiledCriterion, Problem } from '../../../src/core/model/problem';
import { estimate } from '../../../src/core/prob/montecarlo';
import {
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
  deckOf,
  fillsOf,
  type Generated,
  genProblem,
  hasRange,
  smallProblems,
  smallRangedProblems,
} from '../../helpers/gen-problem';
import { referenceNumerator } from '../../helpers/matcher-oracle';
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
    expect(createScorer(ONE_CLASS, 5).score([37, 3])).toEqual({ num: 222111, den: 658008 });
  });

  it('scores the same deck at a hand of six as 1 - C(37,6)/C(40,6)', () => {
    expect(choose(40, 6)).toBe(3838380);
    expect(createScorer(ONE_CLASS, 6).score([37, 3])).toEqual({
      num: 3838380 - choose(37, 6),
      den: 3838380,
    });
  });

  it('scores "at least 2 of 6" as the sum of its hypergeometric terms', () => {
    const problem = problemOf(40, 2, [{ slots: [A, A], limits: [] }]);
    let num = 0;
    for (let drawn = 2; drawn <= 5; drawn++) num += choose(6, drawn) * choose(34, 5 - drawn);
    expect(num).toBe(15 * 5984 + 20 * 561 + 15 * 34 + 6);
    expect(createScorer(problem, 5).score([34, 6])).toEqual({ num, den: 658008 });
  });

  it('scores "exactly one", written with a limit, as one hypergeometric term', () => {
    const problem = problemOf(40, 2, [{ slots: [A], limits: [{ mask: A, n: 1 }] }]);
    expect(createScorer(problem, 5).score([34, 6])).toEqual({
      num: 6 * choose(34, 4),
      den: 658008,
    });
  });

  it('scores two classes that share a slot by inclusion and exclusion', () => {
    // `1x A, 1x (A or B)`: at least two of A-or-B, not all of them B.
    const problem = problemOf(40, 3, [{ slots: [A, A | B], limits: [] }]);
    const twoOfEither = choose(40, 5) - choose(33, 5) - 7 * choose(33, 4);
    let allB = 0;
    for (let drawn = 2; drawn <= 4; drawn++) allB += choose(4, drawn) * choose(33, 5 - drawn);
    expect(createScorer(problem, 5).score([33, 3, 4])).toEqual({
      num: twoOfEither - allB,
      den: 658008,
    });
  });

  it('scores the motivating example at its maximum counts as exactly 46,185 / 658,008', () => {
    expect(createScorer(MOTIVATING, 5).score(MOTIVATING_AT_MAX)).toEqual({
      num: 46185,
      den: 658008,
    });
    // The oracle agrees with the figure the TDD derives three other ways.
    expect(referenceNumerator(MOTIVATING, MOTIVATING_AT_MAX, 5)).toBe(46185);
  });

  it('scores any number of decks from one success set', () => {
    const scorer = createScorer(ONE_CLASS, 5);
    for (let copies = 0; copies <= 40; copies++)
      expect(scorer.score([40 - copies, copies])).toEqual({
        num: 658008 - choose(40 - copies, 5),
        den: 658008,
      });
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
    expect(createScorer(problemOf(40, 3, []), 5).score([30, 5, 5])).toEqual({
      num: 0,
      den: 658008,
    });
    expect(
      createScorer(problemOf(40, 3, [{ slots: [], limits: [] }]), 5).score([30, 5, 5]),
    ).toEqual({ num: 658008, den: 658008 });
  });

  it('scores a deck with an EMPTY blank class, and the blank class alone', () => {
    const problem = problemOf(40, 3, [{ slots: [A], limits: [{ mask: B, n: 4 }] }]);
    // No blank cards: at least one A and not five Bs is everything but the all-B hands.
    expect(createScorer(problem, 5).score([0, 10, 30])).toEqual({
      num: 658008 - choose(30, 5),
      den: 658008,
    });
    expect(createScorer(problemOf(40, 1, [{ slots: [], limits: [] }]), 5).score([40])).toEqual({
      num: 658008,
      den: 658008,
    });
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
      { H: 5, weight: 1, num: 222111, den: 658008 },
      { H: 6, weight: 1, num: 3838380 - choose(37, 6), den: 3838380 },
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
    expect(score.parts).toEqual([{ H: 5, weight: 1, num: 46185, den: 658008 }]);
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
});

describe('scoreBlend', () => {
  it('is the one-shot form of createBlendScorer', () => {
    const problem = { ...MOTIVATING, handSizes: FIRST_OR_SECOND };
    const score = scoreBlend(problem, MOTIVATING_AT_MAX);
    expect(score).toEqual(createBlendScorer(problem).score(MOTIVATING_AT_MAX));
    expect(score.parts[0]).toEqual({ H: 5, weight: 1, num: 46185, den: 658008 });
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
      num: nums[at]!,
      den: choose(deckSize, H),
    })),
    pDisplay: Number.NaN,
  };
}

describe('compareScores', () => {
  const single = (num: number, den = 658008): BlendScore => ({
    parts: [{ H: 5, weight: 1, num, den }],
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
    expect(scorer.score(totals)).toEqual({ num: 50063860 - choose(31, 6), den: 50063860 });
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
