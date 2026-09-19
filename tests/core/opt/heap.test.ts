import { describe, expect, it } from 'vitest';
import { compareRanked, TopK } from '../../../src/core/opt/heap';
import { seededRng } from '../../helpers/prng';

interface Entry {
  key: number;
  vector: number[];
}

/** The order by plain sorting: higher key first, then the lexicographically smaller vector. */
function ranked(entries: readonly Entry[]): Entry[] {
  const lex = (a: readonly number[], b: readonly number[]) => {
    for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return a[at]! - b[at]!;
    return 0;
  };
  return [...entries].sort((a, b) => b.key - a.key || lex(a.vector, b.vector));
}

/** Distinct vectors, few distinct keys: ties everywhere. */
function stream(seed: number, length: number): Entry[] {
  const rng = seededRng(seed);
  const seen = new Set<string>();
  const out: Entry[] = [];
  while (out.length < length) {
    const vector = [rng.int(0, 5), rng.int(0, 5), rng.int(0, 5)];
    if (seen.has(String(vector))) continue;
    seen.add(String(vector));
    out.push({ key: rng.int(0, 6), vector });
  }
  return out;
}

function filled(capacity: number, entries: readonly Entry[]): TopK {
  const heap = new TopK(capacity, 3);
  for (const { key, vector } of entries) heap.offer(key, vector);
  return heap;
}

describe('compareRanked', () => {
  it('ranks the higher key first, whatever the vectors', () => {
    expect(compareRanked(5, [9, 9], 4, [0, 0])).toBeLessThan(0);
    expect(compareRanked(4, [0, 0], 5, [9, 9])).toBeGreaterThan(0);
  });

  it('breaks a tie of keys by the lexicographically smaller vector, first entry first', () => {
    expect(compareRanked(5, [1, 9], 5, [2, 0])).toBeLessThan(0);
    expect(compareRanked(5, [1, 3], 5, [1, 2])).toBeGreaterThan(0);
    expect(compareRanked(5, [1, 2], 5, [1, 2])).toBe(0);
  });
});

describe('TopK', () => {
  describe('offer', () => {
    it('keeps everything while there is room, and says nothing fell out', () => {
      const heap = new TopK(3, 2);
      expect(heap.offer(5, [1, 2])).toBe(-1);
      expect(heap.offer(7, [0, 3])).toBe(-1);
      expect(heap.size).toBe(2);
    });

    it('when full, drops the worst — and returns the key that fell out', () => {
      const heap = new TopK(2, 2);
      heap.offer(5, [1, 2]);
      heap.offer(7, [0, 3]);
      // Better than the worst: the worst falls out.
      expect(heap.offer(6, [2, 1])).toBe(5);
      // Worse than all: the offered entry itself falls out.
      expect(heap.offer(1, [3, 0])).toBe(1);
      expect(heap.sorted()).toEqual([
        { key: 7, vector: [0, 3] },
        { key: 6, vector: [2, 1] },
      ]);
    });

    it('on a tie at the boundary keeps the lexicographically smaller vector, whichever came first', () => {
      const late = new TopK(1, 2);
      late.offer(5, [2, 0]);
      expect(late.offer(5, [1, 1])).toBe(5);
      expect(late.sorted()).toEqual([{ key: 5, vector: [1, 1] }]);

      const early = new TopK(1, 2);
      early.offer(5, [1, 1]);
      early.offer(5, [2, 0]);
      expect(early.sorted()).toEqual([{ key: 5, vector: [1, 1] }]);
    });

    it('copies the vector: the caller may keep writing into its own', () => {
      const heap = new TopK(2, 2);
      const live = new Int32Array([1, 2]);
      heap.offer(5, live);
      live[0] = 9;
      expect(heap.sorted()).toEqual([{ key: 5, vector: [1, 2] }]);
    });

    it('rejects a vector of the wrong width', () => {
      expect(() => new TopK(2, 2).offer(1, [1, 2, 3])).toThrow(RangeError);
    });
  });

  describe('dropBelow', () => {
    it('drops exactly the entries under the key, and reports how many', () => {
      const heap = filled(10, [
        { key: 3, vector: [0, 0, 1] },
        { key: 9, vector: [0, 0, 2] },
        { key: 5, vector: [0, 0, 3] },
        { key: 4, vector: [0, 0, 4] },
      ]);
      expect(heap.dropBelow(5)).toBe(2);
      expect(heap.sorted().map(({ key }) => key)).toEqual([9, 5]);
      expect(heap.dropBelow(5)).toBe(0);
      expect(heap.dropBelow(100)).toBe(2);
      expect(heap.size).toBe(0);
    });
  });

  describe('keptKeys', () => {
    it('lists the key of every kept entry, and of no other', () => {
      const heap = filled(3, [
        { key: 3, vector: [0, 0, 1] },
        { key: 9, vector: [0, 0, 2] },
        { key: 5, vector: [0, 0, 3] },
        { key: 5, vector: [0, 0, 4] },
      ]);
      expect(heap.keptKeys().sort()).toEqual([5, 5, 9]);
      heap.dropBelow(6);
      expect(heap.keptKeys()).toEqual([9]);
    });
  });

  describe('sorted', () => {
    it('lists best first without disturbing the heap', () => {
      const heap = filled(3, stream(1, 20));
      expect(heap.sorted()).toEqual(heap.sorted());
      heap.offer(100, [9, 9, 9]);
      expect(heap.sorted()[0]).toEqual({ key: 100, vector: [9, 9, 9] });
    });
  });

  it('rejects a capacity or width that is not a positive whole number', () => {
    expect(() => new TopK(0, 2)).toThrow(RangeError);
    expect(() => new TopK(2.5, 2)).toThrow(RangeError);
    expect(() => new TopK(2, 0)).toThrow(RangeError);
  });

  it('holds exactly the first K of the plain sort — ties included — in whatever order entries arrive', () => {
    for (let seed = 0; seed < 200; seed++) {
      const entries = stream(7_000 + seed, 60);
      const capacity = 1 + (seed % 25);
      expect(filled(capacity, entries).sorted()).toEqual(ranked(entries).slice(0, capacity));
    }
  });

  it('after any mix of offers and drops holds the first K of what survives', () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = seededRng(9_000 + seed);
      const capacity = rng.int(1, 40);
      const heap = new TopK(capacity, 3);
      let kept: Entry[] = [];
      for (const entry of stream(8_000 + seed, 80)) {
        heap.offer(entry.key, entry.vector);
        kept = ranked([...kept, entry]).slice(0, capacity);
        if (rng.chance(0.1)) {
          const floor = rng.int(0, 6);
          const before = kept.length;
          kept = kept.filter(({ key }) => key >= floor);
          expect(heap.dropBelow(floor)).toBe(before - kept.length);
        }
      }
      expect(heap.sorted()).toEqual(kept);
    }
  });
});
