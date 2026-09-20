import { describe, expect, it } from 'vitest';
import type { CompiledCriterion, Problem } from '../../../src/core/model/problem';
import { countCompositions, type SuccessSet, successSet } from '../../../src/core/prob/success-set';
import { choose, compositions } from '../../helpers/combinatorics';
import { genClassProblem } from '../../helpers/gen-class-problem';
import { bruteForceMeets, bruteForceSucceeds } from '../../helpers/matcher-oracle';
import { seededRng } from '../../helpers/prng';

function problemOf(classCount: number, criteria: CompiledCriterion[]): Problem {
  return {
    deckSize: 40,
    handSizes: [{ H: 5, weight: 1 }],
    classes: Array.from({ length: classCount }, (_, cls) => ({
      lineIds: [`class${cls}`],
      min: 0,
      max: 40,
    })),
    criteria,
  };
}

/** The stored compositions in full — blank count first — in stored order. */
function rowsOf(set: SuccessSet): number[][] {
  expect(set.compositions).toHaveLength(set.count * set.width);
  return Array.from({ length: set.count }, (_, row) => {
    const rest = [...set.compositions.subarray(row * set.width, (row + 1) * set.width)];
    return [set.H - rest.reduce((sum, held) => sum + held, 0), ...rest];
  });
}

const A = 0b010;
const B = 0b100;

describe('countCompositions', () => {
  it('pins the two sizes TDD §10.2 quotes, and the largest a problem can have', () => {
    expect(countCompositions(10, 5)).toBe(2002);
    expect(countCompositions(20, 5)).toBe(42504);
    expect(countCompositions(30, 6)).toBe(1623160);
  });

  it('is C(H + k - 1, H)', () => {
    for (let k = 1; k <= 30; k++)
      for (let H = 0; H <= 6; H++) expect(countCompositions(k, H)).toBe(choose(H + k - 1, H));
  });

  it('counts what listing them finds', () => {
    for (let k = 1; k <= 6; k++)
      for (let H = 0; H <= 6; H++) expect(countCompositions(k, H)).toBe(compositions(k, H).length);
  });

  it('is 1 for the blank class alone, and for the empty hand', () => {
    expect(countCompositions(1, 5)).toBe(1);
    expect(countCompositions(7, 0)).toBe(1);
  });

  it('rejects no classes at all, and counts that are not whole', () => {
    expect(() => countCompositions(0, 5)).toThrow(RangeError);
    expect(() => countCompositions(2.5, 5)).toThrow(RangeError);
    expect(() => countCompositions(3, -1)).toThrow(RangeError);
  });
});

describe('successSet', () => {
  it('keeps the successful compositions of the NON-blank classes, the blank count implied', () => {
    // Blank, A, B; success is an A and a B. Hands of three.
    const set = successSet(problemOf(3, [{ slots: [A, B], limits: [] }]), 3);
    expect(set).toMatchObject({ H: 3, classCount: 3, width: 2, total: 10, successes: 3 });
    expect(set.complemented).toBe(false);
    expect(set.compositions).toBeInstanceOf(Uint8Array);
    expect([...set.compositions]).toEqual([1, 1, 1, 2, 2, 1]);
    expect(rowsOf(set)).toEqual([
      [1, 1, 1],
      [0, 1, 2],
      [0, 2, 1],
    ]);
  });

  it('includes the compositions with no blank card at all, and the one that is all blank', () => {
    const everything = successSet(problemOf(2, [{ slots: [], limits: [] }]), 2, {
      storage: 'successes',
    });
    expect(rowsOf(everything)).toEqual([
      [2, 0],
      [1, 1],
      [0, 2],
    ]);
  });

  it('stores the COMPLEMENT when the successful set is the larger one', () => {
    // Blank and A; success is at least one A: of a = 0, 1, 2, only a = 0 fails.
    const problem = problemOf(2, [{ slots: [A], limits: [] }]);
    const set = successSet(problem, 2);
    expect(set).toMatchObject({ total: 3, successes: 2, complemented: true, count: 1 });
    expect(rowsOf(set)).toEqual([[2, 0]]);
  });

  it('stores the successes on a tie: only a LARGER successful set is complemented', () => {
    // a = 0..3; at least two As succeeds for a = 2, 3: two of four.
    const set = successSet(problemOf(2, [{ slots: [A, A], limits: [] }]), 3);
    expect(set).toMatchObject({ total: 4, successes: 2, complemented: false, count: 2 });
    expect(rowsOf(set)).toEqual([
      [1, 2],
      [0, 3],
    ]);
  });

  it('stores whichever side it is told to', () => {
    const problem = problemOf(2, [{ slots: [A], limits: [] }]);
    const successes = successSet(problem, 2, { storage: 'successes' });
    expect(successes).toMatchObject({ successes: 2, complemented: false, count: 2 });
    expect(rowsOf(successes)).toEqual([
      [1, 1],
      [0, 2],
    ]);
    const complement = successSet(problem, 2, { storage: 'complement' });
    expect(complement).toMatchObject({ successes: 2, complemented: true, count: 1 });
    // And the smaller side, forced to be the complement of a set that was not the larger.
    const few = successSet(problemOf(2, [{ slots: [A, A], limits: [] }]), 2, {
      storage: 'complement',
    });
    expect(few).toMatchObject({ successes: 1, complemented: true, count: 2 });
    expect(rowsOf(few)).toEqual([
      [2, 0],
      [1, 1],
    ]);
  });

  it('stores nothing when no hand succeeds, and nothing — complemented — when every hand does', () => {
    const never = successSet(problemOf(3, []), 5);
    expect(never).toMatchObject({ successes: 0, complemented: false, count: 0, total: 21 });
    const always = successSet(problemOf(3, [{ slots: [], limits: [] }]), 5);
    expect(always).toMatchObject({ successes: 21, complemented: true, count: 0, total: 21 });
  });

  it('handles the blank class alone: one composition, of width zero', () => {
    const always = successSet(problemOf(1, [{ slots: [], limits: [] }]), 5, {
      storage: 'successes',
    });
    expect(always).toMatchObject({ width: 0, total: 1, successes: 1, count: 1 });
    expect(always.compositions).toHaveLength(0);
    expect(successSet(problemOf(1, []), 5)).toMatchObject({ total: 1, successes: 0, count: 0 });
  });

  it('applies limits, and a criterion that needs more slots than H never succeeds', () => {
    const limited = successSet(problemOf(2, [{ slots: [A], limits: [{ mask: A, n: 1 }] }]), 3, {
      storage: 'successes',
    });
    expect(rowsOf(limited)).toEqual([[2, 1]]);
    const sixSlots = problemOf(2, [{ slots: [A, A, A, A, A, A], limits: [] }]);
    expect(successSet(sixSlots, 5).successes).toBe(0);
    expect(successSet(sixSlots, 6).successes).toBe(1);
  });

  it('restricts itself to one criterion when asked to', () => {
    const problem = problemOf(3, [
      { slots: [A], limits: [] },
      { slots: [B, B], limits: [] },
    ]);
    const first = successSet(problem, 2, { criterion: 0, storage: 'successes' });
    const second = successSet(problem, 2, { criterion: 1, storage: 'successes' });
    expect(rowsOf(first)).toEqual([
      [1, 1, 0],
      [0, 1, 1],
      [0, 2, 0],
    ]);
    expect(rowsOf(second)).toEqual([[0, 0, 2]]);
    expect(successSet(problem, 2).successes).toBe(4);
    expect(() => successSet(problem, 2, { criterion: 2 })).toThrow(/no criterion 2/);
  });

  it('enumerates every composition once, in lexicographic order, whichever side it stores', () => {
    let checked = 0;
    for (let seed = 0; seed < 120; seed++) {
      const { problem, H } = genClassProblem(seededRng(61_000 + seed), {
        classes: [1, 6],
        deckSize: [40, 40],
        handSize: [1, 6],
        slots: [0, 4],
        criteria: [0, 3],
      });
      const k = problem.classes.length;
      const all = compositions(k - 1, H)
        .concat(...Array.from({ length: H }, (_, total) => compositions(k - 1, total)))
        .map((rest) => [H - rest.reduce((sum, held) => sum + held, 0), ...rest])
        .sort((x, y) => {
          for (let cls = 1; cls < k; cls++) if (x[cls] !== y[cls]) return x[cls]! - y[cls]!;
          return 0;
        });
      expect(all).toHaveLength(countCompositions(k, H));
      const winning = all.filter((h) => bruteForceSucceeds(problem, h));
      const losing = all.filter((h) => !bruteForceSucceeds(problem, h));

      const kept = successSet(problem, H, { storage: 'successes' });
      expect(rowsOf(kept)).toEqual(winning);
      expect(kept).toMatchObject({
        total: all.length,
        successes: winning.length,
        complemented: false,
      });
      const complement = successSet(problem, H, { storage: 'complement' });
      expect(rowsOf(complement)).toEqual(losing);
      expect(complement).toMatchObject({
        total: all.length,
        successes: winning.length,
        complemented: true,
      });
      const auto = successSet(problem, H);
      expect(auto.complemented).toBe(winning.length > losing.length);
      expect(auto.count).toBe(Math.min(winning.length, losing.length));
      expect(successSet(problem, H, { storage: 'auto' })).toEqual(auto);

      problem.criteria.forEach((criterion, at) => {
        const one = successSet(problem, H, { criterion: at, storage: 'successes' });
        expect(rowsOf(one)).toEqual(
          all.filter((h) => criterion.slots.length <= H && bruteForceMeets(criterion, h)),
        );
      });
      checked += all.length;
    }
    // Pinned so the size of the check is on record; it moves only if the generator does.
    expect(checked).toBe(5717);
  });

  it('has 2,002 compositions for ten classes and hands of five', () => {
    const set = successSet(problemOf(10, [{ slots: [A], limits: [] }]), 5);
    expect(set.total).toBe(2002);
    // Without an A: compositions of nine classes.
    expect(set.successes).toBe(2002 - 1287);
  });

  it('rejects a hand size outside 1 to 6, or above the deck', () => {
    const problem = problemOf(2, [{ slots: [A], limits: [] }]);
    for (const H of [0, 7, 2.5, -1]) expect(() => successSet(problem, H)).toThrow(/hand size/);
    expect(() => successSet({ ...problem, deckSize: 4 }, 5)).toThrow(/hand size/);
  });

  it('validates the problem', () => {
    expect(() => successSet(problemOf(2, [{ slots: [A | 1], limits: [] }]), 5)).toThrow(
      /blank class/,
    );
  });
});

/**
 * Weighted criteria (PRD §5.6). The set is the same enumeration over the same
 * compositions; what changes is that a stored row carries what the composition
 * is WORTH. The complement generalizes through
 * `Σ w · ways = W · C(N,H) − Σ (W − w) · ways`, so the two storages are two
 * encodings of one number, exactly as they were for a probability.
 */
describe('successSet with weighted criteria', () => {
  /** `1x A` worth 5, `1x B` worth 2; a hand holding both is worth 5. */
  const WEIGHTED = problemOf(3, [
    { slots: [A], limits: [], weight: 5 },
    { slots: [B], limits: [], weight: 2 },
  ]);

  it('stores what each composition is WORTH, the highest weight of the criteria it meets', () => {
    const set = successSet(WEIGHTED, 2, { storage: 'successes' });
    expect(set.maxWeight).toBe(5);
    const worth = new Map(rowsOf(set).map((row, at) => [row.join(''), set.values[at]!]));
    // [blank, A, B]: any A is 5, a B without an A is 2, blanks alone are worth nothing.
    expect(worth.get('200')).toBeUndefined();
    expect(worth.get('110')).toBe(5);
    expect(worth.get('101')).toBe(2);
    expect(worth.get('011')).toBe(5);
    expect(worth.get('020')).toBe(5);
    expect(worth.get('002')).toBe(2);
    expect(set.successes).toBe(5);
    expect(set.count).toBe(5);
  });

  it('stores `maxWeight - worth` on the other side, leaving out the rows already worth the most', () => {
    const set = successSet(WEIGHTED, 2, { storage: 'complement' });
    expect(set.complemented).toBe(true);
    const value = new Map(rowsOf(set).map((row, at) => [row.join(''), set.values[at]!]));
    // The rows worth 5 are gone; a failure is worth 5 − 0, a B-only hand 5 − 2.
    expect(value.get('110')).toBeUndefined();
    expect(value.get('020')).toBeUndefined();
    expect(value.get('200')).toBe(5);
    expect(value.get('101')).toBe(3);
    expect(value.get('002')).toBe(3);
    expect(set.count).toBe(3);
    // `successes` still counts the compositions worth anything, whichever side is stored.
    expect(set.successes).toBe(5);
  });

  it('carries a 1 on every stored row when nothing is weighted, either side', () => {
    const plain = problemOf(3, [{ slots: [A], limits: [] }]);
    for (const storage of ['successes', 'complement'] as const) {
      const set = successSet(plain, 2, { storage });
      expect(set.maxWeight).toBe(1);
      expect([...set.values]).toEqual(new Array<number>(set.count).fill(1));
    }
  });

  it('takes the maxWeight of the WHOLE problem, not of the criteria this set judges', () => {
    // Judged by the light criterion alone, the heavy one still sets the bound:
    // the two sides of a store, and the parts of a blend, must agree on one W.
    const one = successSet(WEIGHTED, 2, { criterion: 1, storage: 'successes' });
    expect(one.maxWeight).toBe(5);
    expect([...one.values]).toEqual(new Array<number>(one.count).fill(2));
  });

  it('picks the smaller side by counting STORED ROWS, which weights and successes part company over', () => {
    // `1x B` worth 1, `2x A` worth 5. Of the six compositions of two cards over
    // three classes, four succeed and five are worth less than 5 — so the side
    // to keep is the successes, though most hands succeed. Counting successes
    // against failures, as an unweighted set may, would keep the larger side.
    const criteria: CompiledCriterion[] = [
      { slots: [B], limits: [], weight: 1 },
      { slots: [A, A], limits: [], weight: 5 },
    ];
    const auto = successSet(problemOf(3, criteria), 2);
    expect({ total: auto.total, successes: auto.successes }).toEqual({ total: 6, successes: 4 });
    expect(auto.complemented).toBe(false);
    expect(auto.count).toBe(4);
    // The same criteria unweighted: four of six succeed, so the failures are kept.
    const unweighted = successSet(
      problemOf(
        3,
        criteria.map(({ slots, limits }) => ({ slots, limits })),
      ),
      2,
    );
    expect(unweighted.complemented).toBe(true);
    expect(unweighted.count).toBe(2);
  });
});
