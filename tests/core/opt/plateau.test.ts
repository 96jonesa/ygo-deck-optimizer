import { describe, expect, it } from 'vitest';
import { Plateau } from '../../../src/core/opt/plateau';
import { seededRng } from '../../helpers/prng';

interface Entry {
  key: number;
  vector: number[];
}

const lex = (a: readonly number[], b: readonly number[]) => {
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return a[at]! - b[at]!;
  return 0;
};

/** What a plateau is, with the whole stream in hand: everything within `tolerance` of the best, best first. */
function naive(entries: readonly Entry[], tolerance: number, cap: number) {
  const best = Math.max(-1, ...entries.map(({ key }) => key));
  const within = entries
    .filter(({ key }) => best - key <= tolerance)
    .sort((a, b) => b.key - a.key || lex(a.vector, b.vector));
  return {
    best,
    size: within.length,
    truncated: within.length > cap,
    entries: within.slice(0, cap),
  };
}

function offered(plateau: Plateau, entries: readonly Entry[]): Plateau {
  for (const { key, vector } of entries) plateau.offer(key, vector);
  return plateau;
}

const entry = (key: number, id: number): Entry => ({ key, vector: [id, 0] });

describe('Plateau', () => {
  describe('offer', () => {
    it('keeps what is within the tolerance of the best so far — the boundary included', () => {
      const plateau = offered(new Plateau({ width: 2, cap: 10, tolerance: 2 }), [
        entry(10, 1),
        entry(8, 2),
        entry(7, 3),
      ]);
      expect(plateau.best).toBe(10);
      expect(plateau.result().entries).toEqual([entry(10, 1), entry(8, 2)]);
    });

    it('prunes what it kept when the best improves late', () => {
      const plateau = new Plateau({ width: 2, cap: 10, tolerance: 2 });
      offered(plateau, [entry(10, 1), entry(9, 2), entry(8, 3)]);
      expect(plateau.result().size).toBe(3);
      plateau.offer(11, [4, 0]);
      expect(plateau.result()).toEqual({
        entries: [entry(11, 4), entry(10, 1), entry(9, 2)],
        size: 3,
        sizeExact: true,
        truncated: false,
      });
      plateau.offer(50, [5, 0]);
      expect(plateau.result()).toEqual({
        entries: [entry(50, 5)],
        size: 1,
        sizeExact: true,
        truncated: false,
      });
    });

    it('with a tolerance of 0 keeps exactly the ties for best', () => {
      const plateau = offered(new Plateau({ width: 2, cap: 10, tolerance: 0 }), [
        entry(4, 1),
        entry(5, 2),
        entry(5, 3),
        entry(4, 4),
      ]);
      expect(plateau.result().entries).toEqual([entry(5, 2), entry(5, 3)]);
    });
  });

  describe('result', () => {
    it('is empty before anything is offered', () => {
      const plateau = new Plateau({ width: 2, cap: 10, tolerance: 2 });
      expect(plateau.best).toBe(-1);
      expect(plateau.result()).toEqual({ entries: [], size: 0, sizeExact: true, truncated: false });
    });

    it('when the cap bites keeps the best-scoring entries, says so, and still counts them all', () => {
      const entries = [3, 5, 4, 5, 3, 4, 5, 3].map((key, id) => entry(key, id));
      const plateau = offered(new Plateau({ width: 2, cap: 4, tolerance: 2 }), entries);
      expect(plateau.result()).toEqual({
        entries: [entry(5, 1), entry(5, 3), entry(5, 6), entry(4, 2)],
        size: 8,
        sizeExact: true,
        truncated: true,
      });
    });

    it('is not truncated when what fell to the cap has since left the plateau', () => {
      const plateau = new Plateau({ width: 2, cap: 2, tolerance: 1 });
      offered(plateau, [entry(5, 1), entry(5, 2), entry(5, 3)]);
      expect(plateau.result().truncated).toBe(true);
      offered(plateau, [entry(9, 4), entry(8, 5)]);
      expect(plateau.result()).toEqual({
        entries: [entry(9, 4), entry(8, 5)],
        size: 2,
        sizeExact: true,
        truncated: false,
      });
    });

    it('past the histogram limit a truncated size is a lower bound, and says so', () => {
      const entries = [3, 5, 4, 5, 3, 4, 5, 3].map((key, id) => entry(key, id));
      const plateau = offered(
        new Plateau({ width: 2, cap: 4, tolerance: 2, histogramLimit: 2 }),
        entries,
      );
      expect(plateau.result()).toEqual({
        entries: [entry(5, 1), entry(5, 3), entry(5, 6), entry(4, 2)],
        size: 4,
        sizeExact: false,
        truncated: true,
      });
      // Without truncation the entries ARE the plateau: exact with or without a histogram.
      const roomy = offered(
        new Plateau({ width: 2, cap: 40, tolerance: 2, histogramLimit: 2 }),
        entries,
      );
      expect(roomy.result()).toMatchObject({ size: 8, sizeExact: true, truncated: false });
    });
  });

  it('rejects a malformed shape', () => {
    expect(() => new Plateau({ width: 2, cap: 0, tolerance: 2 })).toThrow(RangeError);
    expect(() => new Plateau({ width: 2, cap: 5, tolerance: -1 })).toThrow(RangeError);
    expect(() => new Plateau({ width: 2, cap: 5, tolerance: 0.5 })).toThrow(RangeError);
  });

  it('agrees with the plateau of the whole stream, however late the best arrives and whether or not the cap bites', () => {
    let truncated = 0;
    let lateBest = 0;
    for (let seed = 0; seed < 300; seed++) {
      const rng = seededRng(61_000 + seed);
      const tolerance = rng.pick([0, 1, 3, 10, 40, 1000]);
      const cap = rng.pick([1, 2, 5, 30, 500]);
      // Keys drift upwards, so the best keeps improving and earlier entries keep falling out.
      const entries = Array.from({ length: rng.int(1, 120) }, (_, id) => ({
        key: rng.int(0, 30) + Math.floor(id / rng.pick([1, 4, 1000])),
        vector: [rng.int(0, 3), id],
      }));
      const expected = naive(entries, tolerance, cap);
      const plateau = offered(new Plateau({ width: 2, cap, tolerance }), entries);
      expect(plateau.best).toBe(expected.best);
      expect(plateau.result()).toEqual({
        entries: expected.entries,
        size: expected.size,
        sizeExact: true,
        truncated: expected.truncated,
      });
      if (expected.truncated) truncated++;
      if (entries.findIndex(({ key }) => key === expected.best) > entries.length / 2) lateBest++;
    }
    expect(truncated).toBeGreaterThanOrEqual(60);
    expect(lateBest).toBeGreaterThanOrEqual(100);
  });
});
