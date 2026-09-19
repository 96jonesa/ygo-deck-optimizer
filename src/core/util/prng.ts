/**
 * A small seeded PRNG (TDD §10.4): the same seed always yields the same
 * stream, so a Monte Carlo estimate — and a failing property test — is
 * reproducible from its seed alone.
 */
export interface Prng {
  /** Uniform in [0, 1), in steps of 2^-32. */
  next(): number;
  /** Uniform integer in [0, n), for an integer `1 <= n <= 2^32`. Exactly uniform: no modulo bias. */
  nextInt(n: number): number;
}

const TWO_32 = 4294967296;

/** mulberry32 (Tommy Ettinger, public domain): 32 bits of state, full period. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_32;
  };
}

/** A `Prng` over `mulberry32(seed)`; only the low 32 bits of `seed` are used. */
export function createPrng(seed: number): Prng {
  const next = mulberry32(seed);
  return {
    next,
    nextInt: (n) => {
      if (!Number.isInteger(n) || n < 1 || n > TWO_32)
        throw new RangeError(`nextInt: expected an integer in 1..2^32, got ${n}`);
      // Rejection sampling: outputs at or above the largest multiple of `n`
      // would make the low residues more likely, so they are drawn again.
      const limit = TWO_32 - (TWO_32 % n);
      let value = next() * TWO_32;
      while (value >= limit) value = next() * TWO_32;
      return value % n;
    },
  };
}
