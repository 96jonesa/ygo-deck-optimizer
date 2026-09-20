import { describe, expect, it } from 'vitest';
import type { CompiledCriterion, Problem } from '../../../src/core/model/problem';
import { compileMatcher, handSucceeds } from '../../../src/core/prob/matcher';
import { createJudge } from '../../../src/core/prob/montecarlo';
import { same } from '../../helpers/assert';
import { compositions } from '../../helpers/combinatorics';
import { satisfiesAnyFlat } from '../../helpers/criteria-oracle';
import { genClassProblem } from '../../helpers/gen-class-problem';
import { fillsOf, hasRange, smallProblems, smallRangedProblems } from '../../helpers/gen-problem';
import { bruteForceMeets, bruteForceSucceeds } from '../../helpers/matcher-oracle';
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
