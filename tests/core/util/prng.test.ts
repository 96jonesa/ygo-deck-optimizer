import { describe, expect, it } from 'vitest';
import { createPrng, mulberry32 } from '../../../src/core/util/prng';

describe('mulberry32', () => {
  // A drift pin, not an independent reference: every seeded test in the suite
  // — and every published Monte Carlo figure — silently changes if these do.
  it('pins the first outputs of two seeds', () => {
    const one = mulberry32(1);
    expect([one(), one(), one()].map((x) => x * 2 ** 32)).toEqual([
      2693262067, 11749833, 2265367787,
    ]);
    const zero = mulberry32(0);
    expect([zero(), zero()].map((x) => x * 2 ** 32)).toEqual([1144304738, 1416247]);
  });

  it('yields values in [0, 1)', () => {
    const next = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const x = next();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('repeats a stream from its seed, and uses only the low 32 bits of it', () => {
    const a = mulberry32(123);
    const b = mulberry32(123 + 2 ** 32);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('gives different seeds different streams', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(Array.from({ length: 8 }, a)).not.toEqual(Array.from({ length: 8 }, b));
  });
});

describe('createPrng', () => {
  describe('next', () => {
    it('is the mulberry32 stream of the seed', () => {
      const rng = createPrng(99);
      const reference = mulberry32(99);
      for (let i = 0; i < 50; i++) expect(rng.next()).toBe(reference());
    });
  });

  describe('nextInt', () => {
    it('returns integers in [0, n)', () => {
      const rng = createPrng(5);
      for (const n of [1, 2, 3, 40, 60, 1000]) {
        for (let i = 0; i < 2000; i++) {
          const value = rng.nextInt(n);
          expect(Number.isInteger(value) && value >= 0 && value < n).toBe(true);
        }
      }
    });

    it('always returns 0 for n = 1', () => {
      const rng = createPrng(5);
      for (let i = 0; i < 100; i++) expect(rng.nextInt(1)).toBe(0);
    });

    it('reaches every value about equally often', () => {
      const rng = createPrng(2026);
      const n = 40;
      const draws = 400_000;
      const seen = new Array<number>(n).fill(0);
      for (let i = 0; i < draws; i++) seen[rng.nextInt(n)]!++;
      // Each count is Binomial(draws, 1/n): mean 10,000, sd ~98.7. Five sd either way.
      const sd = Math.sqrt(draws * (1 / n) * (1 - 1 / n));
      for (const count of seen) expect(Math.abs(count - draws / n)).toBeLessThan(5 * sd);
    });

    it('accepts n = 2^32 and rejects what is not an integer in 1..2^32', () => {
      const rng = createPrng(1);
      expect(rng.nextInt(2 ** 32)).toBe(2693262067);
      for (const n of [0, -1, 1.5, 2 ** 32 + 1, Number.NaN])
        expect(() => rng.nextInt(n)).toThrow(RangeError);
    });

    it('draws again rather than fold the top of the range onto the low residues', () => {
      // n = 3 * 2^30 leaves 2^30 outputs above the largest multiple; seed 1's
      // first output, 2693262067, is below it and its residue is returned as is.
      const n = 3 * 2 ** 30;
      expect(createPrng(1).nextInt(n)).toBe(2693262067);
      // Every output at or above n must be skipped, never reduced: over many
      // draws the low third of [0, n) would otherwise come up twice as often.
      const rng = createPrng(3);
      let low = 0;
      const draws = 30_000;
      for (let i = 0; i < draws; i++) if (rng.nextInt(n) < 2 ** 30) low++;
      const sd = Math.sqrt(draws * (1 / 3) * (2 / 3));
      expect(Math.abs(low - draws / 3)).toBeLessThan(5 * sd);
    });
  });
});
