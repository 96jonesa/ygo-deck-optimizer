import { mulberry32 } from '../../src/core/util/prng';

// The generator itself lives in core, where the Monte Carlo oracle draws from it (TDD §10.4).
export { mulberry32 };

/**
 * A tiny seeded PRNG for property tests (TDD §15.1): the same seed always
 * yields the same cases, so a failure is reproducible from its seed alone.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Between `min` and `max` distinct members of `items`, in the order of `items`. */
  subset<T>(items: readonly T[], min: number, max?: number): T[];
}

export function seededRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: (items) => items[int(0, items.length - 1)]!,
    subset: (items, min, max = items.length) => {
      const size = int(min, Math.min(max, items.length));
      const chosen = new Set<number>();
      while (chosen.size < size) chosen.add(int(0, items.length - 1));
      return items.filter((_, i) => chosen.has(i));
    },
  };
}
