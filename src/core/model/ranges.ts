/**
 * Counting over copy ranges in closed form (TDD §9, §11.3): how many ways
 * whole numbers within given ranges reach a total, and what a subset of them
 * can add up to. `analyze` counts raw ratios and class vectors with these and
 * never lists either, so it stays instant when the count is past 2^53.
 */

/** Inclusive, in whole cards; `min > max` is an empty range. */
export interface IntRange {
  min: number;
  max: number;
}

/**
 * How many vectors `x` with every `x[i]` in `ranges[i]` have `Σ x[i] = total`.
 * A DP over the ranges with a running prefix sum — O(ranges × total) additions
 * — in BigInt, because thirty lines of 0–3 copies are already 4^30 ratios.
 */
export function countSums(ranges: readonly IntRange[], total: number): bigint {
  if (!Number.isInteger(total))
    throw new RangeError(`a total is a whole number of cards, not ${total}`);
  if (total < 0) return 0n;
  /** `ways[s]`: the vectors over the ranges so far that sum to `s`. */
  let ways = new Array<bigint>(total + 1).fill(0n);
  ways[0] = 1n;
  for (const { min, max } of ranges) {
    const next = new Array<bigint>(total + 1).fill(0n);
    // next[s] = Σ ways[s - n] for n in min..max: a window over `ways`, slid along `s`.
    let window = 0n;
    for (let s = 0; s <= total; s++) {
      if (s - min >= 0) window += ways[s - min]!;
      if (s - max - 1 >= 0) window -= ways[s - max - 1]!;
      if (max >= min) next[s] = window;
    }
    ways = next;
  }
  return ways[total]!;
}

/**
 * What the ranges picked out by `chosen` can add up to, given that ALL the
 * ranges together must reach `total`: the chosen ones hold at least their
 * minimums and at least what the others cannot, at most their maximums and at
 * most what the others leave. Sums of integer intervals are integer intervals,
 * so every value in between is reached too. `null` when the ranges cannot
 * reach `total` at all.
 */
export function achievableRange(
  ranges: readonly IntRange[],
  chosen: readonly boolean[],
  total: number,
): IntRange | null {
  let [inMin, inMax, outMin, outMax] = [0, 0, 0, 0];
  for (const [i, { min, max }] of ranges.entries()) {
    if (min > max) return null;
    if (chosen[i]) {
      inMin += min;
      inMax += max;
    } else {
      outMin += min;
      outMax += max;
    }
  }
  if (inMin + outMin > total || inMax + outMax < total) return null;
  return { min: Math.max(inMin, total - outMax), max: Math.min(inMax, total - outMin) };
}
