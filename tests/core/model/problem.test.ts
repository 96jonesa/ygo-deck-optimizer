import { describe, expect, it } from 'vitest';
import { MAX_RANGES, MAX_SIXTH_SLOTS } from '../../../src/core/criteria/ast';
import {
  checkWeightBound,
  copiesUsed,
  type DrawSpec,
  drawClassesOf,
  drawsOf,
  largestDrawnSet,
  largestHand,
  longestPrefix,
  MAX_CLASSES,
  MAX_DECK_SIZE,
  MAX_HAND,
  MAX_HAND_SIZE,
  MAX_PREFIX,
  outcomesOf,
  type Problem,
  partProblem,
  slotCount,
  validateProblem,
} from '../../../src/core/model/problem';

/** Blank, A and B; success is drawing A and B, with at most one A. */
function valid(): Problem {
  return {
    deckSize: 40,
    handSizes: [{ H: 5, weight: 1 }],
    classes: [
      { lineIds: ['remainder'], min: 31, max: 40 },
      { lineIds: ['a'], min: 0, max: 3 },
      { lineIds: ['b', 'c'], min: 0, max: 6 },
    ],
    criteria: [{ slots: [0b010, 0b100], limits: [{ mask: 0b010, n: 1 }] }],
  };
}

function classes(count: number): Problem['classes'] {
  return Array.from({ length: count }, (_, cls) => ({ lineIds: [`l${cls}`], min: 0, max: 3 }));
}

describe('outcomesOf', () => {
  it('is 1 for a hand that draws no card of its own', () => {
    expect(outcomesOf({ H: 6 })).toBe(1);
    expect(outcomesOf({ H: 5, drawn: false })).toBe(1);
  });

  it('is the hand size where the last card is drawn: one outcome per card it could be', () => {
    expect(outcomesOf({ H: 6, drawn: true })).toBe(6);
    expect(outcomesOf({ H: 2, drawn: true })).toBe(2);
  });
});

describe('validateProblem', () => {
  describe('the sixth card', () => {
    /** Blank, A and B; the five hold an A and the card drawn is a B. */
    const split = (): Problem => ({
      ...valid(),
      handSizes: [{ H: 6, weight: 1, drawn: true }],
      criteria: [{ slots: [0b010], limits: [], sixth: { slots: [0b100], limits: [] } }],
    });

    it('accepts a split criterion judged by a hand that draws one', () => {
      expect(() => validateProblem(split())).not.toThrow();
    });

    it('refuses a split criterion judged by a hand that draws none', () => {
      const first = { ...split(), handSizes: [{ H: 6, weight: 1 }] };
      expect(() => validateProblem(first)).toThrow(
        /criterion 0 is about the card you draw, but this hand does not draw one/,
      );
      // And through a part's own criteria list, not only the implicit "all of them".
      const tagged = {
        ...split(),
        handSizes: [
          { H: 5, weight: 1, criteria: [0] },
          { H: 6, weight: 1, drawn: true, criteria: [0] },
        ],
      };
      expect(() => validateProblem(tagged)).toThrow(/hand size 5: criterion 0/);
    });

    it('lets a hand draw one with nothing split: it is the same score, six times over', () => {
      expect(() =>
        validateProblem({ ...valid(), handSizes: [{ H: 6, weight: 1, drawn: true }] }),
      ).not.toThrow();
    });

    it('refuses a hand of one that draws its only card: there is nothing to open on', () => {
      expect(() =>
        validateProblem({ ...valid(), handSizes: [{ H: 1, weight: 1, drawn: true }] }),
      ).toThrow(/holds at least 2 cards/);
    });

    it('refuses a drawn part asked for more than one card, where nothing draws', () => {
      const greedy = {
        ...split(),
        criteria: [{ slots: [0b010], limits: [], sixth: { slots: [0b100, 0b100], limits: [] } }],
      };
      expect(() => validateProblem(greedy)).toThrow(
        /criterion 0: the card you draw is one card, and its part asks for 2/,
      );
    });

    it("checks the sixth card's own masks, limits and ranges", () => {
      const blank = {
        ...split(),
        criteria: [{ slots: [], limits: [], sixth: { slots: [0b001], limits: [] } }],
      };
      expect(() => validateProblem(blank)).toThrow(
        /criterion 0, the cards you draw, slot 0: the blank class \(bit 0\) cannot fill a requirement/,
      );
      const bad = {
        ...split(),
        criteria: [
          {
            slots: [],
            limits: [],
            sixth: { slots: [], limits: [], reqs: [{ mask: 0b100, min: 0, max: null }] },
          },
        ],
      };
      expect(() => validateProblem(bad)).toThrow(
        /criterion 0, the cards you draw: with no ceiling to keep/,
      );
    });
  });

  it('accepts a well-formed problem', () => {
    expect(() => validateProblem(valid())).not.toThrow();
  });

  it('pins the limits the exact arithmetic rests on', () => {
    expect(MAX_CLASSES).toBe(30);
    expect(MAX_DECK_SIZE).toBe(60);
    expect(MAX_HAND_SIZE).toBe(6);
  });

  it('accepts what is unusual but legal', () => {
    // No criteria at all: every hand fails.
    expect(() => validateProblem({ ...valid(), criteria: [] })).not.toThrow();
    // An empty criterion: every hand succeeds.
    expect(() =>
      validateProblem({ ...valid(), criteria: [{ slots: [], limits: [] }] }),
    ).not.toThrow();
    // A slot no class fills, and a limit that counts nothing.
    expect(() =>
      validateProblem({ ...valid(), criteria: [{ slots: [0], limits: [{ mask: 0, n: 0 }] }] }),
    ).not.toThrow();
    // A class that no mask mentions, and an empty blank class.
    const problem = valid();
    problem.classes.push({ lineIds: ['unmentioned'], min: 0, max: 3 });
    problem.classes[0] = { lineIds: [], min: 0, max: 0 };
    expect(() => validateProblem(problem)).not.toThrow();
    // More slots than any hand holds: never met, not malformed.
    expect(() =>
      validateProblem({ ...valid(), criteria: [{ slots: new Array(8).fill(0b010), limits: [] }] }),
    ).not.toThrow();
    // A first/second blend.
    expect(() =>
      validateProblem({
        ...valid(),
        handSizes: [
          { H: 5, weight: 3 },
          { H: 6, weight: 2 },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts 30 classes with the top bit in a mask, and refuses 31', () => {
    const top = 2 ** 29;
    const full = { ...valid(), classes: classes(30), criteria: [{ slots: [top], limits: [] }] };
    expect(() => validateProblem(full)).not.toThrow();
    expect(() => validateProblem({ ...full, classes: classes(31) })).toThrow(/at most 30 classes/);
  });

  it('refuses a problem with no classes: class 0 is always the blank class', () => {
    expect(() => validateProblem({ ...valid(), classes: [], criteria: [] })).toThrow(/blank class/);
  });

  it('refuses the blank class in a slot mask', () => {
    const problem = valid();
    problem.criteria[0]!.slots[1] = 0b101;
    expect(() => validateProblem(problem)).toThrow(
      /criterion 0, slot 1: the blank class \(bit 0\) cannot fill a requirement/,
    );
  });

  it('refuses the blank class in a limit mask', () => {
    const problem = valid();
    problem.criteria[0]!.limits[0]!.mask = 0b011;
    expect(() => validateProblem(problem)).toThrow(
      /criterion 0, limit 0: the blank class \(bit 0\) cannot count against a limit/,
    );
  });

  it('refuses a mask that names a class the problem does not have', () => {
    const slot = valid();
    slot.criteria[0]!.slots[0] = 0b1000;
    expect(() => validateProblem(slot)).toThrow(/criterion 0, slot 0: .*only 3 classes/);
    const limit = valid();
    limit.criteria[0]!.limits[0]!.mask = 2 ** 31;
    expect(() => validateProblem(limit)).toThrow(/criterion 0, limit 0: .*only 3 classes/);
  });

  it('refuses a mask that is not a whole non-negative number', () => {
    for (const mask of [-2, 2.5, Number.NaN]) {
      const problem = valid();
      problem.criteria[0]!.slots[0] = mask;
      expect(() => validateProblem(problem)).toThrow(RangeError);
    }
  });

  it('refuses a limit that is not a whole non-negative count', () => {
    for (const n of [-1, 1.5, Number.NaN]) {
      const problem = valid();
      problem.criteria[0]!.limits[0]!.n = n;
      expect(() => validateProblem(problem)).toThrow(/criterion 0, limit 0: .*count/);
    }
  });

  it('refuses a deck the binomial table does not cover', () => {
    for (const deckSize of [0, -40, 40.5, 61])
      expect(() => validateProblem({ ...valid(), deckSize })).toThrow(/deck size/);
    expect(() => validateProblem({ ...valid(), deckSize: 60 })).not.toThrow();
  });

  it('refuses no hand size, a hand size outside 1 to 6 or above the deck, and a repeated one', () => {
    expect(() => validateProblem({ ...valid(), handSizes: [] })).toThrow(/hand size/);
    for (const H of [0, 7, 5.5, -1])
      expect(() => validateProblem({ ...valid(), handSizes: [{ H, weight: 1 }] })).toThrow(
        /hand size/,
      );
    expect(() =>
      validateProblem({ ...valid(), deckSize: 4, handSizes: [{ H: 5, weight: 1 }] }),
    ).toThrow(/hand size/);
    expect(() =>
      validateProblem({
        ...valid(),
        handSizes: [
          { H: 5, weight: 1 },
          { H: 5, weight: 2 },
        ],
      }),
    ).toThrow(/hand size 5 appears twice/);
  });

  it('refuses a weight that is not a positive whole number: blends are ranked exactly', () => {
    for (const weight of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => validateProblem({ ...valid(), handSizes: [{ H: 5, weight }] })).toThrow(
        /weight/,
      );
  });

  it('refuses a class range that is not 0 <= min <= max in whole cards', () => {
    for (const [min, max] of [
      [2, 1],
      [-1, 3],
      [0, 2.5],
      [Number.NaN, 3],
    ] as const) {
      const problem = valid();
      problem.classes[1] = { lineIds: ['a'], min, max };
      expect(() => validateProblem(problem)).toThrow(/class 1/);
    }
  });

  describe('range requirements', () => {
    /** `valid()` with its two slots read as requirements, the first capped at 2. */
    function ranged(): Problem {
      const problem = valid();
      problem.criteria[0]!.reqs = [
        { mask: 0b010, min: 1, max: 2 },
        { mask: 0b100, min: 1, max: null },
      ];
      return problem;
    }

    it('accepts requirements that agree with the slots', () => {
      expect(() => validateProblem(ranged())).not.toThrow();
    });

    it('refuses requirements whose lower bounds are not the slots', () => {
      const missing = ranged();
      missing.criteria[0]!.reqs![0]!.min = 2;
      expect(() => validateProblem(missing)).toThrow(/slots.*lower bounds/s);
      const wrongMask = ranged();
      wrongMask.criteria[0]!.reqs![0]!.mask = 0b100;
      expect(() => validateProblem(wrongMask)).toThrow(/slots/);
    });

    it('refuses a requirement list that keeps no ceiling', () => {
      const none = ranged();
      none.criteria[0]!.reqs![0]!.max = null;
      expect(() => validateProblem(none)).toThrow(/no ceiling/);
    });

    it('refuses a range that runs high to low, or is not whole', () => {
      for (const [min, max] of [
        [2, 1],
        [1, 0.5],
        [1, -1],
      ] as const) {
        const problem = ranged();
        problem.criteria[0]!.reqs = [
          { mask: 0b010, min, max },
          { mask: 0b100, min: 1, max: null },
        ];
        problem.criteria[0]!.slots = [...new Array<number>(min).fill(0b010), 0b100];
        expect(() => validateProblem(problem), `${min}-${max}`).toThrow(/requirement 0/);
      }
    });

    it('refuses a ceiling no class can reach: compile drops it instead', () => {
      const unreachable = ranged();
      unreachable.criteria[0]!.reqs = [
        { mask: 0, min: 0, max: 1 },
        { mask: 0b010, min: 1, max: null },
        { mask: 0b100, min: 1, max: null },
      ];
      expect(() => validateProblem(unreachable)).toThrow(/no class can reach/);
    });

    it('refuses a ceiling mask that names a class the problem does not have', () => {
      // A lower bound of 0 puts no slot in the way, so the requirement's own check is reached.
      const problem = ranged();
      problem.criteria[0]!.reqs = [
        { mask: 0b1000, min: 0, max: 1 },
        { mask: 0b010, min: 1, max: null },
        { mask: 0b100, min: 1, max: null },
      ];
      expect(() => validateProblem(problem)).toThrow(/requirement 0: .*only 3 classes/);
    });

    it(`refuses more than ${MAX_RANGES} ranges`, () => {
      const problem = valid();
      problem.criteria[0]!.slots = [];
      problem.criteria[0]!.reqs = Array.from({ length: MAX_RANGES + 1 }, () => ({
        mask: 0b010,
        min: 0,
        max: 1,
      }));
      expect(() => validateProblem(problem)).toThrow(new RegExp(String(MAX_RANGES)));
    });
  });
});

/**
 * ONE part of a blend as a problem of its own (PRD §5.5): the same deck, the
 * SAME classes, and only the criteria that part is judged against.
 */
describe('validateProblem', () => {
  describe('unique requirements', () => {
    const withUniques = (uniques: unknown): Problem => ({
      ...valid(),
      criteria: [{ slots: [], limits: [], uniques } as Problem['criteria'][number]],
    });

    it('accepts one, a mask of 0 included: nothing fills it, and it scores 0', () => {
      expect(() => validateProblem(withUniques([{ mask: 0b110, n: 2 }]))).not.toThrow();
      expect(() => validateProblem(withUniques([{ mask: 0, n: 1 }]))).not.toThrow();
    });

    it('refuses an empty list, a count that is not positive, and the blank class', () => {
      expect(() => validateProblem(withUniques([]))).toThrow(/`uniques` is left out/);
      expect(() => validateProblem(withUniques([{ mask: 0b110, n: 0 }]))).toThrow(
        /criterion 0, unique requirement 0: it asks for a positive whole number of cards, not 0/,
      );
      expect(() => validateProblem(withUniques([{ mask: 0b111, n: 1 }]))).toThrow(/blank class/);
    });

    it('accepts a ceiling, and a count of 0 beside one', () => {
      expect(() => validateProblem(withUniques([{ mask: 0b110, n: 1, max: 2 }]))).not.toThrow();
      expect(() => validateProblem(withUniques([{ mask: 0b110, n: 0, max: 1 }]))).not.toThrow();
    });

    it('refuses a ceiling below its count, one nothing reaches, and too many ceilings', () => {
      expect(() => validateProblem(withUniques([{ mask: 0b110, n: 2, max: 1 }]))).toThrow(
        /unique requirement 0: a range is 0 <= n <= max in whole cards, not 2 to 1/,
      );
      expect(() => validateProblem(withUniques([{ mask: 0, n: 0, max: 1 }]))).toThrow(
        /a ceiling no class can reach binds nothing and is dropped/,
      );
      const many = Array.from({ length: MAX_RANGES + 1 }, () => ({ mask: 0b110, n: 0, max: 1 }));
      expect(() => validateProblem(withUniques(many))).toThrow(
        `the engine judges at most ${MAX_RANGES} range requirements, not ${MAX_RANGES + 1}`,
      );
    });

    it('counts its cards against what the card drawn can hold', () => {
      const problem: Problem = {
        ...valid(),
        handSizes: [{ H: 5, weight: 1, drawn: true }],
        criteria: [
          {
            slots: [],
            limits: [],
            sixth: { slots: [], limits: [], uniques: [{ mask: 0b110, n: 2 }] },
          },
        ],
      };
      expect(() => validateProblem(problem)).toThrow(
        /the card you draw is one card, and its part asks for 2/,
      );
    });
  });
});

describe('slotCount', () => {
  it("is the slots, and every unique requirement's count", () => {
    expect(slotCount({ slots: [2, 4] })).toBe(2);
    expect(
      slotCount({
        slots: [2],
        uniques: [
          { mask: 6, n: 3 },
          { mask: 2, n: 1 },
        ],
      }),
    ).toBe(5);
  });
});

describe('checkWeightBound', () => {
  it('lets every weight the editor allows through, drawn or not', () => {
    for (const outcomes of [1, 6])
      expect(() => checkWeightBound(60, 6, 1000, outcomes)).not.toThrow();
  });

  /**
   * The sixth card multiplies the headroom away exactly as a weight does, so it
   * belongs to the SAME bound: `6 · C(60, 6) = 300,383,160` leaves 29,985,699
   * where an undrawn hand leaves 179,914,198.
   */
  it('counts the outcomes per hand against the same 2^53', () => {
    expect(() => checkWeightBound(60, 6, 179_914_198)).not.toThrow();
    expect(() => checkWeightBound(60, 6, 179_914_199)).toThrow(/past 2\^53/);
    expect(() => checkWeightBound(60, 6, 29_985_699, 6)).not.toThrow();
    expect(() => checkWeightBound(60, 6, 29_985_700, 6)).toThrow(/past 2\^53/);
  });

  it('names the outcomes in the message, and the largest weight that fits', () => {
    expect(() => checkWeightBound(60, 6, 29_985_700, 6)).toThrow(
      /6 × C\(60, 6\) = 29985700 × 300383160/,
    );
    expect(() => checkWeightBound(60, 6, 29_985_700, 6)).toThrow(
      /the largest weight this deck and hand allow is 29985699/,
    );
  });

  it('is checked for a weight of 1 too, since the outcomes alone can be the whole of it', () => {
    // A weight of 1 was once returned on unchecked; with outcomes in the product
    // that shortcut would be the one place the bound is not looked at.
    expect(() => checkWeightBound(60, 6, 1, 6)).not.toThrow();
  });
});

describe('partProblem', () => {
  /** Two criteria, so a part can have one of them. */
  function twoCriteria(): Problem {
    return {
      ...valid(),
      handSizes: [
        { H: 5, weight: 1, criteria: [0] },
        { H: 6, weight: 2, criteria: [1] },
      ],
      criteria: [
        { slots: [0b010], limits: [] },
        { slots: [0b100], limits: [] },
      ],
    };
  }

  it('carries `drawn` into the part: it says what a HAND is', () => {
    const problem = {
      ...twoCriteria(),
      handSizes: [
        { H: 5, weight: 1, criteria: [0] },
        { H: 6, weight: 2, drawn: true as const, criteria: [1] },
      ],
    };
    expect(partProblem(problem, problem.handSizes[0]!).handSizes).toEqual([{ H: 5, weight: 1 }]);
    expect(partProblem(problem, problem.handSizes[1]!).handSizes).toEqual([
      { H: 6, weight: 1, drawn: true },
    ]);
  });

  it('keeps only the criteria the part names, in the order it names them', () => {
    const problem = twoCriteria();
    expect(partProblem(problem, problem.handSizes[0]!).criteria).toEqual([problem.criteria[0]]);
    expect(partProblem(problem, problem.handSizes[1]!).criteria).toEqual([problem.criteria[1]]);
  });

  /**
   * The load-bearing one. A class vector is meaningless without the class list
   * that says what a total counts, so two parts built from two lists would be
   * averaging two different decks and nothing downstream could tell. Sharing
   * the array makes that unsayable rather than merely untrue.
   */
  it('shares the very same `classes` array, so a vector cannot mean two decks', () => {
    const problem = twoCriteria();
    for (const hand of problem.handSizes)
      expect(partProblem(problem, hand).classes).toBe(problem.classes);
  });

  it('keeps the deck size, and reduces the part to a hand of weight 1', () => {
    const problem = twoCriteria();
    const part = partProblem(problem, problem.handSizes[1]!);
    expect(part.deckSize).toBe(problem.deckSize);
    expect(part.handSizes).toEqual([{ H: 6, weight: 1 }]);
  });

  it('is every criterion when the part names none: a plain problem is unchanged', () => {
    const problem = valid();
    expect(partProblem(problem, problem.handSizes[0]!).criteria).toBe(problem.criteria);
  });

  it('gives a part that names no criterion an empty list, which scores 0', () => {
    const problem = twoCriteria();
    expect(partProblem(problem, { H: 5, weight: 1, criteria: [] }).criteria).toEqual([]);
  });

  it('throws rather than silently drop a criterion the problem does not have', () => {
    expect(() => partProblem(valid(), { H: 5, weight: 1, criteria: [3] })).toThrow(
      /no criterion 3/,
    );
  });
});

describe('validateProblem', () => {
  describe('a hand size that names its own criteria', () => {
    function withCriteria(criteria: number[]): Problem {
      const problem = valid();
      return {
        ...problem,
        handSizes: [{ H: 5, weight: 1, criteria }],
        criteria: [problem.criteria[0]!, { slots: [0b100], limits: [] }],
      };
    }

    it('accepts indices into the problem’s criteria, and an empty list', () => {
      expect(() => validateProblem(withCriteria([0, 1]))).not.toThrow();
      expect(() => validateProblem(withCriteria([1]))).not.toThrow();
      expect(() => validateProblem(withCriteria([]))).not.toThrow();
    });

    it('refuses an index the problem has no criterion for', () => {
      expect(() => validateProblem(withCriteria([0, 2]))).toThrow(
        'hand size 5: `criteria` holds 2, which is not one of the problem’s 2 criteria'.replace(
          '’',
          "'",
        ),
      );
      expect(() => validateProblem(withCriteria([-1]))).toThrow(/holds -1/);
      expect(() => validateProblem(withCriteria([0.5]))).toThrow(/holds 0.5/);
    });

    it('refuses the same criterion twice: a hand is judged against a SET', () => {
      expect(() => validateProblem(withCriteria([1, 1]))).toThrow(
        'hand size 5: criterion 1 appears twice',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Draw cards (PRD §5.7)
// ---------------------------------------------------------------------------

/** A problem whose class 1 draws, with everything else as `valid()` has it. */
function drawing(draw: DrawSpec, over: Partial<Problem> = {}): Problem {
  const base = valid();
  return {
    ...base,
    classes: base.classes.map((info, cls) => (cls === 1 ? { ...info, draw } : info)),
    ...over,
  };
}

describe('drawClassesOf', () => {
  it('is empty for a problem without draw cards', () => {
    expect(drawClassesOf(valid().classes)).toEqual([]);
  });

  it('carries the class index and its `max`, which is what bounds the copies', () => {
    expect(drawClassesOf(drawing({ n: 2 }).classes)).toEqual([{ cls: 1, max: 3, n: 2 }]);
    expect(drawClassesOf(drawing({ n: 2, oncePerTurn: true }).classes)).toEqual([
      { cls: 1, max: 3, n: 2, oncePerTurn: true },
    ]);
  });
});

describe('copiesUsed', () => {
  it('is every copy of an ordinary draw card', () => {
    expect(copiesUsed(0, { n: 2 })).toBe(0);
    expect(copiesUsed(3, { n: 2 })).toBe(3);
  });

  it('is at most one of a once-per-turn card, however many are held', () => {
    expect(copiesUsed(0, { n: 2, oncePerTurn: true })).toBe(0);
    expect(copiesUsed(1, { n: 2, oncePerTurn: true })).toBe(1);
    expect(copiesUsed(3, { n: 2, oncePerTurn: true })).toBe(1);
  });
});

describe('drawsOf', () => {
  const draws = drawClassesOf(drawing({ n: 2 }).classes);

  it('is what the draw cards a prefix holds ask for', () => {
    expect(drawsOf([0, 0, 0], draws)).toBe(0);
    expect(drawsOf([3, 2, 0], draws)).toBe(4);
  });
});

/**
 * THE TWO SIZE BOUNDS, and they are different numbers: the PREFIX drives what a
 * score costs, the HAND drives what a criterion may ask. Reading one where the
 * other belongs is the mistake this pins.
 */
describe('longestPrefix and largestHand', () => {
  const of = (n: number, copies: number, oncePerTurn?: true) =>
    drawClassesOf([
      { lineIds: ['blank'], min: 0, max: 40 },
      {
        lineIds: ['draws'],
        min: 0,
        max: copies,
        draw: oncePerTurn === undefined ? { n } : { n, oncePerTurn },
      },
    ]);

  it.each([
    ['3x Pot of Greed (draws 2)', 2, 3, undefined, 11, 8],
    ['3x Upstart Goblin (draws 1)', 1, 3, undefined, 8, 5],
    ['3x a once-per-turn draw-2', 2, 3, true, 7, 6],
    ['3x a draw-3', 3, 3, undefined, 14, 11],
  ] as const)(
    '%s: the prefix and the hand are different numbers',
    (_label, n, copies, once, prefix, hand) => {
      const draws = of(n, copies, once);
      expect(longestPrefix(5, draws)).toBe(prefix);
      expect(largestHand(5, draws)).toBe(hand);
    },
  );

  it('is the hand size itself when nothing draws', () => {
    expect(longestPrefix(5, [])).toBe(5);
    expect(largestHand(5, [])).toBe(5);
  });

  it('adds up over several draw classes', () => {
    const draws = drawClassesOf([
      { lineIds: ['blank'], min: 0, max: 40 },
      { lineIds: ['pot'], min: 0, max: 3, draw: { n: 2 } },
      { lineIds: ['upstart'], min: 0, max: 3, draw: { n: 1 } },
    ]);
    expect(longestPrefix(5, draws)).toBe(14);
    expect(largestHand(5, draws)).toBe(8);
  });
});

/**
 * THE THIRD SIZE, and the one `then` is about: how many cards the drawn set can
 * hold. It is the smaller of the POSITIONS there are, `ℓ − (H − 1)`, and the
 * whole HAND — and neither bound dominates, which is the reason it is a
 * function and not one expression written twice.
 */
describe('largestDrawnSet', () => {
  const of = (...lines: { max: number; n: number; oncePerTurn?: true }[]) =>
    drawClassesOf([
      { lineIds: ['blank'], min: 0, max: 40 },
      ...lines.map(({ max, n, oncePerTurn }, at) => ({
        lineIds: [`draws${at}`],
        min: 0,
        max,
        draw: oncePerTurn === undefined ? { n } : { n, oncePerTurn },
      })),
    ]);

  it('is one card where nothing draws: the card you draw for turn', () => {
    expect(largestDrawnSet(6, [])).toBe(1);
    expect(largestDrawnSet(5, [])).toBe(1);
  });

  it('agrees with `MAX_SIXTH_SLOTS`, which is the parser’s default for exactly that case', () => {
    expect(largestDrawnSet(6, [])).toBe(MAX_SIXTH_SLOTS);
  });

  it('is the POSITIONS where the opening can hold every copy that resolves', () => {
    // Three Pots: prefix 12 from a hand of 6, so positions 5…11 are seven
    // cards and all three copies fit in the five opened on.
    const pots = of({ max: 3, n: 2 });
    expect(longestPrefix(6, pots)).toBe(12);
    expect(largestHand(6, pots)).toBe(9);
    expect(largestDrawnSet(6, pots)).toBe(7);
  });

  it('is the HAND where the opening cannot: a copy then resolves out of the drawn set itself', () => {
    // Six Upstarts: prefix 12, so seven positions — but only five of the six
    // copies can be dealt into the cards opened on, and the sixth resolves out
    // of the drawn set and leaves it.
    const upstarts = of({ max: 6, n: 1 });
    expect(longestPrefix(6, upstarts)).toBe(12);
    expect(largestHand(6, upstarts)).toBe(6);
    expect(largestDrawnSet(6, upstarts)).toBe(6);
  });

  it('counts a once-per-turn line’s further copies as cards and not as draws', () => {
    expect(largestDrawnSet(6, of({ max: 3, n: 2, oncePerTurn: true }))).toBe(3);
  });
});

describe('validateProblem', () => {
  describe('draw cards', () => {
    it('accepts a class that draws', () => {
      expect(() => validateProblem(drawing({ n: 2 }))).not.toThrow();
      expect(() => validateProblem(drawing({ n: 1, oncePerTurn: true }))).not.toThrow();
    });

    it('refuses a draw card that draws nothing', () => {
      expect(() => validateProblem(drawing({ n: 0 }))).toThrow(/positive whole number/);
      expect(() => validateProblem(drawing({ n: -1 }))).toThrow(/positive whole number/);
      expect(() => validateProblem(drawing({ n: 1.5 }))).toThrow(/positive whole number/);
    });

    it('refuses the BLANK class drawing: its cards are the ones nothing can see', () => {
      const problem = valid();
      problem.classes[0] = { ...problem.classes[0]!, draw: { n: 2 } };
      expect(() => validateProblem(problem)).toThrow(/blank class cannot draw/);
    });

    /**
     * DECK-OUT IS REFUSED, not modelled. The model would drop that mass rather
     * than mis-count it, and refusing is what buys the standing invariant that
     * the reachable prefixes carry probability exactly 1.
     */
    it('refuses draw cards that could ask for more cards than the deck holds', () => {
      const problem = drawing({ n: 2 });
      problem.deckSize = 8;
      problem.classes[0] = { lineIds: ['remainder'], min: 0, max: 8 };
      expect(() => validateProblem(problem)).toThrow(/the deck would run out/);
    });

    it('refuses a prefix past MAX_PREFIX, which is about build time and not exactness', () => {
      const deep = drawing({ n: 4 });
      deep.classes[1] = { ...deep.classes[1]!, max: 3 };
      // 5 + 4 × 3 = 17.
      expect(() => validateProblem(deep)).toThrow(
        new RegExp(`reach 17 cards deep.*at most ${MAX_PREFIX}`),
      );
    });

    it('refuses a hand past MAX_HAND, which is the matcher’s subset tables', () => {
      const wide = drawing({ n: 6 });
      wide.classes[1] = { ...wide.classes[1]!, max: 2 };
      // Prefix 5 + 12 = 17 would be refused first, so shrink the copies: one
      // copy of a draw-9 reaches a prefix of 14 and a hand of 13.
      const one = drawing({ n: 9 });
      one.classes[1] = { ...one.classes[1]!, max: 1 };
      expect(() => validateProblem(one)).toThrow(
        new RegExp(`build a hand of up to 13 cards.*at most ${MAX_HAND}`),
      );
      expect(() => validateProblem(wide)).toThrow(/cards deep/);
    });

    /**
     * `then` BESIDE DRAW CARDS (PRD §5.6, §5.7). It was once refused — the
     * reading it needed was "the card at position H − 1", and conditional on
     * the prefix that position is biased towards draw cards, since one has to
     * land among the first `H` to resolve at all. The reading now is the whole
     * DRAWN SET, which never asks which card was the sixth, so the bias is not
     * needed and the two go together.
     */
    it('judges the going-second split together with draw cards', () => {
      const split = drawing(
        { n: 2 },
        {
          handSizes: [{ H: 5, weight: 1, drawn: true }],
          criteria: [{ slots: [0b010], limits: [], sixth: { slots: [0b100], limits: [] } }],
        },
      );
      expect(() => validateProblem(split)).not.toThrow();
    });

    it('lets a hand draw its last card separately beside draw cards, split criterion or not', () => {
      const drawn = drawing({ n: 2 }, { handSizes: [{ H: 5, weight: 1, drawn: true }] });
      expect(() => validateProblem(drawn)).not.toThrow();
    });

    /**
     * WHAT `then` MAY ASK FOR is the template's own number: the card drawn for
     * turn plus everything the draw cards fetch. Three copies of a draw-2 from
     * a hand of five reach a prefix of 11, so the drawn set holds up to 7.
     */
    it('bounds the drawn part by what the draw cards can fetch, and says the figure', () => {
      const slots = (count: number) => new Array<number>(count).fill(0b100);
      const asking = (count: number) =>
        drawing(
          { n: 2 },
          {
            handSizes: [{ H: 5, weight: 1, drawn: true }],
            criteria: [{ slots: [], limits: [], sixth: { slots: slots(count), limits: [] } }],
          },
        );
      expect(largestDrawnSet(5, drawClassesOf(drawing({ n: 2 }).classes))).toBe(7);
      expect(() => validateProblem(asking(7))).not.toThrow();
      expect(() => validateProblem(asking(8))).toThrow(
        /criterion 0: the cards you draw are at most 7, and this part asks for 8/,
      );
    });

    /**
     * The exactness bound is over the PREFIX and not the hand: a score sums over
     * the ℓ-card prefixes, so `C(N, ℓ)` is what a numerator is bounded by, and
     * `C(N, ℓ)` is very much larger than `C(N, H)`.
     */
    it('bounds a criterion weight by C(N, prefix), not by C(N, hand)', () => {
      const heavy = drawing(
        { n: 2 },
        {
          criteria: [{ slots: [0b010], limits: [], weight: 10_000_000 }],
        },
      );
      expect(() => validateProblem(heavy)).toThrow(/at a prefix of 11/);
      // The same weight at the same hand, with the draw cards inert, is fine.
      const inert = valid();
      inert.criteria = [{ slots: [0b010], limits: [], weight: 1_000_000 }];
      expect(() => validateProblem(inert)).not.toThrow();
    });
  });
});
