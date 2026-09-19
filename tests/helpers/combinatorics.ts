/**
 * Counting for the tests, by routes the engine does not take: `choose` is the
 * multiplicative formula, where `src/core/prob/binomial.ts` is Pascal's rule,
 * and `combinations` lists the hands that a binomial only counts.
 */

/** C(n, k) by the multiplicative formula; every intermediate value is itself a binomial, so exact. */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return Math.round(out);
}

/** Every `size`-subset of `items`, as lists in the order of `items`. */
export function combinations<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const extend = (hand: T[], from: number) => {
    if (hand.length === size) {
      out.push(hand);
      return;
    }
    for (let i = from; i < items.length; i++) extend([...hand, items[i]!], i + 1);
  };
  extend([], 0);
  return out;
}

/** Every way to write `total` as an ordered sum of `parts` whole numbers, in lexicographic order. */
export function compositions(parts: number, total: number): number[][] {
  if (parts === 0) return total === 0 ? [[]] : [];
  const out: number[][] = [];
  for (let first = 0; first <= total; first++)
    for (const rest of compositions(parts - 1, total - first)) out.push([first, ...rest]);
  return out;
}
