/**
 * Binomial coefficients as EXACT integers in float64 (TDD §10.3), by Pascal's
 * rule: additions only, so nothing is ever rounded. The default table covers
 * every deck and PREFIX the engine scores — C(60, 16) = 149,608,375,854,525,
 * still a long way below 2^53. Without draw cards a hand is six cards and only
 * the first seven columns are ever read.
 */
export interface BinomialTable {
  maxN: number;
  maxR: number;
  /** C(n, r) at `n * (maxR + 1) + r`; 0 wherever `r > n`. */
  values: Float64Array;
}

/**
 * `MAX_DECK_SIZE` and `MAX_PREFIX` of `src/core/model/problem.ts`, written out
 * rather than imported: that module reads `choose`, and a cycle between the two
 * would be worse than a pair of numbers a test holds equal.
 */
export function binomialTable(maxN = 60, maxR = 16): BinomialTable {
  if (!Number.isInteger(maxN) || !Number.isInteger(maxR) || maxN < 0 || maxR < 0)
    throw new RangeError(`a binomial table is sized by whole numbers, not ${maxN} and ${maxR}`);
  const stride = maxR + 1;
  const values = new Float64Array((maxN + 1) * stride);
  for (let n = 0; n <= maxN; n++) {
    values[n * stride] = 1;
    for (let r = 1; r <= maxR && r <= n; r++) {
      const value = values[(n - 1) * stride + r - 1]! + values[(n - 1) * stride + r]!;
      if (!Number.isSafeInteger(value))
        throw new RangeError(
          `C(${n}, ${r}) is past 2^53: a float64 cannot hold it as an exact integer`,
        );
      values[n * stride + r] = value;
    }
  }
  return { maxN, maxR, values };
}

const TABLE = binomialTable();

/**
 * C(n, r) for `0 <= n <= 60`: 0 when `r < 0` or `r > n` — there is no such
 * hand — and otherwise read from the table, through C(n, r) = C(n, n - r) when
 * `r` is above 6. Throws where the table does not reach rather than compute
 * something inexact.
 */
export function choose(n: number, r: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(r) || n < 0)
    throw new RangeError(`choose(${n}, ${r}): expected whole numbers, n >= 0`);
  if (r < 0 || r > n) return 0;
  const k = Math.min(r, n - r);
  if (n > TABLE.maxN || k > TABLE.maxR)
    throw new RangeError(
      `choose(${n}, ${r}) is outside the exact table (n <= ${TABLE.maxN}, r or n - r <= ${TABLE.maxR})`,
    );
  return TABLE.values[n * (TABLE.maxR + 1) + k]!;
}
