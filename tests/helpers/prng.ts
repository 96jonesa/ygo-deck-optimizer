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

/** mulberry32 (Tommy Ettinger, public domain): 32 bits of state, full period. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
