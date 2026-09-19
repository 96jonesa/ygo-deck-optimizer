import { describe, expect, it } from 'vitest';
import { achievableRange, countSums, type IntRange } from '../../../src/core/model/ranges';
import { same } from '../../helpers/assert';
import { seededRng } from '../../helpers/prng';

/** Every vector within `ranges`, by plain nested listing. */
function vectorsOf(ranges: readonly IntRange[]): number[][] {
  let out: number[][] = [[]];
  for (const { min, max } of ranges) {
    const next: number[][] = [];
    for (const vector of out) for (let n = min; n <= max; n++) next.push([...vector, n]);
    out = next;
  }
  return out;
}

const sum = (values: readonly number[]) => values.reduce((total, n) => total + n, 0);

function genRanges(seed: number): { ranges: IntRange[]; total: number } {
  const rng = seededRng(seed);
  const ranges = Array.from({ length: rng.int(0, 5) }, () => {
    const min = rng.int(0, 4);
    // An empty range now and then: nothing can be counted through it.
    return { min, max: rng.chance(0.08) ? min - 1 : min + rng.int(0, 4) };
  });
  return { ranges, total: rng.int(0, 18) };
}

describe('countSums', () => {
  it('counts one way to make nothing out of nothing', () => {
    expect(countSums([], 0)).toBe(1n);
    expect(countSums([], 3)).toBe(0n);
  });

  it('counts the vectors within the ranges that reach the total', () => {
    const ranges = [
      { min: 0, max: 3 },
      { min: 1, max: 2 },
    ];
    // (0,1) | (0,2) (1,1) | (1,2) (2,1) | (2,2) (3,1) | (3,2)
    expect([0, 1, 2, 3, 4, 5, 6].map((total) => countSums(ranges, total))).toEqual([
      0n,
      1n,
      2n,
      2n,
      2n,
      1n,
      0n,
    ]);
  });

  it('is exact at each bound of a range', () => {
    const ranges = [{ min: 2, max: 5 }];
    expect([1, 2, 3, 5, 6].map((total) => countSums(ranges, total))).toEqual([0n, 1n, 1n, 1n, 0n]);
  });

  it('counts nothing through an empty range, or towards a negative total', () => {
    expect(countSums([{ min: 3, max: 2 }], 2)).toBe(0n);
    expect(countSums([{ min: 0, max: 2 }], -1)).toBe(0n);
  });

  it('agrees with plain listing on 400 generated range lists', () => {
    for (let seed = 0; seed < 400; seed++) {
      const { ranges, total } = genRanges(71_000 + seed);
      const listed = vectorsOf(ranges).filter((vector) => sum(vector) === total).length;
      same(countSums(ranges, total), BigInt(listed), () => ({ ranges, total }));
    }
  });

  it('stays exact far past 2^53', () => {
    // 30 lines of 0..60 copies totalling 60: C(89, 29), by stars and bars.
    const ranges = Array.from({ length: 30 }, () => ({ min: 0, max: 60 }));
    let expected = 1n;
    for (let i = 1n; i <= 29n; i++) expected = (expected * (60n + i)) / i;
    expect(countSums(ranges, 60)).toBe(expected);
    expect(expected > 2n ** 53n).toBe(true);
  });

  it('rejects a total that is not a whole number', () => {
    expect(() => countSums([], 1.5)).toThrow(RangeError);
  });
});

describe('achievableRange', () => {
  it('is the plain sum of the chosen ranges when the others can absorb the rest', () => {
    const ranges = [
      { min: 0, max: 3 },
      { min: 5, max: 5 },
      { min: 0, max: 40 },
    ];
    expect(achievableRange(ranges, [true, true, false], 40)).toEqual({ min: 5, max: 8 });
  });

  it('derives the remainder of the motivating example: 13–33', () => {
    const lines = [
      [0, 3],
      [0, 3],
      [5, 5],
      [2, 3],
      [0, 3],
      [0, 7],
      [0, 3],
      [0, 40],
    ].map(([min, max]) => ({ min: min!, max: max! }));
    const remainderOnly = lines.map((_, i) => i === lines.length - 1);
    expect(achievableRange(lines, remainderOnly, 40)).toEqual({ min: 13, max: 33 });
  });

  it('is squeezed from both sides by what the other ranges must and can hold', () => {
    const ranges = [
      { min: 0, max: 10 },
      { min: 4, max: 6 },
    ];
    expect(achievableRange(ranges, [true, false], 10)).toEqual({ min: 4, max: 6 });
  });

  it('is null when the ranges cannot reach the total at all', () => {
    expect(achievableRange([{ min: 0, max: 3 }], [true], 4)).toBeNull();
    expect(achievableRange([{ min: 5, max: 9 }], [true], 4)).toBeNull();
    expect(achievableRange([{ min: 3, max: 2 }], [true], 2)).toBeNull();
  });

  it('agrees with plain listing on 400 generated range lists: exactly the sums taken, no gaps', () => {
    for (let seed = 0; seed < 400; seed++) {
      const { ranges, total } = genRanges(72_000 + seed);
      const rng = seededRng(73_000 + seed);
      const chosen = ranges.map(() => rng.chance(0.5));
      const sums = new Set(
        vectorsOf(ranges)
          .filter((vector) => sum(vector) === total)
          .map((vector) => sum(vector.filter((_, i) => chosen[i]))),
      );
      const range = achievableRange(ranges, chosen, total);
      if (sums.size === 0) {
        same(range, null, () => ({ ranges, total, chosen }));
        continue;
      }
      expect(range).toEqual({ min: Math.min(...sums), max: Math.max(...sums) });
      same(sums.size, range!.max - range!.min + 1, () => ({ ranges, total, chosen }));
    }
  });
});
