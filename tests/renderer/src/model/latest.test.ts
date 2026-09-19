import { describe, expect, it } from 'vitest';
import { LatestOnly } from '../../../../src/renderer/src/model/latest';

describe('LatestOnly', () => {
  it('drops the answer to a request that a newer one has overtaken', () => {
    const latest = new LatestOnly();
    const first = latest.next();
    const second = latest.next();
    expect(latest.isCurrent(first)).toBe(false);
    expect(latest.isCurrent(second)).toBe(true);
  });

  it('keeps accepting the newest answer however late it arrives', () => {
    const latest = new LatestOnly();
    latest.next();
    const newest = latest.next();
    expect(latest.isCurrent(newest)).toBe(true);
    expect(latest.isCurrent(newest)).toBe(true);
  });

  describe('next', () => {
    it('numbers requests 1, 2, 3 — never -1, the number main gives a request without one', () => {
      const latest = new LatestOnly();
      expect([latest.next(), latest.next(), latest.next()]).toEqual([1, 2, 3]);
    });
  });

  describe('isCurrent', () => {
    it('accepts nothing before the first request', () => {
      const latest = new LatestOnly();
      expect(latest.isCurrent(0)).toBe(false);
      expect(latest.isCurrent(-1)).toBe(false);
    });

    it('keeps two sequences apart', () => {
      const parses = new LatestOnly();
      const analyses = new LatestOnly();
      const parse = parses.next();
      analyses.next();
      analyses.next();
      expect(parses.isCurrent(parse)).toBe(true);
    });
  });
});
