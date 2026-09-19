import { describe, expect, it } from 'vitest';
import { countToNumber, formatCount, toCount } from '../../../src/core/util/count';

describe('toCount', () => {
  it('is a number while the count is a safe integer', () => {
    expect(toCount(0n)).toBe(0);
    expect(toCount(4096n)).toBe(4096);
    expect(toCount(2n ** 53n - 1n)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('is the exact decimal digits, as a string, past 2^53', () => {
    expect(toCount(2n ** 53n)).toBe('9007199254740992');
    expect(toCount(2n ** 53n + 1n)).toBe('9007199254740993');
    expect(toCount(10n ** 30n + 7n)).toBe(`1${'0'.repeat(29)}7`);
  });

  it('survives JSON either way', () => {
    for (const big of [12n, 2n ** 80n])
      expect(JSON.parse(JSON.stringify(toCount(big)))).toEqual(toCount(big));
  });

  it('rejects a negative count', () => {
    expect(() => toCount(-1n)).toThrow(RangeError);
  });
});

describe('countToNumber', () => {
  it('is the count itself, or the nearest float past 2^53', () => {
    expect(countToNumber(4096)).toBe(4096);
    expect(countToNumber('9007199254740993')).toBe(2 ** 53);
    expect(countToNumber(toCount(10n ** 30n))).toBeCloseTo(1e30, -18);
  });
});

describe('formatCount', () => {
  it('groups the digits of a number', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(4096)).toBe('4,096');
    expect(formatCount(Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991');
  });

  it('cuts a count past 2^53 to three figures and a power of ten', () => {
    expect(formatCount('9007199254740993')).toBe('about 9.00 × 10^15');
    expect(formatCount('1234567890123456789')).toBe('about 1.23 × 10^18');
    expect(formatCount(toCount(10n ** 30n))).toBe('about 1.00 × 10^30');
    // Truncated, not rounded up into another power of ten.
    expect(formatCount('99999999999999999999')).toBe('about 9.99 × 10^19');
  });
});
