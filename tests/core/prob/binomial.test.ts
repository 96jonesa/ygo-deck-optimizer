import { describe, expect, it } from 'vitest';
import { MAX_DECK_SIZE, MAX_PREFIX } from '../../../src/core/model/problem';
import { binomialTable, choose } from '../../../src/core/prob/binomial';
// The multiplicative formula: a different route from the table's Pascal's rule.
import { choose as chooseByProduct } from '../../helpers/combinatorics';

describe('binomialTable', () => {
  const table = binomialTable();
  const at = (n: number, r: number) => table.values[n * (table.maxR + 1) + r]!;

  it('covers the largest deck and the longest prefix by default, one row of maxR + 1 entries per n', () => {
    expect(table.maxN).toBe(MAX_DECK_SIZE);
    // Written out in `binomial.ts` rather than imported, to keep `problem.ts`
    // and it from importing each other; this is the test that holds them equal.
    expect(table.maxR).toBe(MAX_PREFIX);
    expect(table.values).toBeInstanceOf(Float64Array);
    expect(table.values).toHaveLength((MAX_DECK_SIZE + 1) * (MAX_PREFIX + 1));
  });

  it('holds the longest prefix of the largest deck as an exact integer', () => {
    expect(at(60, 16)).toBe(149608375854525);
    expect(Number.isSafeInteger(at(60, 16))).toBe(true);
  });

  it('pins the two denominators the app divides by', () => {
    expect(at(40, 5)).toBe(658008);
    expect(at(60, 6)).toBe(50063860);
  });

  it('has 1 in column 0, n in column 1, and 0 wherever r > n', () => {
    for (let n = 0; n <= 60; n++) {
      expect(at(n, 0)).toBe(1);
      expect(at(n, 1)).toBe(n);
      for (let r = n + 1; r <= 6; r++) expect(at(n, r)).toBe(0);
    }
    expect(at(6, 6)).toBe(1);
    expect(at(5, 6)).toBe(0);
  });

  it("satisfies Pascal's rule at every interior entry", () => {
    for (let n = 1; n <= 60; n++)
      for (let r = 1; r <= 6; r++) expect(at(n, r)).toBe(at(n - 1, r - 1) + at(n - 1, r));
  });

  it('agrees with the multiplicative formula at every entry', () => {
    for (let n = 0; n <= 60; n++)
      for (let r = 0; r <= 6; r++) expect(at(n, r)).toBe(chooseByProduct(n, r));
  });

  it('holds only safe integers', () => {
    for (const value of table.values) expect(Number.isSafeInteger(value)).toBe(true);
  });

  it('builds other sizes, a whole triangle included', () => {
    const triangle = binomialTable(12, 12);
    expect(triangle.values).toHaveLength(13 * 13);
    for (let n = 0; n <= 12; n++)
      for (let r = 0; r <= 12; r++) expect(triangle.values[n * 13 + r]).toBe(chooseByProduct(n, r));
    expect(binomialTable(0, 0).values).toEqual(Float64Array.of(1));
  });

  it('refuses a table that a float64 cannot hold exactly, rather than round', () => {
    // C(60, 30) is about 1.18e17, past 2^53.
    expect(() => binomialTable(60, 30)).toThrow(/exact/);
    expect(() => binomialTable(-1, 3)).toThrow(RangeError);
    expect(() => binomialTable(10, 2.5)).toThrow(RangeError);
  });
});

describe('choose', () => {
  it('pins C(40,5), C(60,6) and a few by hand', () => {
    expect(choose(40, 5)).toBe(658008);
    expect(choose(60, 6)).toBe(50063860);
    expect(choose(37, 5)).toBe(435897);
    expect(choose(5, 2)).toBe(10);
    expect(choose(6, 3)).toBe(20);
    expect(choose(0, 0)).toBe(1);
  });

  it('is 0 when r > n or r < 0: there is no such hand', () => {
    expect(choose(3, 4)).toBe(0);
    expect(choose(0, 1)).toBe(0);
    expect(choose(5, 6)).toBe(0);
    expect(choose(2, 60)).toBe(0);
    expect(choose(5, -1)).toBe(0);
    expect(choose(0, -1)).toBe(0);
  });

  it('is 1 at both ends of every row', () => {
    for (let n = 0; n <= 60; n++) {
      expect(choose(n, 0)).toBe(1);
      expect(choose(n, n)).toBe(1);
    }
  });

  it("satisfies Pascal's identity", () => {
    for (let n = 1; n <= 60; n++)
      for (let r = 1; r <= 6; r++)
        expect(choose(n, r)).toBe(choose(n - 1, r - 1) + choose(n - 1, r));
  });

  it('is symmetric, which is how it reaches r above 6', () => {
    for (let n = 0; n <= 60; n++)
      for (let r = 0; r <= Math.min(n, 6); r++) expect(choose(n, n - r)).toBe(choose(n, r));
    expect(choose(60, 54)).toBe(50063860);
  });

  it('agrees with the multiplicative formula wherever it is defined', () => {
    for (let n = 0; n <= 60; n++)
      for (let r = -1; r <= n + 1; r++)
        if (r < 0 || r > n || Math.min(r, n - r) <= 6)
          expect(choose(n, r)).toBe(chooseByProduct(n, r));
  });

  it('returns safe integers', () => {
    for (let n = 0; n <= 60; n++)
      for (let r = 0; r <= 6; r++) expect(Number.isSafeInteger(choose(n, r))).toBe(true);
  });

  it('throws outside its table rather than answer inexactly', () => {
    expect(() => choose(61, 3)).toThrow(RangeError);
    expect(() => choose(60, 30)).toThrow(RangeError);
    expect(() => choose(40, 17)).toThrow(RangeError);
    expect(() => choose(-1, 0)).toThrow(RangeError);
    expect(() => choose(10.5, 2)).toThrow(RangeError);
    expect(() => choose(10, 2.5)).toThrow(RangeError);
  });
});
