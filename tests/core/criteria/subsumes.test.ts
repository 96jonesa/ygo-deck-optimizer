import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../../src/core/cards/index';
import type { Counted, FlatCriterion } from '../../../src/core/criteria/ast';
import { findSubsumed, subsumes } from '../../../src/core/criteria/subsumes';
import type { Description } from '../../../src/core/desc/ast';
import type { Groups } from '../../../src/core/desc/evaluate';
import { type ImpliesContext, implies } from '../../../src/core/desc/implies';
import { parse } from '../../../src/core/desc/parser';
import { same } from '../../helpers/assert';
import { type Fills, multisets, satisfiesFlat } from '../../helpers/criteria-oracle';
import { contextOf, FakeGroups } from '../../helpers/desc-context';
import { buildCdb, CODE, FIXTURE_ROWS } from '../../helpers/fixture-cards';
import { type Rng, seededRng } from '../../helpers/prng';

const SQL = await initSqlJs();
const fixture = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, FIXTURE_ROWS) }]);
const GROUPS: Groups = new Map([['g-starters', new Set([CODE.tunerFairy, CODE.quickSpell])]]);
const parseCtx = contextOf(fixture, { groups: new FakeGroups([['g-starters', 'Starters']]) });
const ctx: ImpliesContext = { cards: fixture, groups: GROUPS };

function d(text: string): Description {
  const result = parse(text, parseCtx);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.desc;
}

type Entry = readonly [n: number, description: string];

function counted(entries: readonly Entry[]): Counted[] {
  return entries.map(([n, text]) => ({ n, desc: d(text) }));
}

function flat(reqs: readonly Entry[], limits: readonly Entry[] = []): FlatCriterion {
  return { reqs: counted(reqs), limits: counted(limits) };
}

describe('subsumes', () => {
  describe('a split criterion', () => {
    const splitFlat = (
      five: readonly Entry[],
      sixth: readonly Entry[],
      sixthLimits: readonly Entry[] = [],
    ): FlatCriterion => ({
      ...flat(five),
      sixth: { reqs: counted(sixth), limits: counted(sixthLimits) },
    });

    it('holds of a split criterion and itself', () => {
      const A = splitFlat([[1, 'level 4 monster']], [[1, 'trap']]);
      expect(subsumes(A, A, ctx)).toBe(true);
    });

    it('reads the injection over BOTH windows', () => {
      const narrow = splitFlat([[1, 'level 4 monster']], [[1, 'quick-play spell']]);
      const wide = splitFlat([[1, 'monster']], [[1, 'spell']]);
      expect(subsumes(wide, narrow, ctx)).toBe(true);
      expect(subsumes(narrow, wide, ctx)).toBe(false);
      // Widening only the five-card part is not enough: the sixth card's part
      // of the wider one must be reachable too.
      const halfWide = splitFlat([[1, 'monster']], [[1, 'quick-play spell']]);
      expect(subsumes(halfWide, narrow, ctx)).toBe(true);
      expect(subsumes(splitFlat([[1, 'monster']], [[1, 'monster']]), narrow, ctx)).toBe(false);
    });

    it('gives up between a split criterion and an unsplit one, both ways round', () => {
      // They are about different sample spaces, and `false` is advice withheld
      // rather than a claim that neither subsumes the other.
      const split = splitFlat([[1, 'monster']], [[1, 'monster']]);
      const whole = flat([[1, 'monster']]);
      expect(subsumes(whole, split, ctx)).toBe(false);
      expect(subsumes(split, whole, ctx)).toBe(false);
    });

    it("covers the sixth card's limits over a hand of ONE card", () => {
      // `at most 1x trap` of one card holds always, so it needs no cover.
      const tight = splitFlat([[1, 'monster']], [[1, 'monster']], [[0, 'trap']]);
      const loose = splitFlat([[1, 'monster']], [[1, 'monster']], [[1, 'trap']]);
      expect(subsumes(loose, tight, ctx)).toBe(true);
      expect(subsumes(tight, loose, ctx)).toBe(false);
    });
  });

  it('holds of a criterion and itself', () => {
    const A = flat(
      [
        [2, 'level 4 monster'],
        [1, 'spell'],
      ],
      [[1, 'trap']],
    );
    expect(subsumes(A, A, ctx)).toBe(true);
  });

  it('holds of the criterion with no requirements and no limits, over anything', () => {
    expect(subsumes(flat([]), flat([[1, 'monster']], [[0, 'spell']]), ctx)).toBe(true);
    expect(subsumes(flat([[1, 'monster']]), flat([]), ctx)).toBe(false);
  });

  describe('requirements', () => {
    it('lets a narrower slot of A stand for a broader slot of B, never the reverse', () => {
      const narrow = flat([
        [1, 'level 4 FIRE monster'],
        [1, 'spell'],
      ]);
      const broad = flat([[1, 'monster']]);
      expect(subsumes(broad, narrow, ctx)).toBe(true);
      expect(subsumes(narrow, broad, ctx)).toBe(false);
    });

    it('needs a slot of A for every slot of B', () => {
      expect(subsumes(flat([[2, 'monster']]), flat([[1, 'level 4 monster']]), ctx)).toBe(false);
      expect(subsumes(flat([[2, 'monster']]), flat([[2, 'level 4 monster']]), ctx)).toBe(true);
      expect(subsumes(flat([[2, 'monster']]), flat([[3, 'level 4 monster']]), ctx)).toBe(true);
    });

    it('spreads the slots of one requirement of B over several of A', () => {
      const A = flat([
        [1, 'level 4 monster'],
        [1, 'FIRE monster'],
        [1, 'spell'],
      ]);
      expect(subsumes(flat([[2, 'monster']]), A, ctx)).toBe(true);
      expect(subsumes(flat([[3, 'monster']]), A, ctx)).toBe(false);
    });

    it('finds the injection a first-fit assignment misses', () => {
      // `monster` could take A's first slot, but `level 4 monster` has nowhere else to go.
      const A = flat([
        [1, 'level 4 FIRE monster'],
        [1, 'tuner monster'],
      ]);
      const B = flat([
        [1, 'monster'],
        [1, 'level 4 monster'],
      ]);
      expect(subsumes(B, A, ctx)).toBe(true);
    });

    it('lets a named card stand for what its record satisfies', () => {
      const A = flat([[1, `#${CODE.tunerFairy}`]]);
      expect(subsumes(flat([[1, 'LIGHT tuner monster']]), A, ctx)).toBe(true);
      expect(subsumes(flat([[1, 'DARK monster']]), A, ctx)).toBe(false);
      expect(subsumes(A, flat([[1, 'LIGHT tuner monster']]), ctx)).toBe(false);
    });

    it('matches slot by slot even when the counts run to the text grammar’s ceiling', () => {
      const A = flat([
        [30, 'level 4 monster'],
        [30, 'spell'],
      ]);
      expect(subsumes(flat([[60, 'card']]), A, ctx)).toBe(true);
      expect(subsumes(flat([[31, 'monster']]), A, ctx)).toBe(false);
    });
  });

  describe('limits', () => {
    it('lets a limit of A cover a narrower or looser limit of B', () => {
      const A = flat([[1, 'monster']], [[1, 'spell']]);
      expect(subsumes(flat([[1, 'monster']], [[1, 'quick-play spell']]), A, ctx)).toBe(true);
      expect(subsumes(flat([[1, 'monster']], [[2, 'spell']]), A, ctx)).toBe(true);
      expect(subsumes(flat([[1, 'monster']], [[3, 'quick-play spell']]), A, ctx)).toBe(true);
    });

    it('refuses a tighter or a broader limit of B', () => {
      const A = flat([[1, 'monster']], [[1, 'quick-play spell']]);
      expect(subsumes(flat([[1, 'monster']], [[0, 'quick-play spell']]), A, ctx)).toBe(false);
      expect(subsumes(flat([[1, 'monster']], [[1, 'spell']]), A, ctx)).toBe(false);
    });

    it('lets A carry limits B does not, and refuses a limit of B that A lacks', () => {
      const limited = flat([[1, 'monster']], [[0, 'trap']]);
      const free = flat([[1, 'monster']]);
      expect(subsumes(free, limited, ctx)).toBe(true);
      expect(subsumes(limited, free, ctx)).toBe(false);
    });

    it('covers each limit of B on its own: one limit of A may cover several', () => {
      const A = flat([], [[0, 'spell/trap']]);
      const B = flat(
        [],
        [
          [0, 'spell'],
          [1, 'counter trap'],
        ],
      );
      expect(subsumes(B, A, ctx)).toBe(true);
    });

    it('needs no cover for a limit the hand cannot break, once it is told the hand size', () => {
      const A = flat([[1, 'monster']]);
      const B = flat([[1, 'monster']], [[5, 'spell']]);
      expect(subsumes(B, A, ctx)).toBe(false);
      expect(subsumes(B, A, ctx, 6)).toBe(false);
      expect(subsumes(B, A, ctx, 5)).toBe(true);
      expect(subsumes(B, A, ctx, 4)).toBe(true);
    });
  });

  it('decides by a relation of the caller’s, given one in place of a context', () => {
    const A = flat([[1, 'level 4 monster']], [[1, 'trap']]);
    const B = flat([[1, 'monster']], [[2, 'counter trap']]);
    const asked: string[] = [];
    const relation = (L: Description, q: Description) => {
      asked.push(`${JSON.stringify(L)} => ${JSON.stringify(q)}`);
      return implies(L, q, ctx);
    };
    expect(subsumes(B, A, relation)).toBe(subsumes(B, A, ctx));
    expect(subsumes(A, B, relation)).toBe(subsumes(A, B, ctx));
    // B over A: B's limit against A's, then A's slot against B's. A over B asks nothing:
    // B's looser limit cannot cover A's. `implies` was never called behind the relation's back.
    expect(asked).toHaveLength(2);
    expect(subsumes(B, A, () => false)).toBe(false);
  });

  it('is only a sufficient condition: two limits of A never combine to cover one of B', () => {
    // No monster and no spell is no "monster or spell" — true of every hand, and not detected.
    const A = flat(
      [],
      [
        [0, 'monster'],
        [0, 'spell'],
      ],
    );
    expect(subsumes(flat([], [[0, 'monster or spell']]), A, ctx)).toBe(false);
  });

  describe('range requirements', () => {
    const ranged = (n: number, max: number, text: string): FlatCriterion => ({
      reqs: [{ n, max, desc: d(text) }],
      limits: [],
    });

    it('claims nothing for a B with a ceiling: a ceiling REJECTS hands, and is not covered', () => {
      // `1-1x monster` does not accept every hand `1x level 4 monster` accepts:
      // two Level 4 monsters satisfy the second and break the first.
      expect(subsumes(ranged(1, 1, 'monster'), flat([[1, 'level 4 monster']]), ctx)).toBe(false);
      // Not even of itself, which is where the giving up shows plainest.
      expect(subsumes(ranged(1, 2, 'monster'), ranged(1, 2, 'monster'), ctx)).toBe(false);
    });

    it('still reads an A with a ceiling: its lower bounds fill B, and its ceiling only narrows A', () => {
      expect(subsumes(flat([[1, 'monster']]), ranged(1, 2, 'level 4 monster'), ctx)).toBe(true);
      // A lower bound of zero fills nothing, so it cannot fill B's slot.
      expect(subsumes(flat([[1, 'monster']]), ranged(0, 2, 'level 4 monster'), ctx)).toBe(false);
    });

    it('keeps a range out of the notice `findSubsumed` gives', () => {
      const criteria = [flat([[1, 'level 4 monster']]), ranged(1, 2, 'monster')];
      expect(findSubsumed(criteria, ctx)).toEqual([]);
    });
  });
});

describe('findSubsumed', () => {
  it('finds nothing among unrelated criteria, or among fewer than two', () => {
    expect(findSubsumed([], ctx)).toEqual([]);
    expect(findSubsumed([flat([[1, 'monster']])], ctx)).toEqual([]);
    expect(findSubsumed([flat([[1, 'monster']]), flat([[1, 'spell']])], ctx)).toEqual([]);
  });

  it('reports every subsumed criterion with what subsumes it, in order', () => {
    const criteria = [
      flat([[1, 'level 4 monster']]),
      flat([[1, 'monster']]),
      flat([[1, 'spell']]),
      flat([
        [1, 'level 4 FIRE monster'],
        [1, 'spell'],
      ]),
    ];
    expect(findSubsumed(criteria, ctx)).toEqual([
      { subsumed: 0, by: 1 },
      { subsumed: 3, by: 0 },
      { subsumed: 3, by: 1 },
      { subsumed: 3, by: 2 },
    ]);
  });

  it('reports two criteria that subsume each other once, the later as subsumed', () => {
    // Equivalent without being structurally equal, so `expand` keeps both.
    const criteria = [
      flat([[1, 'level 4 or lower monster']]),
      flat([[1, 'spell']]),
      flat([[1, 'level 0-2 monster or level 3-4 monster']]),
    ];
    expect(findSubsumed(criteria, ctx)).toEqual([{ subsumed: 2, by: 0 }]);
  });

  it('takes a relation in place of a context, as `subsumes` does', () => {
    const criteria = [flat([[1, 'level 4 monster']]), flat([[1, 'monster']])];
    expect(findSubsumed(criteria, (L, q) => implies(L, q, ctx))).toEqual([{ subsumed: 0, by: 1 }]);
    expect(findSubsumed(criteria, () => false)).toEqual([]);
  });

  it('passes the hand size on', () => {
    const criteria = [flat([[1, 'monster']]), flat([[1, 'monster']], [[5, 'spell']])];
    expect(findSubsumed(criteria, ctx)).toEqual([{ subsumed: 1, by: 0 }]);
    expect(findSubsumed(criteria, ctx, 5)).toEqual([{ subsumed: 1, by: 0 }]);
    expect(findSubsumed([criteria[1]!, criteria[0]!], ctx, 5)).toEqual([{ subsumed: 1, by: 0 }]);
    expect(findSubsumed([criteria[1]!, criteria[0]!], ctx)).toEqual([{ subsumed: 0, by: 1 }]);
  });
});

describe('subsumption is sound against every small hand of lines (E2)', () => {
  const MAX_HAND = 5;
  /** What a hand is drawn from: template lines, each known only as far as it states. */
  const LINES = [
    'level 4 FIRE Warrior monster',
    'level 4 monster',
    'LIGHT monster',
    'monster',
    'quick-play spell',
    'spell',
    `#${CODE.tunerFairy}`,
  ].map(d);
  /** What criteria are written with: chains of implication, and descriptions off them. */
  const QUERIES = [
    'card',
    'monster',
    'level 4 or lower monster',
    'level 4 monster',
    'FIRE monster',
    'LIGHT monster',
    'level 4 FIRE monster',
    'level 4 FIRE Warrior monster',
    'Warrior monster',
    'tuner monster',
    'non-tuner',
    'spell',
    'quick-play spell',
    'spell/trap',
    'level 4 monster or quick-play spell',
    `#${CODE.tunerFairy}`,
    `#${CODE.tunerFairy} or spell`,
    '{Starters}',
  ].map(d);
  const HANDS = multisets(LINES, MAX_HAND);

  // A line fills a slot, and counts against a limit, iff it implies the description (TDD §8).
  const lineFills = new Map(
    LINES.map((line) => [line, new Map(QUERIES.map((q) => [q, implies(line, q, ctx)]))]),
  );
  const fills: Fills<Description> = (line, desc) => lineFills.get(line)!.get(desc)!;
  const impliedBy = new Map(QUERIES.map((q) => [q, QUERIES.filter((r) => implies(q, r, ctx))]));
  const implying = new Map(QUERIES.map((q) => [q, QUERIES.filter((r) => implies(r, q, ctx))]));

  function genFlat(rng: Rng): FlatCriterion {
    return {
      reqs: Array.from({ length: rng.int(1, 3) }, () => ({
        n: rng.pick([1, 1, 1, 2]),
        desc: rng.pick(QUERIES),
      })),
      limits: Array.from({ length: rng.pick([0, 0, 1, 1, 2]) }, () => ({
        n: rng.int(0, 2),
        desc: rng.pick(QUERIES),
      })),
    };
  }

  /** `A` loosened the ways `subsumes` recognizes — and sometimes tightened, which it must not. */
  function derive(rng: Rng, A: FlatCriterion): FlatCriterion {
    const reqs: Counted[] = [];
    for (const { n, desc } of A.reqs) {
      const roll = rng.next();
      if (roll < 0.2) continue;
      if (roll < 0.5) reqs.push({ n, desc });
      else reqs.push({ n: rng.int(1, n), desc: rng.pick(impliedBy.get(desc)!) });
    }
    const limits: Counted[] = [];
    for (const { n, desc } of A.limits) {
      const roll = rng.next();
      if (roll < 0.3) continue;
      if (roll < 0.5) limits.push({ n, desc });
      else limits.push({ n: n + rng.int(0, 1), desc: rng.pick(implying.get(desc)!) });
    }
    if (rng.chance(0.15))
      limits.push({ n: rng.int(MAX_HAND - 1, MAX_HAND + 1), desc: rng.pick(QUERIES) });
    if (rng.chance(0.15)) reqs.push({ n: 1, desc: rng.pick(QUERIES) });
    if (rng.chance(0.1)) limits.push({ n: rng.int(0, 2), desc: rng.pick(QUERIES) });
    if (rng.chance(0.1) && reqs.length > 0) {
      const i = rng.int(0, reqs.length - 1);
      reqs[i] = { n: reqs[i]!.n, desc: rng.pick(implying.get(reqs[i]!.desc)!) };
    }
    return { reqs, limits };
  }

  it('never claims a subsumption that some hand contradicts, over 3,000 pairs', () => {
    const rng = seededRng(0xe2e20001);
    let claimed = 0;
    let witnessed = 0;
    let vacuous = 0;
    for (let i = 0; i < 3000; i++) {
      const A = genFlat(rng);
      const B = rng.chance(0.75) ? derive(rng, A) : genFlat(rng);
      if (!subsumes(B, A, ctx, MAX_HAND)) continue;
      claimed++;
      if (!subsumes(B, A, ctx)) vacuous++;
      for (const hand of HANDS) {
        if (!satisfiesFlat(A, hand, fills)) continue;
        witnessed++;
        same(satisfiesFlat(B, hand, fills), true, () => ({ A, B, hand }));
      }
    }
    // Measured: 1,659 claims, 278,535 hands satisfying the subsumed side, 155 claims that rest
    // on a limit the hand cannot break.
    expect(claimed).toBeGreaterThan(1500);
    expect(witnessed).toBeGreaterThan(250000);
    expect(vacuous).toBeGreaterThan(100);
  });

  it('claims what the derivation guarantees', () => {
    const rng = seededRng(0xe2e20002);
    for (let i = 0; i < 500; i++) {
      const A = genFlat(rng);
      const B: FlatCriterion = {
        reqs: A.reqs
          .filter(() => rng.chance(0.7))
          .map(({ n, desc }) => ({ n: rng.int(1, n), desc: rng.pick(impliedBy.get(desc)!) })),
        limits: A.limits
          .filter(() => rng.chance(0.7))
          .map(({ n, desc }) => ({ n: n + rng.int(0, 1), desc: rng.pick(implying.get(desc)!) })),
      };
      same(subsumes(B, A, ctx), true, () => ({ A, B }));
    }
  });
});
