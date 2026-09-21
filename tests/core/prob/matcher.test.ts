import { describe, expect, it } from 'vitest';
import type { CompiledCriterion, Problem } from '../../../src/core/model/problem';
import {
  compileMatcher,
  compileSplitWeigher,
  compileValuer,
  compileWeigher,
  handSucceeds,
  type Worth,
} from '../../../src/core/prob/matcher';
import { createJudge } from '../../../src/core/prob/montecarlo';
import { same } from '../../helpers/assert';
import { compositions } from '../../helpers/combinatorics';
import { satisfiesAnyFlat } from '../../helpers/criteria-oracle';
import { genClassProblem } from '../../helpers/gen-class-problem';
import { fillsOf, hasRange, smallProblems, smallRangedProblems } from '../../helpers/gen-problem';
import {
  bruteForceMeets,
  bruteForceSucceeds,
  bruteForceWeight,
} from '../../helpers/matcher-oracle';
import { seededRng } from '../../helpers/prng';
import { handOfComposition, problemFromMatrix } from '../../helpers/problem-from-matrix';

// Classes: 0 = blank, 1 = X, 2 = Y, 3 = Z, which is both. Masks: what fills `x`, what fills `y`.
const X = 0b0010;
const Y = 0b0100;
const Z = 0b1000;
const FILLS_X = X | Z;
const FILLS_Y = Y | Z;

function problemOf(criteria: CompiledCriterion[], classCount = 4): Problem {
  return {
    deckSize: 40,
    handSizes: [{ H: 3, weight: 1 }],
    classes: Array.from({ length: classCount }, (_, cls) => ({
      lineIds: [`class${cls}`],
      min: 0,
      max: 40,
    })),
    criteria,
  };
}

/** `[blank, X, Y, Z]` counts of a three-card hand. */
const succeeds = (criteria: CompiledCriterion[], h: number[]) =>
  handSucceeds(problemOf(criteria), h, 3);

describe('compileMatcher', () => {
  it('returns a matcher that can be reused from hand to hand', () => {
    const matches = compileMatcher(problemOf([{ slots: [FILLS_X, FILLS_X], limits: [] }]));
    expect(matches([1, 2, 0, 0], 3)).toBe(true);
    expect(matches([2, 1, 0, 0], 3)).toBe(false);
    expect(matches([1, 1, 0, 1], 3)).toBe(true);
  });

  it('reads counts from a typed array', () => {
    const matches = compileMatcher(problemOf([{ slots: [FILLS_X], limits: [] }]));
    expect(matches(Uint8Array.of(2, 0, 0, 1), 3)).toBe(true);
    expect(matches(Uint8Array.of(2, 0, 1, 0), 3)).toBe(false);
  });

  it('never meets a criterion with more slots than the hand holds — by definition, whatever `h` says', () => {
    const matches = compileMatcher(problemOf([{ slots: [X, X, X, X], limits: [] }]));
    expect(matches([0, 4, 0, 0], 4)).toBe(true);
    expect(matches([0, 4, 0, 0], 3)).toBe(false);
    // Far more slots than a hand can ever hold is not an error, and not a 2^40 table.
    const absurd = compileMatcher(problemOf([{ slots: new Array(40).fill(X), limits: [] }]));
    expect(absurd([0, 6, 0, 0], 6)).toBe(false);
  });

  it('judges one criterion alone when asked to', () => {
    const problem = problemOf([
      { slots: [FILLS_X], limits: [] },
      { slots: [FILLS_Y], limits: [] },
    ]);
    const first = compileMatcher(problem, { criterion: 0 });
    const second = compileMatcher(problem, { criterion: 1 });
    expect(first([2, 1, 0, 0], 3)).toBe(true);
    expect(second([2, 1, 0, 0], 3)).toBe(false);
    expect(first([2, 0, 1, 0], 3)).toBe(false);
    expect(second([2, 0, 1, 0], 3)).toBe(true);
    expect(() => compileMatcher(problem, { criterion: 2 })).toThrow(/no criterion 2/);
    expect(() => compileMatcher(problem, { criterion: -1 })).toThrow(RangeError);
  });

  it('validates the problem: the blank class fills nothing', () => {
    expect(() => compileMatcher(problemOf([{ slots: [X | 1], limits: [] }]))).toThrow(
      /blank class/,
    );
  });
});

describe('handSucceeds', () => {
  it('meets one requirement with one card of a class that fills it', () => {
    const criteria = [{ slots: [FILLS_X], limits: [] }];
    expect(succeeds(criteria, [2, 1, 0, 0])).toBe(true);
    expect(succeeds(criteria, [2, 0, 0, 1])).toBe(true);
    expect(succeeds(criteria, [2, 0, 1, 0])).toBe(false);
    expect(succeeds(criteria, [3, 0, 0, 0])).toBe(false);
  });

  it('needs n cards for an n× requirement, from one class or several', () => {
    const criteria = [{ slots: [FILLS_X, FILLS_X], limits: [] }];
    expect(succeeds(criteria, [2, 1, 0, 0])).toBe(false);
    expect(succeeds(criteria, [1, 2, 0, 0])).toBe(true);
    expect(succeeds(criteria, [1, 1, 0, 1])).toBe(true);
    expect(succeeds(criteria, [1, 1, 1, 0])).toBe(false);
  });

  it('never lets one card fill two slots', () => {
    const criteria = [{ slots: [FILLS_X, FILLS_Y], limits: [] }];
    // One Z fills either slot, but it is one card.
    expect(succeeds(criteria, [2, 0, 0, 1])).toBe(false);
    expect(succeeds(criteria, [1, 0, 0, 2])).toBe(true);
    expect(succeeds(criteria, [1, 1, 1, 0])).toBe(true);
    expect(succeeds(criteria, [1, 1, 0, 1])).toBe(true);
    expect(succeeds(criteria, [1, 0, 1, 1])).toBe(true);
  });

  it('fails on the whole slot set when every smaller set passes', () => {
    // `1x X, 1x Y, 1x (X or Y)` with one X and one Y: every single slot and
    // every pair can be filled; all three cannot.
    const criteria = [{ slots: [X, Y, X | Y], limits: [] }];
    expect(succeeds(criteria, [1, 1, 1, 0])).toBe(false);
    expect(succeeds(criteria, [0, 2, 1, 0])).toBe(true);
    expect(succeeds(criteria, [0, 1, 2, 0])).toBe(true);
  });

  it('fails on a PAIR of slots when every single slot and the whole set pass', () => {
    // `2x X, 1x (X or Y or Z)` with one X and two Ys: three cards for three
    // slots, and each slot alone has a card — but the two X slots share one X.
    const criteria = [{ slots: [X, X, X | Y | Z], limits: [] }];
    expect(handSucceeds(problemOf(criteria), [0, 1, 2, 0], 3)).toBe(false);
    expect(handSucceeds(problemOf(criteria), [0, 2, 1, 0], 3)).toBe(true);
  });

  it('decides the overlap case of PRD §5.4: a card cannot be both card B and the monster', () => {
    // Classes: 1 = A (a spell), 2 = B (a monster), 3 = spell. Slots: card A, card B, monster.
    const criteria = [{ slots: [0b0010, 0b0100, 0b0100], limits: [] }];
    expect(handSucceeds(problemOf(criteria), [0, 1, 2, 0], 3)).toBe(true);
    expect(handSucceeds(problemOf(criteria), [0, 1, 1, 2], 4)).toBe(false);
  });

  it('never fills a slot from the blank class, nor a slot no class fills', () => {
    expect(succeeds([{ slots: [0], limits: [] }], [1, 1, 1, 0])).toBe(false);
    expect(succeeds([{ slots: [FILLS_X], limits: [] }], [3, 0, 0, 0])).toBe(false);
  });

  it('counts a limit over the WHOLE hand, cards that fill slots included', () => {
    const criteria = [{ slots: [FILLS_X], limits: [{ mask: FILLS_X, n: 1 }] }];
    expect(succeeds(criteria, [2, 1, 0, 0])).toBe(true);
    // Two x cards: one fills the slot, and BOTH count against `at most 1x`.
    expect(succeeds(criteria, [1, 2, 0, 0])).toBe(false);
    expect(succeeds(criteria, [1, 1, 0, 1])).toBe(false);
  });

  it('holds a limit AT its count and fails it one above', () => {
    const criteria = [{ slots: [], limits: [{ mask: FILLS_Y, n: 2 }] }];
    expect(succeeds(criteria, [1, 0, 1, 1])).toBe(true);
    expect(succeeds(criteria, [0, 0, 2, 1])).toBe(false);
    expect(succeeds(criteria, [0, 3, 0, 0])).toBe(true);
  });

  it('reads `no X` as a limit of zero', () => {
    const criteria = [{ slots: [], limits: [{ mask: FILLS_Y, n: 0 }] }];
    expect(succeeds(criteria, [2, 1, 0, 0])).toBe(true);
    expect(succeeds(criteria, [2, 0, 1, 0])).toBe(false);
  });

  it('needs EVERY limit of a criterion to hold', () => {
    const criteria = [
      {
        slots: [],
        limits: [
          { mask: X, n: 1 },
          { mask: Y, n: 0 },
        ],
      },
    ];
    expect(succeeds(criteria, [2, 1, 0, 0])).toBe(true);
    expect(succeeds(criteria, [1, 2, 0, 0])).toBe(false);
    expect(succeeds(criteria, [1, 1, 1, 0])).toBe(false);
  });

  it('succeeds when ANY criterion is met, not only when all are', () => {
    const criteria = [
      { slots: [FILLS_X], limits: [] },
      { slots: [FILLS_Y], limits: [] },
    ];
    expect(succeeds(criteria, [2, 1, 0, 0])).toBe(true);
    expect(succeeds(criteria, [2, 0, 1, 0])).toBe(true);
    expect(succeeds(criteria, [3, 0, 0, 0])).toBe(false);
  });

  it('tries a later criterion after an earlier one fails on its limit', () => {
    const criteria = [
      { slots: [FILLS_X], limits: [{ mask: FILLS_Y, n: 0 }] },
      { slots: [FILLS_Y, FILLS_Y], limits: [] },
    ];
    expect(succeeds(criteria, [0, 1, 2, 0])).toBe(true);
    expect(succeeds(criteria, [1, 1, 1, 0])).toBe(false);
  });

  it('fails every hand when there is no criterion, and meets an empty one with any hand', () => {
    expect(succeeds([], [0, 1, 1, 1])).toBe(false);
    expect(succeeds([{ slots: [], limits: [] }], [3, 0, 0, 0])).toBe(true);
  });

  it('handles six slots, and the thirtieth class, whose bit is the highest a mask holds', () => {
    const top = 2 ** 29;
    const problem = problemOf([{ slots: [top, top, X, X | top, Y | top, Y], limits: [] }], 30);
    const h = new Array<number>(30).fill(0);
    h[29] = 3;
    h[1] = 1;
    h[2] = 2;
    expect(handSucceeds(problem, h, 6)).toBe(true);
    h[29] = 2;
    h[0] = 1;
    // Two of class 29 fill its own two slots; X fills one; `X or 29` has nothing left.
    expect(handSucceeds(problem, h, 6)).toBe(false);
    const limited = problemOf([{ slots: [], limits: [{ mask: top, n: 1 }] }], 30);
    expect(handSucceeds(limited, h, 6)).toBe(false);
  });

  it('rejects a hand that is not H whole cards over the classes of the problem', () => {
    const problem = problemOf([{ slots: [FILLS_X], limits: [] }]);
    expect(() => handSucceeds(problem, [1, 1, 0, 0], 3)).toThrow(/holds 2 cards, not 3/);
    expect(() => handSucceeds(problem, [1, 1, 1], 3)).toThrow(/4 classes/);
    expect(() => handSucceeds(problem, [4, -1, 0, 0], 3)).toThrow(RangeError);
    expect(() => handSucceeds(problem, [1.5, 1.5, 0, 0], 3)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Range requirements. The acceptance cases Andy asked for, at the level the
// matcher works at: `1x [Ash], 1-2x monster`, where Ash is itself a monster.
// Classes: 0 blank, 1 ASH, 2 MONSTER (any other), 3 SPELL.
// ---------------------------------------------------------------------------

const ASH = 0b0010;
const MONSTER = 0b0100;
const SPELL = 0b1000;

/** `1x [Ash], 1-2x monster`, compiled. */
const ASH_AND_TWO: CompiledCriterion = {
  slots: [ASH, ASH | MONSTER],
  limits: [],
  reqs: [
    { mask: ASH, min: 1, max: null },
    { mask: ASH | MONSTER, min: 1, max: 2 },
  ],
};

describe('a range requirement', () => {
  /** `[blank, ash, monster, spell]`, judged as a hand of that many cards. */
  const ashAndTwo = (h: number[]) =>
    handSucceeds(
      problemOf([ASH_AND_TWO]),
      h,
      h.reduce((sum, n) => sum + n, 0),
    );

  it('passes Ash, Veiler, Nibiru: Ash fills its own, the other two are the range', () => {
    expect(ashAndTwo([0, 1, 2, 0])).toBe(true);
  });

  it('fails Ash, Veiler, Nibiru, Maxx: the fourth monster cannot be left unassigned', () => {
    expect(ashAndTwo([0, 1, 3, 0])).toBe(false);
  });

  it('fails Ash, spell, spell: no monster is left for the range once Ash is taken', () => {
    expect(ashAndTwo([0, 1, 0, 2])).toBe(false);
  });

  it('passes Ash, Ash, Veiler: the second Ash counts toward the range', () => {
    expect(ashAndTwo([0, 2, 1, 0])).toBe(true);
  });

  it('fails Veiler, Nibiru: the named requirement is unfilled', () => {
    expect(ashAndTwo([0, 0, 2, 0])).toBe(false);
  });

  it('passes two overlapping ranges, each card counting once', () => {
    // `1-2x monster, 1-2x level 4 monster`; classes: 0 blank, 1 L4, 2 L5.
    const [L4, L5] = [0b010, 0b100];
    const overlapping: CompiledCriterion = {
      slots: [L4 | L5, L4],
      limits: [],
      reqs: [
        { mask: L4 | L5, min: 1, max: 2 },
        { mask: L4, min: 1, max: 2 },
      ],
    };
    // One L4 to the level-4 range, the other L4 and the L5 to the monster range.
    expect(handSucceeds(problemOf([overlapping], 3), [0, 2, 1], 3)).toBe(true);
    // Five cards is more than the two ranges can hold together.
    expect(handSucceeds(problemOf([overlapping], 3), [0, 3, 2], 5)).toBe(false);
  });

  it('reads `0-b` as a ceiling and not as "no requirement at all"', () => {
    const none: CompiledCriterion = {
      slots: [],
      limits: [],
      reqs: [{ mask: ASH, min: 0, max: 0 }],
    };
    expect(handSucceeds(problemOf([none]), [3, 0, 0, 0], 3)).toBe(true);
    expect(handSucceeds(problemOf([none]), [2, 1, 0, 0], 3)).toBe(false);
  });

  it('lets an unbounded requirement on the same classes void the ceiling', () => {
    // `1-1x ash and 1x ash` as the engine would never merge them: the surplus
    // has somewhere to go, so three Ash still pass.
    const voided: CompiledCriterion = {
      slots: [ASH, ASH],
      limits: [],
      reqs: [
        { mask: ASH, min: 1, max: 1 },
        { mask: ASH, min: 1, max: null },
      ],
    };
    expect(handSucceeds(problemOf([voided]), [0, 3, 0, 0], 3)).toBe(true);
  });

  it('counts a limit over the whole hand, as it always did, alongside a range', () => {
    const withLimit: CompiledCriterion = {
      ...ASH_AND_TWO,
      limits: [{ mask: SPELL, n: 0 }],
    };
    expect(handSucceeds(problemOf([withLimit]), [0, 1, 2, 0], 3)).toBe(true);
    expect(handSucceeds(problemOf([withLimit]), [0, 1, 1, 1], 3)).toBe(false);
  });
});

// S3 — Hall's condition against brute-force assignment. Nothing is sampled:
// every composition of every problem is judged three or four ways.
describe("Hall's condition against brute-force assignment, hand by hand", () => {
  it('agrees with the criteria oracle and the Monte Carlo judge on every composition of every small problem', () => {
    let compared = 0;
    let succeeded = 0;
    smallProblems().forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const matches = compileMatcher(converted.problem);
      const judge = createJudge(g.problem);
      const fills = fillsOf(g.problem);
      for (const h of compositions(converted.problem.classes.length, g.handSize)) {
        // An empty blank class holds no card to build a hand from.
        const hand = handOfComposition(converted, h);
        if (hand === null) continue;
        const verdict = matches(h, g.handSize);
        const context = () => ({ index: i, h, hand, problem: g.problem });
        same(verdict, handSucceeds(converted.problem, h, g.handSize), context);
        same(verdict, satisfiesAnyFlat(g.flat, hand, fills), context);
        same(verdict, judge(hand), context);
        same(verdict, bruteForceSucceeds(converted.problem, h), context);
        compared++;
        if (verdict) succeeded++;
      }
    });
    // Pinned so the size of the check is on record; it moves only if the generator does.
    expect({ compared, succeeded }).toEqual({ compared: 13_668, succeeded: 8206 });
  });

  it('agrees on every composition of every small problem WITH range requirements', () => {
    const generated = smallRangedProblems();
    // The family is worth running only if it really holds ranges.
    expect(generated.filter(hasRange).length).toBeGreaterThanOrEqual(150);
    let compared = 0;
    let succeeded = 0;
    generated.forEach((g, i) => {
      const converted = problemFromMatrix(g.problem, [g.handSize]);
      const matches = compileMatcher(converted.problem);
      const judge = createJudge(g.problem);
      const fills = fillsOf(g.problem);
      for (const h of compositions(converted.problem.classes.length, g.handSize)) {
        const hand = handOfComposition(converted, h);
        if (hand === null) continue;
        const verdict = matches(h, g.handSize);
        const context = () => ({ index: i, h, hand, problem: g.problem });
        same(verdict, satisfiesAnyFlat(g.flat, hand, fills), context);
        same(verdict, judge(hand), context);
        same(verdict, bruteForceSucceeds(converted.problem, h), context);
        compared++;
        if (verdict) succeeded++;
      }
    });
    // Pinned so the size of the check is on record; it moves only if the generator does.
    expect({ compared, succeeded }).toEqual({ compared: 12_793, succeeded: 8012 });
  });

  it('agrees with brute force over classes, criterion by criterion, up to seven slots and hands of six', () => {
    let compared = 0;
    let feasible = 0;
    for (let seed = 0; seed < 300; seed++) {
      const { problem, H } = genClassProblem(seededRng(52_000 + seed), {
        classes: [2, 5],
        deckSize: [40, 40],
        handSize: [1, 6],
        slots: [0, 7],
        criteria: [1, 3],
      });
      const alone = problem.criteria.map((_, criterion) => compileMatcher(problem, { criterion }));
      const together = compileMatcher(problem);
      for (const h of compositions(problem.classes.length, H)) {
        problem.criteria.forEach((criterion, at) => {
          const expected = criterion.slots.length <= H && bruteForceMeets(criterion, h);
          same(alone[at]!(h, H), expected, () => ({ seed, h, H, criterion }));
          compared++;
          if (expected) feasible++;
        });
        same(together(h, H), bruteForceSucceeds(problem, h), () => ({ seed, h, H, problem }));
      }
    }
    expect({ compared, feasible }).toEqual({ compared: 18_573, feasible: 3580 });
  });
});

/**
 * Weighted criteria (PRD §5.6): what a hand is WORTH, rather than whether it
 * succeeds. The engine sorts the criteria by weight and stops at the first one
 * met; the oracle asks every criterion and takes the maximum, so the sort is
 * exactly what is under test.
 */
describe('compileWeigher', () => {
  /** Two criteria one hand can meet at once: the heavier is what it is worth. */
  const BOTH: CompiledCriterion[] = [
    { slots: [FILLS_X], limits: [], weight: 1 },
    { slots: [FILLS_Y], limits: [], weight: 5 },
  ];

  it('is worth the HIGHEST weight of the criteria met, never their sum', () => {
    const weigh = compileWeigher(problemOf(BOTH));
    // A hand of one Z meets both — Z fills `x` and `y` — and is worth 5, not 6.
    expect(weigh([2, 0, 0, 1], 3)).toBe(5);
    expect(weigh([1, 1, 1, 0], 3)).toBe(5);
    expect(weigh([2, 1, 0, 0], 3)).toBe(1);
    expect(weigh([2, 0, 1, 0], 3)).toBe(5);
    expect(weigh([3, 0, 0, 0], 3)).toBe(0);
  });

  it('does not depend on the order the criteria are written in', () => {
    const forwards = compileWeigher(problemOf(BOTH));
    const backwards = compileWeigher(problemOf([...BOTH].reverse()));
    for (const h of compositions(4, 3)) expect(backwards(h, 3)).toBe(forwards(h, 3));
  });

  it('answers 1 and 0 exactly where the matcher answers true and false', () => {
    for (const criteria of [
      [{ slots: [FILLS_X, FILLS_X], limits: [] }],
      [{ slots: [FILLS_X], limits: [{ mask: FILLS_Y, n: 1 }] }],
      [
        { slots: [FILLS_X], limits: [] },
        { slots: [FILLS_Y], limits: [] },
      ],
      [{ slots: [], limits: [] }],
      [],
    ] satisfies CompiledCriterion[][]) {
      const problem = problemOf(criteria);
      const matches = compileMatcher(problem);
      const weigh = compileWeigher(problem);
      for (const h of compositions(4, 3)) same(weigh(h, 3), matches(h, 3) ? 1 : 0, () => ({ h }));
    }
  });

  it('judges by one criterion alone when asked to, weight and all', () => {
    const problem = problemOf(BOTH);
    expect(compileWeigher(problem, { criterion: 0 })([2, 0, 0, 1], 3)).toBe(1);
    expect(compileWeigher(problem, { criterion: 1 })([2, 0, 0, 1], 3)).toBe(5);
    expect(compileWeigher(problem, { criterion: 1 })([2, 1, 0, 0], 3)).toBe(0);
    expect(() => compileWeigher(problem, { criterion: 2 })).toThrow(/no criterion 2/);
  });

  it('respects a ceiling, which decides which weight a hand reaches', () => {
    // `exactly 1x x` at weight 9, or plainly `1x x` at weight 2.
    const criteria: CompiledCriterion[] = [
      { slots: [FILLS_X], limits: [], reqs: [{ mask: FILLS_X, min: 1, max: 1 }], weight: 9 },
      { slots: [FILLS_X], limits: [], weight: 2 },
    ];
    const weigh = compileWeigher(problemOf(criteria));
    expect(weigh([2, 1, 0, 0], 3)).toBe(9);
    expect(weigh([1, 2, 0, 0], 3)).toBe(2);
    expect(weigh([3, 0, 0, 0], 3)).toBe(0);
  });

  it('agrees with the brute-force maximum on every composition of generated problems', () => {
    let compared = 0;
    const seen = new Set<number>();
    for (let seed = 0; seed < 150; seed++) {
      const rng = seededRng(97_000 + seed);
      const { problem, H } = genClassProblem(seededRng(96_000 + seed), {
        classes: [2, 7],
        deckSize: [40, 40],
        handSize: [1, 6],
        slots: [0, 7],
        criteria: [1, 4],
      });
      const weighted: Problem = {
        ...problem,
        criteria: problem.criteria.map((criterion) => ({ ...criterion, weight: rng.int(1, 7) })),
      };
      const weigh = compileWeigher(weighted);
      for (const h of compositions(weighted.classes.length, H)) {
        const worth = bruteForceWeight(weighted, h);
        same(weigh(h, H), worth, () => ({ seed, h, H, problem: weighted }));
        seen.add(worth);
        compared++;
      }
    }
    // Every weight in the range is reached, and so is 0: the agreement is not vacuous.
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Pinned so the size of the check is on record; it moves only if the generator does.
    expect(compared).toBe(18_416);
  });
});

/**
 * The SIXTH CARD (PRD §5.6). Classes: 0 blank, 1 X, 2 Y, 3 Z (both). A hand of
 * three whose last card is drawn: the two cards opened on, and the one drawn.
 */
describe('compileValuer', () => {
  const worth = (problem: Problem, h: number[], H: number, drawn: boolean): Worth => {
    const into: Worth = { value: 0, plain: 0 };
    compileValuer(problem, H, { drawn }).worth(h, into);
    return into;
  };

  describe('with nothing split', () => {
    it('is the weight of the hand, once per outcome', () => {
      const problem = problemOf([{ slots: [FILLS_X], limits: [] }]);
      expect(worth(problem, [2, 1, 0, 0], 3, false)).toEqual({ value: 1, plain: 1 });
      expect(worth(problem, [2, 1, 0, 0], 3, true)).toEqual({ value: 3, plain: 3 });
      expect(worth(problem, [3, 0, 0, 0], 3, true)).toEqual({ value: 0, plain: 0 });
    });

    it('scales a criterion weight the same way', () => {
      const problem = problemOf([{ slots: [FILLS_X], limits: [], weight: 5 }]);
      expect(worth(problem, [2, 1, 0, 0], 3, true)).toEqual({ value: 15, plain: 3 });
    });

    it('reports the outcomes and the ceilings a composition can reach', () => {
      const problem = problemOf([{ slots: [FILLS_X], limits: [], weight: 5 }]);
      expect(compileValuer(problem, 3, { drawn: true })).toMatchObject({
        outcomes: 3,
        maxValue: 15,
        maxPlain: 3,
      });
      expect(compileValuer(problem, 3, {})).toMatchObject({
        outcomes: 1,
        maxValue: 5,
        maxPlain: 1,
      });
    });
  });

  describe('with a split criterion', () => {
    /** A hand of `H` whose last card is drawn separately. */
    const drawnOf = (criteria: CompiledCriterion[], H = 3): Problem => ({
      ...problemOf(criteria),
      handSizes: [{ H, weight: 1, drawn: true }],
    });
    /** The cards opened on hold an X, and the card drawn is a Y — Z being both. */
    const xThenY = drawnOf([
      { slots: [FILLS_X], limits: [], sixth: { slots: [FILLS_Y], limits: [] } },
    ]);

    it('counts one outcome per card that could have been the one drawn', () => {
      // [blank, X, Y, Z] = one X, one Y, one blank. Only the Y can be the card
      // drawn, and the two left then hold the X: one outcome of three.
      expect(worth(xThenY, [1, 1, 1, 0], 3, true)).toEqual({ value: 1, plain: 1 });
      // Two Y's: either can be the one drawn, and the other two cards still
      // hold the X.
      expect(worth(xThenY, [0, 1, 2, 0], 3, true)).toEqual({ value: 2, plain: 2 });
      // No Y at all: no outcome succeeds.
      expect(worth(xThenY, [1, 2, 0, 0], 3, true)).toEqual({ value: 0, plain: 0 });
      // A Y but no X beside it: the Y is drawn and the rest hold nothing.
      expect(worth(xThenY, [2, 0, 1, 0], 3, true)).toEqual({ value: 0, plain: 0 });
    });

    it('takes the card drawn OUT of the cards opened on', () => {
      // One X and one Y and nothing else, at a hand of two: the Y is drawn, the
      // X is opened on. The X cannot be both.
      const two = { ...xThenY, handSizes: [{ H: 2, weight: 1, drawn: true as const }] };
      expect(worth(two, [0, 1, 1, 0], 2, true)).toEqual({ value: 1, plain: 1 });
      // Two X's and no Y fails; one Z (which is both) drawn leaves the other
      // card to hold the X.
      expect(worth(two, [0, 2, 0, 0], 2, true)).toEqual({ value: 0, plain: 0 });
      expect(worth(two, [0, 1, 0, 1], 2, true)).toEqual({ value: 1, plain: 1 });
      // One Z alone, at a hand of one card, cannot be both windows.
      const one = { ...xThenY, handSizes: [{ H: 2, weight: 1, drawn: true as const }] };
      expect(worth(one, [1, 0, 0, 1], 2, true)).toEqual({ value: 0, plain: 0 });
    });

    it('lets the BLANK class be the card drawn when the sixth part is limits alone', () => {
      // `no Y` of one card: a blank card is not a Y, so it passes — which is
      // what a limit has always meant (it counts what provably matches).
      const noY = drawnOf(
        [{ slots: [FILLS_X], limits: [], sixth: { slots: [], limits: [{ mask: FILLS_Y, n: 0 }] } }],
        2,
      );
      // Blank drawn, X opened on: one outcome. X drawn: not an X left over, so no.
      expect(worth(noY, [1, 1, 0, 0], 2, true)).toEqual({ value: 1, plain: 1 });
      // Two X's: either drawn leaves the other to fill the slot, and an X is not a Y.
      expect(worth(noY, [0, 2, 0, 0], 2, true)).toEqual({ value: 2, plain: 2 });
      // A Y drawn fails its own part, and with the Y opened on instead there is
      // no X left to fill the slot: neither outcome succeeds.
      expect(worth(noY, [0, 1, 1, 0], 2, true)).toEqual({ value: 0, plain: 0 });
    });

    it('takes the best of the unsplit and split criteria, outcome by outcome', () => {
      const both = drawnOf([
        { slots: [FILLS_X], limits: [], sixth: { slots: [FILLS_Y], limits: [] }, weight: 10 },
        { slots: [FILLS_Y], limits: [], weight: 3 },
      ]);
      // One X and one Y: the Y drawn meets the split criterion (10); the X
      // drawn meets only the unsplit one, which the whole hand meets (3).
      expect(worth(both, [1, 1, 1, 0], 3, true)).toEqual({ value: 10 + 3 + 3, plain: 3 });
      // No Y: only the unsplit criterion, and it is not met either.
      expect(worth(both, [1, 2, 0, 0], 3, true)).toEqual({ value: 0, plain: 0 });
    });

    it('refuses to be asked for a hand that draws no card', () => {
      expect(() => compileValuer(xThenY, 3, {})).toThrow(
        /criterion 0 is about the card you draw, but this hand of 3 draws none/,
      );
      // And the two readers that see a hand as ONE window refuse it outright.
      expect(() => compileMatcher(xThenY)).toThrow(/a matcher reads a hand as one window/);
      expect(() => compileWeigher(xThenY)).toThrow(/a weigher reads a hand as one window/);
    });
  });

  it('answers what the unsplit weigher answers, on every composition of a generated problem', () => {
    // Two implementations of "the highest weight among the criteria met": the
    // weigher's, and the valuer's undrawn path. They are held equal rather than
    // shared, which is what stops them drifting.
    for (let seed = 0; seed < 120; seed++) {
      const rng = seededRng(0x5a1500 + seed);
      const { problem, H } = genClassProblem(seededRng(0x5a1600 + seed), {
        classes: [2, 6],
        deckSize: [40, 40],
        handSize: [1, 6],
        slots: [0, 7],
        criteria: [1, 3],
      });
      for (const criterion of problem.criteria) criterion.weight = rng.pick([1, 1, 2, 5, 9]);
      const weigh = compileWeigher(problem);
      const valuer = compileValuer(problem, H, {});
      const into: Worth = { value: 0, plain: 0 };
      for (const h of compositions(problem.classes.length, H)) {
        valuer.worth(h, into);
        const weight = weigh(h, H);
        same(into.value, weight, () => ({ seed, problem, h, H }));
        same(into.plain, weight > 0 ? 1 : 0, () => ({ seed, problem, h, H }));
      }
    }
  });
});

/**
 * The weigher for a hand dealt in TWO PIECES, the cards opened on and the
 * cards drawn (PRD §5.6, §5.7). It is `compileValuer`'s counterpart for DRAW
 * CARDS, where the drawn side is a SET rather than one card — so there is no
 * precomputed "which classes a lone card satisfies" to lean on, and the drawn
 * part is judged as the ordinary criterion it is.
 */
describe('compileSplitWeigher', () => {
  /**
   * A hand of `opened` and `drawn`, each `[blank, X, Y, Z]`. Class X is marked
   * as DRAWING — not because the weigher reads that, which it does not, but
   * because `validateProblem` bounds a drawn part's slots by what the template
   * can fetch, and a drawn set of more than one card is only sayable where
   * something draws.
   */
  const weigh = (criteria: CompiledCriterion[], opened: number[], drawn: number[]) => {
    const size = (h: number[]) => h.reduce((sum, count) => sum + count, 0);
    const base = problemOf(criteria);
    const problem: Problem = {
      ...base,
      handSizes: [{ H: size(opened) + size(drawn), weight: 1, drawn: true }],
      classes: base.classes.map((info, cls) =>
        cls === 1 ? { ...info, max: 1, draw: { n: 3 } } : info,
      ),
    };
    return compileSplitWeigher(problem)(opened, size(opened), drawn, size(drawn));
  };

  const needsInDrawn = (mask: number, slots = 1): CompiledCriterion => ({
    slots: [],
    limits: [],
    sixth: { slots: new Array<number>(slots).fill(mask), limits: [] },
  });

  it('judges a criterion naming no drawn set over the two windows TOGETHER', () => {
    const whole: CompiledCriterion = { slots: [FILLS_X, FILLS_Y], limits: [] };
    // One from each side: neither window holds both, and the hand does.
    expect(weigh([whole], [0, 1, 0, 0], [0, 0, 1, 0])).toBe(1);
    expect(weigh([whole], [0, 1, 0, 0], [1, 0, 0, 0])).toBe(0);
  });

  it('judges a split criterion over the two windows apart, and never across them', () => {
    const split: CompiledCriterion = {
      slots: [FILLS_X],
      limits: [],
      sixth: { slots: [FILLS_Y], limits: [] },
    };
    expect(weigh([split], [0, 1, 0, 0], [0, 0, 1, 0])).toBe(1);
    // Both cards on the drawn side: the opening fills nothing, so it fails —
    // which is the whole difference from asking the same of the hand.
    expect(weigh([split], [1, 0, 0, 0], [0, 1, 1, 0])).toBe(0);
  });

  it('reads a drawn set of more than one card, which is what draw cards make of it', () => {
    const two = needsInDrawn(FILLS_Y, 2);
    expect(weigh([two], [1, 0, 0, 0], [0, 0, 2, 0])).toBe(1);
    // One card drawn can never answer it, however good the opening is.
    expect(weigh([two], [0, 0, 2, 0], [0, 0, 1, 0])).toBe(0);
  });

  it('counts a limit on the drawn set over the drawn set alone', () => {
    const noY: CompiledCriterion = {
      slots: [FILLS_X],
      limits: [],
      sixth: { slots: [], limits: [{ mask: FILLS_Y, n: 0 }] },
    };
    expect(weigh([noY], [0, 1, 1, 0], [1, 0, 0, 0])).toBe(1);
    expect(weigh([noY], [0, 1, 0, 0], [0, 0, 1, 0])).toBe(0);
  });

  it('takes the HIGHEST weight among the criteria met, split and unsplit alike', () => {
    const cheap: CompiledCriterion = { slots: [FILLS_X], limits: [], weight: 2 };
    const dear = { ...needsInDrawn(FILLS_Y), weight: 7 };
    expect(weigh([cheap, dear], [0, 1, 0, 0], [0, 0, 1, 0])).toBe(7);
    expect(weigh([cheap, dear], [0, 1, 0, 0], [1, 0, 0, 0])).toBe(2);
    expect(weigh([cheap, dear], [1, 0, 0, 0], [1, 0, 0, 0])).toBe(0);
  });

  /**
   * Against the brute-force oracle, over every way to split a small hand into
   * the two windows: the engine assigns by Hall's condition and precomputed
   * subset unions, and the oracle tries every assignment of cards to slots.
   */
  it('agrees with brute force over every hand and every place to split it', () => {
    const criteria: CompiledCriterion[] = [
      { slots: [FILLS_X], limits: [], sixth: { slots: [FILLS_Y], limits: [] } },
      { slots: [FILLS_X, FILLS_Y], limits: [], weight: 3 },
      {
        slots: [],
        limits: [],
        sixth: { slots: [FILLS_Y], limits: [{ mask: X, n: 0 }] },
        weight: 5,
      },
    ];
    let checked = 0;
    for (const opened of compositions(4, 2))
      for (const drawn of compositions(4, 2)) {
        const mine = weigh(criteria, [...opened], [...drawn]);
        const whole = opened.map((count, cls) => count + drawn[cls]!);
        let best = 0;
        for (const criterion of criteria) {
          const weight = criterion.weight ?? 1;
          if (weight <= best) continue;
          const met =
            criterion.sixth === undefined
              ? bruteForceMeets(criterion, whole)
              : bruteForceMeets(criterion, opened) && bruteForceMeets(criterion.sixth, drawn);
          if (met) best = weight;
        }
        same(mine, best, () => ({ opened: [...opened], drawn: [...drawn] }));
        checked++;
      }
    expect(checked).toBe(100);
  });

  /**
   * A `finally` part is judged over the two windows SUMMED, which with draw
   * cards is the whole hand you are left holding — every card still in it when
   * the drawing stops. It is the one window that can be broken by a card the
   * draw cards fetched, which is why the clause exists.
   */
  describe('a `finally` part', () => {
    const needsInWhole = (mask: number, slots = 1): CompiledCriterion => ({
      slots: [],
      limits: [],
      whole: { slots: new Array<number>(slots).fill(mask), limits: [] },
    });

    it('judges it over the two windows together, wherever the cards fell', () => {
      const criterion = needsInWhole(FILLS_Y, 2);
      expect(weigh([criterion], [0, 0, 2, 0], [0, 0, 0, 0])).toBe(1);
      expect(weigh([criterion], [0, 0, 0, 0], [0, 0, 2, 0])).toBe(1);
      expect(weigh([criterion], [0, 0, 1, 0], [0, 0, 1, 0])).toBe(1);
      expect(weigh([criterion], [0, 0, 1, 0], [1, 0, 0, 0])).toBe(0);
    });

    it('keeps the opening part about the cards OPENED ON, with no `then` in sight', () => {
      const criterion: CompiledCriterion = {
        slots: [FILLS_X],
        limits: [],
        whole: { slots: [], limits: [{ mask: Y, n: 0 }] },
      };
      // X opened on and no Y anywhere: met.
      expect(weigh([criterion], [0, 1, 0, 0], [1, 0, 0, 0])).toBe(1);
      // The X is in the DRAWN window, so the opening part is unmet.
      expect(weigh([criterion], [1, 0, 0, 0], [0, 1, 0, 0])).toBe(0);
      // A Y drawn breaks the `finally` limit, though the opening was fine.
      expect(weigh([criterion], [0, 1, 0, 0], [0, 0, 1, 0])).toBe(0);
    });

    it('conjoins all three windows when all three are there', () => {
      const criterion: CompiledCriterion = {
        slots: [FILLS_X],
        limits: [],
        sixth: { slots: [FILLS_Y], limits: [] },
        whole: { slots: [], limits: [{ mask: Z, n: 0 }] },
      };
      expect(weigh([criterion], [0, 1, 0, 0], [0, 0, 1, 0])).toBe(1);
      expect(weigh([criterion], [0, 1, 0, 0], [0, 0, 1, 1])).toBe(0);
      // No X opened on: the opening part is unmet though the hand holds one.
      expect(weigh([criterion], [1, 0, 0, 0], [0, 1, 1, 0])).toBe(0);
      // Nothing of Y drawn: the `then` part is unmet.
      expect(weigh([criterion], [0, 1, 0, 0], [1, 0, 0, 0])).toBe(0);
    });

    it('agrees with brute force over every hand and every place to split it', () => {
      const criteria: CompiledCriterion[] = [
        { slots: [FILLS_X], limits: [], whole: { slots: [FILLS_Y], limits: [] } },
        {
          slots: [FILLS_X],
          limits: [],
          sixth: { slots: [FILLS_Y], limits: [] },
          whole: { slots: [], limits: [{ mask: Z, n: 0 }] },
          weight: 4,
        },
        { slots: [], limits: [], whole: { slots: [], limits: [{ mask: X, n: 0 }] }, weight: 2 },
        { slots: [FILLS_X, FILLS_Y], limits: [], weight: 3 },
      ];
      let checked = 0;
      for (const opened of compositions(4, 2))
        for (const drawn of compositions(4, 2)) {
          const mine = weigh(criteria, [...opened], [...drawn]);
          const summed = opened.map((count, cls) => count + drawn[cls]!);
          let best = 0;
          for (const criterion of criteria) {
            const weight = criterion.weight ?? 1;
            if (weight <= best) continue;
            const split = criterion.sixth !== undefined || criterion.whole !== undefined;
            const met = split
              ? bruteForceMeets(criterion, opened) &&
                (criterion.sixth === undefined || bruteForceMeets(criterion.sixth, drawn)) &&
                (criterion.whole === undefined || bruteForceMeets(criterion.whole, summed))
              : bruteForceMeets(criterion, summed);
            if (met) best = weight;
          }
          same(mine, best, () => ({ opened: [...opened], drawn: [...drawn] }));
          checked++;
        }
      expect(checked).toBe(100);
    });
  });
});
