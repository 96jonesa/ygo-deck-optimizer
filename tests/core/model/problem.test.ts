import { describe, expect, it } from 'vitest';
import { MAX_RANGES } from '../../../src/core/criteria/ast';
import {
  MAX_CLASSES,
  MAX_DECK_SIZE,
  MAX_HAND_SIZE,
  type Problem,
  partProblem,
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

describe('validateProblem', () => {
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
