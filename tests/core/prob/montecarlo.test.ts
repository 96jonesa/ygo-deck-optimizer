import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { resolveTemplate } from '../../../src/core/model/compile';
import type { Template } from '../../../src/core/model/template';
import {
  buildDeck,
  createJudge,
  drawHand,
  estimate,
  type MatchProblem,
  wilson95,
} from '../../../src/core/prob/montecarlo';
import { createPrng } from '../../../src/core/util/prng';
import type { Progress } from '../../../src/core/util/progress';
import { same } from '../../helpers/assert';
// Test code may use binomials; the Monte Carlo engine may not (TDD §10.4).
import { choose, combinations } from '../../helpers/combinatorics';
import { satisfiesAnyFlat, satisfiesTree } from '../../helpers/criteria-oracle';
import {
  fillsOf,
  type Generated,
  genProblem,
  hasRange,
  smallRangedProblems,
} from '../../helpers/gen-problem';
import { motivatingContext, ROTA, STRATOS } from '../../helpers/motivating';
import { seededRng } from '../../helpers/prng';

/** `|estimate - exact|` within five standard errors OF THE EXACT VALUE; a certain outcome must be hit exactly. */
function expectWithinFiveSigma(
  hits: number,
  samples: number,
  exact: number,
  context: () => unknown,
) {
  const sigma = Math.sqrt((exact * (1 - exact)) / samples);
  const off = Math.abs(hits / samples - exact);
  if (off <= 5 * sigma) return;
  throw new Error(
    `estimate ${hits / samples} is ${(off / sigma).toFixed(1)} standard errors from the exact ${exact}: ${JSON.stringify(context())}`,
  );
}

/** A problem of one requirement column per `fills` row entry and no criteria yet. */
function problemOf(
  deckSize: number,
  matrix: boolean[][],
  flat: MatchProblem['flat'],
): MatchProblem {
  return { deckSize, matrix, flat };
}

const T = true;
const F = false;

/** One line of three copies and the remainder; success is drawing the line (TDD §15.1's anchor). */
const THREE_IN_FORTY = problemOf(40, [[T], [F]], [{ reqs: [{ n: 1, desc: 0 }], limits: [] }]);

// MC2's generated problems (`tests/helpers/gen-problem.ts`).
const PROBLEMS = 48;
const generated = Array.from({ length: PROBLEMS }, (_, i) => genProblem(seededRng(7000 + i)));

describe('wilson95', () => {
  it('pins the textbook interval of 50 in 100', () => {
    const [lo, hi] = wilson95(50, 100);
    expect(lo).toBeCloseTo(0.4038315, 6);
    expect(hi).toBeCloseTo(0.5961685, 6);
  });

  it('is not empty at 0 hits: the upper end is z^2 / (n + z^2)', () => {
    const [lo, hi] = wilson95(0, 10);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(3.8414588 / 13.8414588, 6);
  });

  it('mirrors at every hit', () => {
    const [lo, hi] = wilson95(10, 10);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi).toBeCloseTo(1, 12);
    expect(lo).toBeCloseTo(1 - 3.8414588 / 13.8414588, 6);
  });

  it('contains the point estimate and narrows with more samples', () => {
    const [lo, hi] = wilson95(300, 1000);
    expect(lo).toBeLessThan(0.3);
    expect(hi).toBeGreaterThan(0.3);
    const [lo2, hi2] = wilson95(30000, 100000);
    expect(hi2 - lo2).toBeLessThan(hi - lo);
  });
});

describe('buildDeck', () => {
  const problem = problemOf(10, [[T], [F], [F], [F]], []);

  it('holds one entry per card, tagged with its line, the remainder last', () => {
    expect(buildDeck(problem, [2, 0, 3])).toEqual([0, 0, 2, 2, 2, 3, 3, 3, 3, 3]);
  });

  it('builds a deck with no remainder at all', () => {
    expect(buildDeck(problem, [4, 3, 3])).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });

  it('always has deckSize cards', () => {
    for (const counts of [
      [0, 0, 0],
      [1, 2, 3],
      [3, 3, 3],
    ])
      expect(buildDeck(problem, counts)).toHaveLength(10);
  });

  it('rejects lines that hold more than the deck', () => {
    expect(() => buildDeck(problem, [4, 4, 3])).toThrow(/11 cards, more than the deck size of 10/);
  });

  it('rejects a count for the remainder, or a missing one', () => {
    expect(() => buildDeck(problem, [1, 1, 1, 7])).toThrow(/expected 3 line counts/);
    expect(() => buildDeck(problem, [1, 1])).toThrow(/expected 3 line counts/);
  });

  it('rejects a negative or fractional count', () => {
    expect(() => buildDeck(problem, [1, -1, 1])).toThrow(RangeError);
    expect(() => buildDeck(problem, [1, 1.5, 1])).toThrow(RangeError);
  });
});

describe('drawHand', () => {
  const identity = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('draws distinct physical cards and keeps the deck a permutation', () => {
    const rng = createPrng(11);
    for (let round = 0; round < 2000; round++) {
      const cards = identity(12);
      drawHand(cards, 5, rng);
      expect(new Set(cards.slice(0, 5)).size).toBe(5);
      expect([...cards].sort((a, b) => a - b)).toEqual(identity(12));
    }
  });

  it('draws every hand about equally often', () => {
    const rng = createPrng(12);
    const draws = 200_000;
    const seen = new Map<string, number>();
    for (let round = 0; round < draws; round++) {
      const cards = identity(6);
      drawHand(cards, 3, rng);
      const key = cards
        .slice(0, 3)
        .sort((a, b) => a - b)
        .join();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // C(6,3) = 20 hands, each Binomial(draws, 1/20).
    expect(seen.size).toBe(20);
    const sd = Math.sqrt(draws * (1 / 20) * (19 / 20));
    for (const count of seen.values()) expect(Math.abs(count - draws / 20)).toBeLessThan(5 * sd);
  });

  it('puts every card in every hand POSITION about equally often', () => {
    const rng = createPrng(13);
    const draws = 120_000;
    const seen = Array.from({ length: 3 }, () => new Array<number>(6).fill(0));
    for (let round = 0; round < draws; round++) {
      const cards = identity(6);
      drawHand(cards, 3, rng);
      for (let position = 0; position < 3; position++) seen[position]![cards[position]!]!++;
    }
    const sd = Math.sqrt(draws * (1 / 6) * (5 / 6));
    for (const row of seen)
      for (const count of row) expect(Math.abs(count - draws / 6)).toBeLessThan(5 * sd);
  });

  it('shuffles the whole deck when the hand is the deck', () => {
    const cards = identity(5);
    drawHand(cards, 5, createPrng(14));
    expect([...cards].sort((a, b) => a - b)).toEqual(identity(5));
  });

  it('permutes a typed array the same way as a plain one', () => {
    const plain = identity(10);
    const typed = Int32Array.from(plain);
    drawHand(plain, 4, createPrng(15));
    drawHand(typed, 4, createPrng(15));
    expect([...typed]).toEqual(plain);
  });
});

describe('createJudge', () => {
  // Lines: 0 = X, 1 = Y, 2 = both-ways Z, 3 = remainder. Columns: 0 = x, 1 = y.
  const matrix = [
    [T, F],
    [F, T],
    [T, T],
    [F, F],
  ];
  const judgeOf = (flat: MatchProblem['flat']) => createJudge(problemOf(10, matrix, flat));

  it('meets one requirement with one matching card, wherever it sits in the hand', () => {
    const judge = judgeOf([{ reqs: [{ n: 1, desc: 0 }], limits: [] }]);
    expect(judge([3, 3, 0])).toBe(true);
    expect(judge([0, 3, 3])).toBe(true);
    expect(judge([3, 1, 3])).toBe(false);
  });

  it('needs n DISTINCT cards for an n× requirement', () => {
    const judge = judgeOf([{ reqs: [{ n: 2, desc: 0 }], limits: [] }]);
    expect(judge([0, 3, 3])).toBe(false);
    expect(judge([0, 3, 0])).toBe(true);
    expect(judge([0, 2, 3])).toBe(true);
  });

  it('never lets one card fill two slots', () => {
    const judge = judgeOf([
      {
        reqs: [
          { n: 1, desc: 0 },
          { n: 1, desc: 1 },
        ],
        limits: [],
      },
    ]);
    // Z matches both columns, but it is one card.
    expect(judge([2, 3, 3])).toBe(false);
    expect(judge([2, 2, 3])).toBe(true);
    expect(judge([0, 1, 3])).toBe(true);
  });

  it('backtracks when the first card that fits a slot is needed by a later one', () => {
    const judge = judgeOf([
      {
        reqs: [
          { n: 1, desc: 0 },
          { n: 1, desc: 1 },
        ],
        limits: [],
      },
    ]);
    // Slot x would greedily take Z, leaving nothing for y; X must take x instead.
    expect(judge([2, 0, 3])).toBe(true);
    // And the mirror image, for a judge that walks the hand the other way.
    expect(judge([0, 2, 3])).toBe(true);
    expect(judge([1, 2, 3])).toBe(true);
    expect(judge([2, 1, 3])).toBe(true);
  });

  it('counts a limit over the WHOLE hand, cards assigned to slots included', () => {
    const judge = judgeOf([{ reqs: [{ n: 1, desc: 0 }], limits: [{ n: 1, desc: 0 }] }]);
    expect(judge([0, 3, 3])).toBe(true);
    // Two x cards: one fills the slot, and BOTH count against `at most 1x`.
    expect(judge([0, 0, 3])).toBe(false);
    expect(judge([0, 2, 3])).toBe(false);
  });

  it('reads `no X` as a limit of zero', () => {
    const judge = judgeOf([{ reqs: [], limits: [{ n: 0, desc: 1 }] }]);
    expect(judge([0, 3, 3])).toBe(true);
    expect(judge([0, 1, 3])).toBe(false);
  });

  it('succeeds when ANY flat criterion is met, not only when all are', () => {
    const judge = judgeOf([
      { reqs: [{ n: 1, desc: 0 }], limits: [] },
      { reqs: [{ n: 1, desc: 1 }], limits: [] },
    ]);
    expect(judge([0, 3, 3])).toBe(true);
    expect(judge([3, 1, 3])).toBe(true);
    expect(judge([3, 3, 3])).toBe(false);
  });

  it('tries a later criterion after an earlier one fails on its limit', () => {
    const judge = judgeOf([
      { reqs: [{ n: 1, desc: 0 }], limits: [{ n: 0, desc: 1 }] },
      { reqs: [{ n: 2, desc: 1 }], limits: [] },
    ]);
    expect(judge([0, 1, 1])).toBe(true);
    expect(judge([0, 1, 3])).toBe(false);
  });

  it('fails every hand when there is no criterion, and meets an empty one with any hand', () => {
    expect(judgeOf([])([0, 1, 2])).toBe(false);
    expect(judgeOf([{ reqs: [], limits: [] }])([3, 3, 3])).toBe(true);
  });

  it('fails a criterion with more slots than cards', () => {
    const judge = judgeOf([{ reqs: [{ n: 4, desc: 0 }], limits: [] }]);
    expect(judge([0, 0, 0])).toBe(false);
    expect(judge([0, 0, 0, 2])).toBe(true);
  });

  it('judges only the first `size` cards when given a size', () => {
    const judge = judgeOf([{ reqs: [{ n: 1, desc: 0 }], limits: [{ n: 0, desc: 1 }] }]);
    expect(judge([3, 3, 0, 1], 2)).toBe(false);
    expect(judge([3, 0, 1, 1], 2)).toBe(true);
    expect(judge(Int32Array.from([3, 0, 1, 1]), 3)).toBe(false);
  });

  it('can be reused from hand to hand', () => {
    const judge = judgeOf([{ reqs: [{ n: 2, desc: 0 }], limits: [] }]);
    expect(judge([0, 0, 3])).toBe(true);
    expect(judge([0, 3, 3])).toBe(false);
    expect(judge([2, 0, 3])).toBe(true);
  });

  /**
   * The SIXTH CARD (PRD §5.6). `drawHand` fills position `i` at step `i`, so
   * the LAST position of the hand is the card drawn last; a split criterion
   * judges its own part over the positions before it and its `sixth` part over
   * that one card.
   */
  describe('a split criterion', () => {
    // Lines again: 0 = X, 1 = Y, 2 = Z (both), 3 = remainder.
    const xThenY = judgeOf([
      { reqs: [{ n: 1, desc: 0 }], limits: [], sixth: { reqs: [{ n: 1, desc: 1 }], limits: [] } },
    ]);

    it('asks its sixth part of the LAST card and its own of the rest', () => {
      // X opened on, Y drawn.
      expect(xThenY([0, 1])).toBe(true);
      // The same two cards the other way round: the X is drawn and fills nothing.
      expect(xThenY([1, 0])).toBe(false);
      // Z is both, so it can be the card drawn while the X is opened on.
      expect(xThenY([0, 2])).toBe(true);
      // …but not both at once: one card cannot be the five and the sixth.
      expect(xThenY([3, 2])).toBe(false);
      expect(xThenY([2])).toBe(false);
    });

    it('never lets one card serve both windows', () => {
      // Two Z's: one opened on, one drawn.
      expect(xThenY([2, 2])).toBe(true);
      // A Y drawn with only a Y opened on: nothing fills the X slot.
      expect(xThenY([1, 1])).toBe(false);
    });

    it('counts a limit of its own part over the cards opened on alone', () => {
      const noYThenY = judgeOf([
        {
          reqs: [{ n: 1, desc: 0 }],
          limits: [{ n: 0, desc: 1 }],
          sixth: { reqs: [{ n: 1, desc: 1 }], limits: [] },
        },
      ]);
      // The Y drawn does not count against `no y` over the cards opened on.
      expect(noYThenY([0, 1])).toBe(true);
      // A second Y among them does.
      expect(noYThenY([0, 1, 1])).toBe(false);
    });

    it('counts a limit of the sixth part over that one card alone', () => {
      const noY = judgeOf([
        { reqs: [{ n: 1, desc: 0 }], limits: [], sixth: { reqs: [], limits: [{ n: 0, desc: 1 }] } },
      ]);
      // An X drawn is not a y; the remainder drawn is not either.
      expect(noY([0, 0])).toBe(true);
      expect(noY([0, 3])).toBe(true);
      // A Y drawn is.
      expect(noY([0, 1])).toBe(false);
      // And a Y among the cards opened on says nothing about the one drawn.
      expect(noY([0, 1, 3])).toBe(true);
    });

    it('is never met by a hand of no cards: there is no card to draw', () => {
      expect(xThenY([], 0)).toBe(false);
    });

    it('judges unsplit criteria beside it over the whole hand', () => {
      const either = judgeOf([
        { reqs: [{ n: 1, desc: 0 }], limits: [], sixth: { reqs: [{ n: 1, desc: 1 }], limits: [] } },
        { reqs: [{ n: 2, desc: 1 }], limits: [] },
      ]);
      // The split one fails (the X is drawn) but the unsplit one holds.
      expect(either([1, 1, 0])).toBe(true);
      expect(either([1, 0])).toBe(false);
    });
  });
});

describe('estimate', () => {
  const opts = { handSize: 5, samples: 20_000, seed: 1 };

  // MC1 — the closed-form anchor of TDD §15.1.
  it('agrees with 1 - C(37,5)/C(40,5) for three copies in forty', () => {
    expect(choose(40, 5) - choose(37, 5)).toBe(222111);
    expect(choose(40, 5)).toBe(658008);
    const exact = 222111 / 658008;
    const samples = 250_000;
    const result = estimate(THREE_IN_FORTY, [3], { handSize: 5, samples, seed: 20260918 });
    expectWithinFiveSigma(result.hits, samples, exact, () => result);
    // And the reported interval, which is narrower than five sigma, holds it too.
    expect(result.ci95[0]).toBeLessThan(exact);
    expect(result.ci95[1]).toBeGreaterThan(exact);
  });

  it('agrees with the closed form at a hand of six', () => {
    const exact = 1 - choose(37, 6) / choose(40, 6);
    const samples = 250_000;
    const result = estimate(THREE_IN_FORTY, [3], { handSize: 6, samples, seed: 6 });
    expectWithinFiveSigma(result.hits, samples, exact, () => result);
  });

  it('returns the same hits for the same seed', () => {
    const a = estimate(THREE_IN_FORTY, [3], opts);
    const b = estimate(THREE_IN_FORTY, [3], opts);
    expect(a).toEqual(b);
  });

  it('draws a different stream from a different seed', () => {
    const hits = [1, 2, 3, 4, 5].map(
      (seed) => estimate(THREE_IN_FORTY, [3], { ...opts, seed }).hits,
    );
    expect(new Set(hits).size).toBeGreaterThan(1);
  });

  it('draws exactly `samples` hands, and derives p, stderr and ci95 from the hits', () => {
    for (const samples of [1, 7, 8192, 8193, 20_000]) {
      const result = estimate(THREE_IN_FORTY, [3], { ...opts, samples });
      expect(result.samples).toBe(samples);
      expect(result.hits).toBeGreaterThanOrEqual(0);
      expect(result.hits).toBeLessThanOrEqual(samples);
      expect(result.p).toBe(result.hits / samples);
      expect(result.stderr).toBeCloseTo(Math.sqrt((result.p * (1 - result.p)) / samples), 12);
      expect(result.ci95).toEqual(wilson95(result.hits, samples));
    }
  });

  it('counts a hit on every sample when success is certain, and on none when impossible', () => {
    const always = problemOf(40, [[T], [T]], [{ reqs: [{ n: 1, desc: 0 }], limits: [] }]);
    expect(estimate(always, [3], opts).hits).toBe(opts.samples);
    expect(estimate(THREE_IN_FORTY, [0], opts).hits).toBe(0);
  });

  it('reports progress monotonically, throttled, ending at done === total', () => {
    let clock = 0;
    const seen: Progress[] = [];
    const samples = 100_000;
    estimate(THREE_IN_FORTY, [3], {
      ...opts,
      samples,
      onProgress: (p) => seen.push(p),
      // 300 ms per look at the clock: every other look is due a report.
      now: () => (clock += 300),
    });
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.at(-1)).toMatchObject({ done: samples, total: samples, etaMs: 0 });
    for (const p of seen) expect(p.total).toBe(samples);
    const body = seen.slice(0, -1);
    for (let i = 1; i < body.length; i++) {
      expect(body[i]!.done).toBeGreaterThan(body[i - 1]!.done);
      expect(body[i]!.elapsedMs - body[i - 1]!.elapsedMs).toBeGreaterThanOrEqual(500);
    }
    expect(body.at(-1)!.done).toBeLessThan(samples);
    expect(body.every((p) => p.etaMs > 0)).toBe(true);
  });

  it('gives the same result with and without a progress callback', () => {
    const quiet = estimate(THREE_IN_FORTY, [3], opts);
    const loud = estimate(THREE_IN_FORTY, [3], { ...opts, onProgress: () => {} });
    expect(loud).toEqual(quiet);
  });

  it('rejects lines that overfill the deck, and nonsense sample counts and hand sizes', () => {
    expect(() => estimate(THREE_IN_FORTY, [41], opts)).toThrow(/more than the deck size of 40/);
    for (const samples of [0, -5, 2.5])
      expect(() => estimate(THREE_IN_FORTY, [3], { ...opts, samples })).toThrow(RangeError);
    for (const handSize of [0, 41, 2.5])
      expect(() => estimate(THREE_IN_FORTY, [3], { ...opts, handSize })).toThrow(RangeError);
  });
});

// MC2 — exhaustive enumeration on small decks. The exact probability is the
// share of ALL C(N, H) hands that the criteria oracle accepts; the oracle and
// the core judge are independent implementations.
describe('estimates against exhaustive enumeration of small decks', () => {
  const exactOf = ({ problem, counts, handSize, flat }: Generated) => {
    const hands = combinations(buildDeck(problem, counts), handSize);
    const fills = fillsOf(problem);
    const successes = hands.filter((hand) => satisfiesAnyFlat(flat, hand, fills)).length;
    return { successes, hands: hands.length };
  };

  it('generates problems worth testing', () => {
    const exact = generated.map((g) => {
      const { successes, hands } = exactOf(g);
      return successes / hands;
    });
    expect(generated.length).toBeGreaterThanOrEqual(30);
    // Most of them decided by chance, not foregone…
    expect(exact.filter((p) => p > 0.02 && p < 0.98).length).toBeGreaterThanOrEqual(30);
    // …with limits, n× counts, several alternatives and overlapping slots among them.
    const flats = generated.flatMap((g) => g.problem.flat);
    expect(generated.filter((g) => g.problem.flat.length > 1).length).toBeGreaterThanOrEqual(10);
    expect(flats.filter((f) => f.limits.length > 0).length).toBeGreaterThanOrEqual(10);
    expect(flats.filter((f) => f.reqs.some((r) => r.n > 1)).length).toBeGreaterThanOrEqual(10);
    const overlapping = generated.filter(({ problem }) =>
      problem.matrix.some((row) => row.filter(Boolean).length > 1),
    );
    expect(overlapping.length).toBeGreaterThanOrEqual(20);
  });

  it('lands within five standard errors of the exact probability, problem by problem', () => {
    const samples = 60_000;
    generated.forEach((g, i) => {
      const { successes, hands } = exactOf(g);
      expect(hands).toBe(choose(g.problem.deckSize, g.handSize));
      const result = estimate(g.problem, g.counts, {
        handSize: g.handSize,
        samples,
        seed: 100 + i,
      });
      expectWithinFiveSigma(result.hits, samples, successes / hands, () => ({ index: i, ...g }));
    });
  });
});

// The stronger check: no sampling, exact agreement on every hand.
describe('the core judge against the criteria oracles, hand by hand', () => {
  it('agrees with the flat oracle, and with the unexpanded tree, on every hand of every small deck', () => {
    let compared = 0;
    generated.forEach((g, i) => {
      const judge = createJudge(g.problem);
      const fills = fillsOf(g.problem);
      for (const hand of combinations(buildDeck(g.problem, g.counts), g.handSize)) {
        const verdict = judge(hand);
        same(verdict, satisfiesAnyFlat(g.flat, hand, fills), () => ({ index: i, hand, ...g }));
        same(
          verdict,
          g.exprs.some((expr) => satisfiesTree(expr, hand, fills)),
          () => ({ index: i, hand, tree: true, ...g }),
        );
        compared++;
      }
    });
    // Pinned so the size of the check is on record; it moves only if the generator does.
    expect(compared).toBe(19_916);
  });

  it('agrees on every hand of every small deck WITH range requirements', () => {
    const ranged = smallRangedProblems();
    expect(ranged.filter(hasRange).length).toBeGreaterThanOrEqual(150);
    let compared = 0;
    let succeeded = 0;
    ranged.forEach((g, i) => {
      const judge = createJudge(g.problem);
      const fills = fillsOf(g.problem);
      for (const hand of combinations(buildDeck(g.problem, g.counts), g.handSize)) {
        const verdict = judge(hand);
        same(verdict, satisfiesAnyFlat(g.flat, hand, fills), () => ({ index: i, hand, ...g }));
        same(
          verdict,
          g.exprs.some((expr) => satisfiesTree(expr, hand, fills)),
          () => ({ index: i, hand, tree: true, ...g }),
        );
        compared++;
        if (verdict) succeeded++;
      }
    });
    expect({ compared, succeeded }).toEqual({ compared: 91_522, succeeded: 57_978 });
  });

  it('agrees on every hand of up to five cards over every MULTISET of lines', () => {
    // Not only the hands a particular deck allows: every line composition.
    let compared = 0;
    generated.slice(0, 12).forEach((g, i) => {
      const judge = createJudge(g.problem);
      const fills = fillsOf(g.problem);
      const lines = g.problem.matrix.map((_, line) => line);
      const extend = (hand: number[], from: number) => {
        same(judge(hand), satisfiesAnyFlat(g.flat, hand, fills), () => ({ problem: i, hand }));
        compared++;
        if (hand.length === 5) return;
        for (let line = from; line < lines.length; line++) extend([...hand, line], line);
      };
      extend([], 0);
    });
    expect(compared).toBe(2898);
  });
});

// MC3 — PRD §5.4: a card cannot be both "card B" and "the monster".
describe('the overlap case of PRD §5.4', () => {
  // Lines: 0 = A (a spell), 1 = B (a monster), 2 = spell, 3 = remainder.
  // Columns: 0 = card A, 1 = card B, 2 = monster.
  const A = 0;
  const B = 1;
  const SPELL = 2;
  const problem = problemOf(
    40,
    [
      [T, F, F],
      [F, T, T],
      [F, F, F],
      [F, F, F],
    ],
    [
      {
        reqs: [
          { n: 1, desc: 0 },
          { n: 1, desc: 1 },
          { n: 1, desc: 2 },
        ],
        limits: [],
      },
    ],
  );

  it('lets the second B be the monster', () => {
    expect(createJudge(problem)([A, B, B])).toBe(true);
  });

  it('does not let one B be both card B and the monster', () => {
    expect(createJudge(problem)([A, B, SPELL, SPELL])).toBe(false);
  });

  it('holds through a resolved template, where B is known to be a monster from the database', async () => {
    const template: Template = {
      version: 1,
      deckSize: 40,
      hand: { size: 5 },
      groups: [],
      lines: [
        { id: 'A', card: { passcode: ROTA, name: 'Reinforcement of the Army' }, min: 0, max: 3 },
        { id: 'B', card: { passcode: STRATOS, name: 'Elemental HERO Stratos' }, min: 0, max: 3 },
        { id: 'spell', text: 'spell', min: 0, max: 7 },
      ],
      remainder: { min: 0, max: null },
      criteria: [{ id: 'c', text: `1x #${ROTA}, 1x #${STRATOS}, 1x monster` }],
    };
    const result = resolveTemplate(template, motivatingContext(await initSqlJs()));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const judge = createJudge(result.resolved);
    expect(judge([A, B, B])).toBe(true);
    expect(judge([A, B, SPELL, SPELL])).toBe(false);
    // The remainder is a card of unstated kind: not a monster either.
    expect(judge([A, B, 3, 3, 3])).toBe(false);
  });
});
