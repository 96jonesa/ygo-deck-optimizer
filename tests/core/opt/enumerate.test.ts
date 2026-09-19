import { describe, expect, it } from 'vitest';
import { countVectors, walkVectors } from '../../../src/core/opt/enumerate';
import { same } from '../../helpers/assert';
import { bruteVectors, compareVectors, genClassRanges, type Range } from '../../helpers/opt-oracle';
import { seededRng } from '../../helpers/prng';

const CASES = 500;

function generated(): { classes: Range[]; deckSize: number }[] {
  return Array.from({ length: CASES }, (_, i) => genClassRanges(seededRng(52_000 + i)));
}

/** Every vector the walk visits, copied out of the live array. */
function visited(
  classes: readonly Range[],
  deckSize: number,
  shard?: { shard: number; of: number },
): number[][] {
  const out: number[][] = [];
  const finished = walkVectors(
    classes,
    deckSize,
    (totals) => {
      out.push(Array.from(totals));
      return true;
    },
    shard === undefined ? {} : { shard },
  );
  expect(finished).toBe(true);
  return out;
}

describe('walkVectors', () => {
  it('visits the vectors of a hand-checked space, blank absorbing the difference', () => {
    // Deck of 5: blank 1–3, then 0–2 and 1–4.
    expect(
      visited(
        [
          { min: 1, max: 3 },
          { min: 0, max: 2 },
          { min: 1, max: 4 },
        ],
        5,
      ),
    ).toEqual([
      [3, 0, 2],
      [2, 0, 3],
      [1, 0, 4],
      [3, 1, 1],
      [2, 1, 2],
      [1, 1, 3],
      [2, 2, 1],
      [1, 2, 2],
    ]);
  });

  it('walks in lexicographic order of the non-blank totals', () => {
    for (const { classes, deckSize } of generated()) {
      const vectors = visited(classes, deckSize);
      for (let at = 1; at < vectors.length; at++)
        if (compareVectors(vectors[at - 1]!.slice(1), vectors[at]!.slice(1)) >= 0)
          throw new Error(`out of order at ${at}: ${JSON.stringify({ classes, deckSize })}`);
    }
  });

  it('hands every visit the SAME array: it is live, and a visitor that keeps it must copy it', () => {
    const seen = new Set<Int32Array>();
    walkVectors(
      [
        { min: 0, max: 9 },
        { min: 0, max: 3 },
        { min: 0, max: 3 },
      ],
      6,
      (totals) => {
        seen.add(totals);
        return true;
      },
    );
    expect(seen.size).toBe(1);
  });

  it('stops as soon as a visit returns false, and says so', () => {
    const classes = [
      { min: 0, max: 9 },
      { min: 0, max: 3 },
      { min: 0, max: 3 },
    ];
    const all = visited(classes, 6);
    expect(all.length).toBeGreaterThan(5);
    const out: number[][] = [];
    const finished = walkVectors(classes, 6, (totals) => {
      out.push(Array.from(totals));
      return out.length < 5;
    });
    expect(finished).toBe(false);
    expect(out).toEqual(all.slice(0, 5));
  });

  it('a lone blank class is one vector when the deck is inside its range, and none otherwise', () => {
    expect(visited([{ min: 0, max: 40 }], 40)).toEqual([[40]]);
    expect(visited([{ min: 0, max: 39 }], 40)).toEqual([]);
    expect(visited([{ min: 41, max: 60 }], 40)).toEqual([]);
  });

  it('an empty blank class makes the other classes fill the deck by themselves', () => {
    expect(
      visited(
        [
          { min: 0, max: 0 },
          { min: 0, max: 3 },
          { min: 0, max: 40 },
        ],
        4,
      ),
    ).toEqual([
      [0, 0, 4],
      [0, 1, 3],
      [0, 2, 2],
      [0, 3, 1],
    ]);
  });

  it('rejects a malformed space or shard', () => {
    const visit = () => true;
    expect(() => walkVectors([], 5, visit)).toThrow(RangeError);
    expect(() => walkVectors([{ min: 0, max: 5 }], 2.5, visit)).toThrow(RangeError);
    expect(() => walkVectors([{ min: 0, max: 5 }], -1, visit)).toThrow(RangeError);
    expect(() => walkVectors([{ min: 0.5, max: 5 }], 5, visit)).toThrow(RangeError);
    for (const shard of [
      { shard: 2, of: 2 },
      { shard: -1, of: 2 },
      { shard: 0, of: 0 },
      { shard: 0.5, of: 2 },
    ])
      expect(() => walkVectors([{ min: 0, max: 5 }], 5, visit, { shard })).toThrow(RangeError);
  });
});

describe('countVectors', () => {
  it('counts the motivating example: 128 (TDD §11.1)', () => {
    const classes = [
      { min: 0, max: 50 },
      { min: 0, max: 3 },
      { min: 0, max: 3 },
      { min: 5, max: 8 },
      { min: 2, max: 3 },
    ];
    expect(countVectors(classes, 40)).toBe(128);
  });

  it('counts past 2^53 exactly, as digits', () => {
    // 30 classes of 0–3 and an open blank: 4^29 vectors.
    const classes = [{ min: 0, max: 200 }, ...new Array(29).fill({ min: 0, max: 3 })];
    expect(countVectors(classes, 120)).toBe((4n ** 29n).toString());
  });

  it('counts a shard as the walk visits it', () => {
    const classes = [
      { min: 0, max: 9 },
      { min: 1, max: 4 },
      { min: 0, max: 3 },
    ];
    expect(countVectors(classes, 6, { shard: { shard: 1, of: 2 } })).toBe(8);
  });
});

describe('the walk against plain nested listing (oracle O2)', () => {
  it('visits exactly the brute-force vectors — none missing, none twice — and counts them', () => {
    let vectors = 0;
    let infeasible = 0;
    let emptyBlank = 0;
    let aboveDeck = 0;
    for (const { classes, deckSize } of generated()) {
      const expected = bruteVectors(classes, deckSize);
      const actual = visited(classes, deckSize);
      const context = () => ({ classes, deckSize });
      same(new Set(actual.map(String)).size, actual.length, context);
      expect(actual.map(String).sort()).toEqual(expected.map(String).sort());
      same(countVectors(classes, deckSize), expected.length, context);
      vectors += expected.length;
      if (expected.length === 0) infeasible++;
      if (classes[0]!.max === 0) emptyBlank++;
      if (classes.some(({ max }) => max > deckSize)) aboveDeck++;
    }
    console.info(`O2: ${CASES} range lists, ${vectors} vectors, ${infeasible} infeasible`);
    expect(vectors).toBeGreaterThanOrEqual(5_000);
    expect(infeasible).toBeGreaterThanOrEqual(30);
    expect(emptyBlank).toBeGreaterThanOrEqual(60);
    expect(aboveDeck).toBeGreaterThanOrEqual(150);
  });

  it('shards partition the space, in walk order within each, whatever the shard count', () => {
    for (const [at, { classes, deckSize }] of generated().entries()) {
      const whole = visited(classes, deckSize);
      const of = 1 + (at % 5);
      const shards = Array.from({ length: of }, (_, shard) =>
        visited(classes, deckSize, { shard, of }),
      );
      const context = () => ({ classes, deckSize, of });
      same(
        shards.reduce((sum, shard) => sum + shard.length, 0),
        whole.length,
        context,
      );
      expect(shards.flat().map(String).sort()).toEqual(whole.map(String).sort());
      shards.forEach((shard, index) => {
        // A shard is a subsequence of the whole walk …
        const mine = new Set(shard.map(String));
        expect(shard).toEqual(whole.filter((totals) => mine.has(String(totals))));
        // … decided by the first non-blank class alone …
        for (const totals of shard) if (totals.length > 1) same(totals[1]! % of, index, context);
        // … and counted up front like the whole.
        same(
          countVectors(classes, deckSize, { shard: { shard: index, of } }),
          shard.length,
          context,
        );
      });
    }
  });
});
