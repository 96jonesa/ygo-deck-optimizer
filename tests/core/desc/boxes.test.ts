import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_FIRE,
  RACE_CYBORG,
  RACE_DRAGON,
  RACE_WARRIOR,
} from '../../../src/core/cards/constants';
import {
  ATTRIBUTE_VOCABULARY,
  KINDS,
  MONSTER_FLAGS,
  RACE_VOCABULARY,
} from '../../../src/core/cards/vocabulary';
import type { Clause, Description } from '../../../src/core/desc/ast';
import {
  ATTRIBUTE_NONE,
  archetypeDimsOf,
  BOOL_ANY,
  BOOL_FALSE,
  BOOL_TRUE,
  type Box,
  boxIntersect,
  boxIsEmpty,
  boxSubtract,
  fullBox,
  LEVEL_OTHER,
  MONSTER_LAYOUT,
  RACE_OTHER,
  ST_LAYOUT,
  STAT_ALL,
  STAT_LAYOUT,
  STAT_NONE,
  type StatSet,
  SUBKINDS_OF,
  saturate,
  statIntersect,
  statIsEmpty,
  statSetOf,
  statSubtract,
  subtractAll,
  toBoxes,
} from '../../../src/core/desc/boxes';
import { same } from '../../helpers/assert';
import { type Rng, seededRng } from '../../helpers/prng';

const UNKNOWN = -2;

function ranges(...pairs: [number, number | null][]): StatSet {
  return { ranges: pairs.map(([min, max]) => ({ min, max })), unknown: false };
}

function statContains(set: StatSet, value: number): boolean {
  if (value === UNKNOWN) return set.unknown;
  return set.ranges.some((r) => value >= r.min && (r.max === null || value <= r.max));
}

/** Sorted, disjoint and non-adjacent, with `min <= max`: the documented shape of a `StatSet`. */
function isCanonical(set: StatSet): boolean {
  return set.ranges.every((r, i) => {
    const previous = set.ranges[i - 1];
    const ordered = previous === undefined || (previous.max !== null && previous.max + 1 < r.min);
    return ordered && r.min >= 0 && (r.max === null || r.min <= r.max);
  });
}

/** A few small ranges over 0..30, sometimes unbounded at the top, sometimes with "?". */
function genStatSet(rng: Rng): StatSet {
  const out: { min: number; max: number | null }[] = [];
  let next = rng.int(0, 6);
  for (let n = rng.int(0, 3); n > 0 && next <= 30; n--) {
    const max = next + rng.int(0, 6);
    out.push({ min: next, max });
    next = max + rng.int(2, 6);
  }
  const last = out[out.length - 1];
  if (last && rng.chance(0.3)) last.max = null;
  return { ranges: out, unknown: rng.chance(0.5) };
}

const STAT_PROBES = [UNKNOWN, ...Array.from({ length: 50 }, (_, i) => i)];

function clauseDesc(...clauses: Clause[]): Description {
  return { anyOf: clauses.map((clause) => ({ t: 'clause', clause })) };
}

/** The single box of `clause` for `kind`, which must exist. */
function boxOf(clause: Clause, kind: Box['kind'], dims: readonly number[] = []): Box {
  const box = toBoxes(clauseDesc(clause), dims).find((b) => b.kind === kind);
  if (!box) throw new Error(`no ${kind} box for ${JSON.stringify(clause)}`);
  return box;
}

function kindsOf(clause: Clause, dims: readonly number[] = []): string[] {
  return toBoxes(clauseDesc(clause), dims).map((box) => box.kind);
}

function attributeBit(bit: number): number {
  return 1 << ATTRIBUTE_VOCABULARY.findIndex((entry) => entry.bit === bit);
}

function raceBit(bit: number): number {
  return 1 << RACE_VOCABULARY.findIndex((entry) => entry.bit === bit);
}

function subkindBit(kind: 'spell' | 'trap', subkind: string): number {
  return 1 << SUBKINDS_OF[kind].indexOf(subkind as never);
}

/** One point of a kind's space: a value index per discrete dimension, a number per stat. */
interface Point {
  kind: Box['kind'];
  values: number[];
  stats: number[];
}

function boxContains(box: Box, point: Point): boolean {
  return (
    box.kind === point.kind &&
    box.masks.every((mask, i) => (mask & (1 << point.values[i]!)) !== 0) &&
    box.stats.every((set, i) => statContains(set, point.stats[i]!))
  );
}

const DIMS = [0x66, 0x1066, 0x99];

/** A random sub-box of the monster space: each dimension narrowed with some probability. */
function genMonsterBox(rng: Rng): Box {
  const box = fullBox('monster', DIMS);
  box.masks = box.masks.map((any) => {
    if (rng.chance(0.6)) return any;
    const bits = Array.from({ length: 32 - Math.clz32(any) }, (_, i) => 1 << i);
    return rng.subset(bits, 1, bits.length).reduce((mask, bit) => mask | bit, 0);
  });
  box.stats = box.stats.map((any) => {
    if (rng.chance(0.4)) return any;
    const set = genStatSet(rng);
    return statIsEmpty(set) ? any : set;
  });
  return box;
}

function genMonsterPoint(rng: Rng): Point {
  const any = fullBox('monster', DIMS);
  return {
    kind: 'monster',
    values: any.masks.map((mask) => rng.int(0, 31 - Math.clz32(mask))),
    stats: any.stats.map(() => rng.pick(STAT_PROBES)),
  };
}

describe('statSetOf', () => {
  it('makes "?" the point outside every range', () => {
    expect(statSetOf('?')).toEqual({ ranges: [], unknown: true });
  });

  it('makes a range, bounded or not, that does not hold "?"', () => {
    expect(statSetOf({ min: 1000, max: 2000 })).toEqual(ranges([1000, 2000]));
    expect(statSetOf({ min: 1500, max: null })).toEqual(ranges([1500, null]));
  });

  it('makes an inverted range empty', () => {
    expect(statIsEmpty(statSetOf({ min: 2000, max: 1000 }))).toBe(true);
  });
});

describe('statIsEmpty', () => {
  it('is true of no ranges and no "?" only', () => {
    expect(statIsEmpty(STAT_NONE)).toBe(true);
    expect(statIsEmpty(STAT_ALL)).toBe(false);
    expect(statIsEmpty({ ranges: [], unknown: true })).toBe(false);
    expect(statIsEmpty(ranges([0, 0]))).toBe(false);
  });
});

describe('statIntersect', () => {
  it('keeps the overlap of two ranges, endpoints included', () => {
    expect(statIntersect(ranges([1000, 2000]), ranges([2000, 3000]))).toEqual(ranges([2000, 2000]));
    expect(statIntersect(ranges([1000, 2000]), ranges([2001, 3000]))).toEqual(STAT_NONE);
  });

  it('handles unbounded ranges', () => {
    expect(statIntersect(ranges([1000, null]), ranges([500, null]))).toEqual(ranges([1000, null]));
    expect(statIntersect(ranges([1000, null]), ranges([0, 1500]))).toEqual(ranges([1000, 1500]));
  });

  it('walks two lists of ranges', () => {
    const a = ranges([0, 10], [20, 30], [40, null]);
    const b = ranges([5, 25], [28, 45]);
    expect(statIntersect(a, b)).toEqual(ranges([5, 10], [20, 25], [28, 30], [40, 45]));
  });

  it('keeps "?" only when both sides hold it', () => {
    expect(statIntersect(STAT_ALL, statSetOf('?'))).toEqual(statSetOf('?'));
    expect(statIntersect(statSetOf('?'), ranges([0, null]))).toEqual(STAT_NONE);
  });

  it('agrees with membership, point by point, on 2,000 generated pairs', () => {
    const rng = seededRng(0xb0c50001);
    for (let i = 0; i < 2000; i++) {
      const a = genStatSet(rng);
      const b = genStatSet(rng);
      const both = statIntersect(a, b);
      same(isCanonical(both), true, () => [a, b, both]);
      for (const value of STAT_PROBES)
        same(statContains(both, value), statContains(a, value) && statContains(b, value), () => [
          a,
          b,
          value,
        ]);
    }
  });
});

describe('statSubtract', () => {
  it('leaves [a, c-1] and [d+1, b] around a cut [c, d]', () => {
    expect(statSubtract(ranges([0, 3000]), ranges([1000, 2000]))).toEqual(
      ranges([0, 999], [2001, 3000]),
    );
  });

  it('cuts one side only when the cut overlaps an end', () => {
    expect(statSubtract(ranges([1000, 2000]), ranges([0, 1500]))).toEqual(ranges([1501, 2000]));
    expect(statSubtract(ranges([1000, 2000]), ranges([1500, null]))).toEqual(ranges([1000, 1499]));
  });

  it('leaves a single point when the cut stops one short', () => {
    expect(statSubtract(ranges([1000, 2000]), ranges([1001, null]))).toEqual(ranges([1000, 1000]));
    expect(statSubtract(ranges([1000, 2000]), ranges([0, 1999]))).toEqual(ranges([2000, 2000]));
  });

  it('leaves nothing when the cut covers the range, and everything when it misses', () => {
    expect(statSubtract(ranges([1000, 2000]), ranges([1000, 2000]))).toEqual(STAT_NONE);
    expect(statSubtract(ranges([1000, 2000]), ranges([500, null]))).toEqual(STAT_NONE);
    expect(statSubtract(ranges([1000, 2000]), ranges([2001, 3000]))).toEqual(ranges([1000, 2000]));
    expect(statSubtract(ranges([1000, 2000]), ranges([0, 999]))).toEqual(ranges([1000, 2000]));
  });

  it('handles unbounded ranges on either side', () => {
    expect(statSubtract(ranges([0, null]), ranges([1000, 2000]))).toEqual(
      ranges([0, 999], [2001, null]),
    );
    expect(statSubtract(ranges([0, null]), ranges([500, null]))).toEqual(ranges([0, 499]));
    expect(statSubtract(ranges([0, null]), ranges([0, null]))).toEqual(STAT_NONE);
  });

  it('applies several cuts to several ranges', () => {
    const a = ranges([0, 10], [20, 30], [40, null]);
    const b = ranges([5, 22], [25, 26], [50, 60]);
    expect(statSubtract(a, b)).toEqual(ranges([0, 4], [23, 24], [27, 30], [40, 49], [61, null]));
  });

  it('removes "?" only when the cut holds it, and never removes it with a range', () => {
    expect(statSubtract(STAT_ALL, ranges([0, null]))).toEqual(statSetOf('?'));
    expect(statSubtract(STAT_ALL, statSetOf('?'))).toEqual(ranges([0, null]));
    expect(statSubtract(ranges([0, 1500]), statSetOf('?'))).toEqual(ranges([0, 1500]));
  });

  it('agrees with membership, point by point, on 2,000 generated pairs', () => {
    const rng = seededRng(0xb0c50002);
    for (let i = 0; i < 2000; i++) {
      const a = genStatSet(rng);
      const b = genStatSet(rng);
      const rest = statSubtract(a, b);
      same(isCanonical(rest), true, () => [a, b, rest]);
      for (const value of STAT_PROBES)
        same(statContains(rest, value), statContains(a, value) && !statContains(b, value), () => [
          a,
          b,
          value,
        ]);
    }
  });
});

describe('archetypeDimsOf', () => {
  it('collects the setcodes of every clause of every description, ascending, once each', () => {
    const L = clauseDesc({ archetypes: [0x3066, 0x66] }, { level: [4] });
    const q: Description = {
      anyOf: [
        { t: 'card', passcode: 1 },
        { t: 'clause', clause: { archetypes: [0x1066, 0x66] } },
      ],
    };
    expect(archetypeDimsOf(L, q)).toEqual([0x66, 0x1066, 0x3066]);
    expect(archetypeDimsOf(clauseDesc({}))).toEqual([]);
  });
});

describe('fullBox', () => {
  it('spans every dimension of its kind, with NONE / OTHER included', () => {
    const monster = fullBox('monster', [0x66]);
    expect(monster.masks).toHaveLength(MONSTER_FLAGS.length + 3 + 1);
    expect(monster.masks[MONSTER_LAYOUT.flag('tuner')]).toBe(BOOL_ANY);
    expect(monster.masks[MONSTER_LAYOUT.attribute]).toBe((1 << 8) - 1);
    expect(monster.masks[MONSTER_LAYOUT.race]).toBe((1 << 27) - 1);
    expect(monster.masks[MONSTER_LAYOUT.level]).toBe((1 << 15) - 1);
    expect(monster.masks[MONSTER_LAYOUT.archetypes]).toBe(BOOL_ANY);
    expect(monster.stats).toEqual([STAT_ALL, STAT_ALL]);
  });

  it('gives a Spell six sub-kinds and a Trap three', () => {
    expect(SUBKINDS_OF.spell).toEqual([
      'normal',
      'quick-play',
      'continuous',
      'equip',
      'field',
      'ritual',
    ]);
    expect(SUBKINDS_OF.trap).toEqual(['normal', 'continuous', 'counter']);
    expect(fullBox('spell', [0x66]).masks).toEqual([0b111111, BOOL_ANY]);
    expect(fullBox('trap', []).masks).toEqual([0b111]);
    expect(fullBox('trap', []).stats).toEqual([]);
  });
});

describe('toBoxes', () => {
  it('makes the empty clause the three full boxes', () => {
    expect(toBoxes(clauseDesc({}), [0x66])).toEqual(KINDS.map((kind) => fullBox(kind, [0x66])));
  });

  it('treats an empty list as unconstrained, as evaluate does', () => {
    const clause: Clause = {
      kinds: [],
      stSubkinds: [],
      level: [],
      attributes: { in: [] },
      races: { notIn: [] },
      archetypes: [],
    };
    expect(toBoxes(clauseDesc(clause), [])).toEqual(KINDS.map((kind) => fullBox(kind, [])));
  });

  it('restricts the boxes to the kinds written', () => {
    expect(kindsOf({ kinds: ['spell', 'trap'] })).toEqual(['spell', 'trap']);
    expect(kindsOf({ kinds: ['monster'] })).toEqual(['monster']);
  });

  it('skips cards and groups, which are points', () => {
    const desc: Description = {
      anyOf: [
        { t: 'card', passcode: 1 },
        { t: 'group', groupId: 'g' },
      ],
    };
    expect(toBoxes(desc, [])).toEqual([]);
  });

  it('concatenates the boxes of every clause', () => {
    const desc = clauseDesc({ kinds: ['spell'] }, { level: [4] }, {});
    expect(toBoxes(desc, []).map((box) => box.kind)).toEqual([
      'spell',
      'monster',
      'monster',
      'spell',
      'trap',
    ]);
  });

  describe('axiom 1: a positive monster-only constraint empties the Spell and Trap boxes', () => {
    const positives: [string, Clause][] = [
      ['a required flag', { flags: { tuner: true } }],
      ['an Attribute list', { attributes: { in: [ATTRIBUTE_FIRE] } }],
      ['a Type list', { races: { in: [RACE_WARRIOR] } }],
      ['a Level', { level: [4] }],
      ['ATK', { atk: { min: 0, max: 1500 } }],
      ['ATK ?', { atk: '?' }],
      ['DEF', { def: { min: 2000, max: null } }],
    ];
    for (const [name, clause] of positives)
      it(`does so for ${name}`, () => {
        expect(kindsOf(clause)).toEqual(['monster']);
        expect(kindsOf({ ...clause, kinds: ['spell', 'trap'] })).toEqual([]);
      });
  });

  describe('axiom 2: a negative monster-only constraint leaves the Spell and Trap boxes full', () => {
    const negatives: [string, Clause][] = [
      ['a negated flag', { flags: { tuner: false } }],
      ['a negated Attribute list', { attributes: { notIn: [ATTRIBUTE_FIRE] } }],
      ['a negated Type list', { races: { notIn: [RACE_WARRIOR, RACE_DRAGON] } }],
    ];
    for (const [name, clause] of negatives)
      it(`does so for ${name}`, () => {
        const [monster, spell, trap] = toBoxes(clauseDesc(clause), []);
        expect(monster).not.toEqual(fullBox('monster', []));
        expect(spell).toEqual(fullBox('spell', []));
        expect(trap).toEqual(fullBox('trap', []));
      });
  });

  describe('axiom 3: a sub-kind empties the Monster box and the kinds it does not exist for', () => {
    it('keeps Spell and Trap for a sub-kind both have', () => {
      const [spell, trap] = toBoxes(clauseDesc({ stSubkinds: ['continuous'] }), []);
      expect(spell).toMatchObject({ kind: 'spell', masks: [subkindBit('spell', 'continuous')] });
      expect(trap).toMatchObject({ kind: 'trap', masks: [subkindBit('trap', 'continuous')] });
    });

    it('keeps only the kind a sub-kind exists for', () => {
      expect(kindsOf({ stSubkinds: ['counter'] })).toEqual(['trap']);
      expect(kindsOf({ stSubkinds: ['quick-play'], kinds: ['spell', 'trap'] })).toEqual(['spell']);
      expect(kindsOf({ stSubkinds: ['counter'], kinds: ['spell'] })).toEqual([]);
      expect(kindsOf({ stSubkinds: ['field'], kinds: ['monster'] })).toEqual([]);
    });

    it('keeps, per kind, the listed sub-kinds that exist for it', () => {
      const clause: Clause = { stSubkinds: ['normal', 'field', 'counter'] };
      expect(boxOf(clause, 'spell').masks[ST_LAYOUT.subkind]).toBe(
        subkindBit('spell', 'normal') | subkindBit('spell', 'field'),
      );
      expect(boxOf(clause, 'trap').masks[ST_LAYOUT.subkind]).toBe(
        subkindBit('trap', 'normal') | subkindBit('trap', 'counter'),
      );
    });

    it('makes a sub-kind beside a positive monster constraint unsatisfiable', () => {
      expect(kindsOf({ stSubkinds: ['continuous'], level: [4] })).toEqual([]);
    });
  });

  describe('flags', () => {
    it('sets one boolean dimension per flag and leaves the others free', () => {
      const box = boxOf({ flags: { tuner: true, effect: false } }, 'monster');
      expect(box.masks[MONSTER_LAYOUT.flag('tuner')]).toBe(BOOL_TRUE);
      expect(box.masks[MONSTER_LAYOUT.flag('effect')]).toBe(BOOL_FALSE);
      expect(box.masks[MONSTER_LAYOUT.flag('normal')]).toBe(BOOL_ANY);
    });
  });

  describe('Attribute, Type and Level', () => {
    it('keeps NONE out of a positive Attribute list and in a negated one', () => {
      const fire = boxOf({ attributes: { in: [ATTRIBUTE_FIRE] } }, 'monster');
      expect(fire.masks[MONSTER_LAYOUT.attribute]).toBe(attributeBit(ATTRIBUTE_FIRE));
      const nonFire = boxOf({ attributes: { notIn: [ATTRIBUTE_FIRE] } }, 'monster');
      expect(nonFire.masks[MONSTER_LAYOUT.attribute]).toBe(
        ((1 << 8) - 1) & ~attributeBit(ATTRIBUTE_FIRE),
      );
      expect(nonFire.masks[MONSTER_LAYOUT.attribute]! & ATTRIBUTE_NONE).not.toBe(0);
    });

    it('keeps OTHER out of a positive Type list and in a negated one', () => {
      const list = boxOf({ races: { in: [RACE_WARRIOR, RACE_DRAGON] } }, 'monster');
      expect(list.masks[MONSTER_LAYOUT.race]).toBe(raceBit(RACE_WARRIOR) | raceBit(RACE_DRAGON));
      const negated = boxOf({ races: { notIn: [RACE_WARRIOR] } }, 'monster');
      expect(negated.masks[MONSTER_LAYOUT.race]! & RACE_OTHER).not.toBe(0);
      expect(negated.masks[MONSTER_LAYOUT.race]! & raceBit(RACE_WARRIOR)).toBe(0);
    });

    it('never holds the out-of-domain Level in a Level list, even the whole domain', () => {
      const all = Array.from({ length: 14 }, (_, n) => n);
      expect(boxOf({ level: all }, 'monster').masks[MONSTER_LAYOUT.level]).toBe(LEVEL_OTHER - 1);
      expect(boxOf({ level: [0, 4] }, 'monster').masks[MONSTER_LAYOUT.level]).toBe(0b10001);
    });

    it('matches no card with a value outside the vocabulary', () => {
      expect(kindsOf({ races: { in: [RACE_CYBORG] } })).toEqual([]);
      expect(kindsOf({ level: [14] })).toEqual([]);
      expect(boxOf({ attributes: { notIn: [0x80] } }, 'monster')).toEqual(fullBox('monster', []));
    });
  });

  describe('ATK and DEF', () => {
    it('sets the stat dimension and leaves the other whole', () => {
      const box = boxOf({ atk: { min: 1000, max: 2000 }, def: '?' }, 'monster');
      expect(box.stats[STAT_LAYOUT.atk]).toEqual(ranges([1000, 2000]));
      expect(box.stats[STAT_LAYOUT.def]).toEqual({ ranges: [], unknown: true });
      expect(boxOf({ level: [4] }, 'monster').stats).toEqual([STAT_ALL, STAT_ALL]);
    });

    it('drops a clause whose range is inverted', () => {
      expect(kindsOf({ atk: { min: 2000, max: 1000 } })).toEqual([]);
    });
  });

  describe('archetypes', () => {
    const dims = [0x66, 0x99, 0x1066, 0x2066, 0x3066];
    const at = (box: Box, code: number) => box.masks[ST_LAYOUT.archetypes + dims.indexOf(code)];

    it('requires every listed archetype, in every kind, and leaves the rest free', () => {
      for (const box of toBoxes(clauseDesc({ archetypes: [0x99, 0x66] }), dims)) {
        const offset = box.kind === 'monster' ? MONSTER_LAYOUT.archetypes : ST_LAYOUT.archetypes;
        expect(box.masks.slice(offset)).toEqual([
          BOOL_TRUE,
          BOOL_TRUE,
          BOOL_ANY,
          BOOL_ANY,
          BOOL_ANY,
        ]);
      }
    });

    it('axiom 4: requiring a sub-archetype requires everything it refines', () => {
      const box = boxOf({ archetypes: [0x3066] }, 'spell', dims);
      expect([0x66, 0x1066, 0x2066, 0x3066].map((code) => at(box, code))).toEqual([
        BOOL_TRUE,
        BOOL_TRUE,
        BOOL_TRUE,
        BOOL_TRUE,
      ]);
      expect(at(box, 0x99)).toBe(BOOL_ANY);
    });

    it('axiom 4 is one-way: a base archetype requires no sub-archetype', () => {
      const box = boxOf({ archetypes: [0x1066] }, 'spell', dims);
      expect(at(box, 0x66)).toBe(BOOL_TRUE);
      expect(at(box, 0x2066)).toBe(BOOL_ANY);
      expect(at(box, 0x3066)).toBe(BOOL_ANY);
    });

    it('throws on an archetype that is not among the dimensions', () => {
      expect(() => toBoxes(clauseDesc({ archetypes: [0x66] }), [0x99])).toThrow(/0x66/);
    });
  });
});

describe('saturate', () => {
  const dims = [0x66, 0x1066, 0x3066];

  it('returns an unconstrained box unchanged', () => {
    expect(saturate(fullBox('trap', dims), dims)).toEqual(fullBox('trap', dims));
  });

  it('empties a box that requires a sub-archetype and forbids its base', () => {
    const box = fullBox('spell', dims);
    box.masks[ST_LAYOUT.archetypes + dims.indexOf(0x3066)] = BOOL_TRUE;
    box.masks[ST_LAYOUT.archetypes + dims.indexOf(0x66)] = BOOL_FALSE;
    expect(saturate(box, dims)).toBeNull();
  });

  it('does not touch the box it is given', () => {
    const box = fullBox('spell', dims);
    box.masks[ST_LAYOUT.archetypes + dims.indexOf(0x3066)] = BOOL_TRUE;
    const before = structuredClone(box);
    saturate(box, dims);
    expect(box).toEqual(before);
  });
});

describe('boxIsEmpty', () => {
  it('is true when any one dimension allows nothing', () => {
    expect(boxIsEmpty(fullBox('monster', []))).toBe(false);
    const noLevel = fullBox('monster', []);
    noLevel.masks[MONSTER_LAYOUT.level] = 0;
    expect(boxIsEmpty(noLevel)).toBe(true);
    const noDef = fullBox('monster', []);
    noDef.stats[STAT_LAYOUT.def] = STAT_NONE;
    expect(boxIsEmpty(noDef)).toBe(true);
  });
});

describe('boxIntersect', () => {
  it('never meets a box of another kind', () => {
    expect(boxIntersect(fullBox('spell', []), fullBox('trap', []))).toBeNull();
  });

  it('intersects dimension by dimension', () => {
    const a = boxOf({ level: [3, 4, 5], atk: { min: 0, max: 2000 } }, 'monster');
    const b = boxOf(
      { level: [4, 5, 6], atk: { min: 1000, max: null }, flags: { tuner: true } },
      'monster',
    );
    expect(boxIntersect(a, b)).toEqual(
      boxOf({ level: [4, 5], atk: { min: 1000, max: 2000 }, flags: { tuner: true } }, 'monster'),
    );
  });

  it('is null when one dimension is disjoint', () => {
    const a = boxOf({ level: [4], attributes: { in: [ATTRIBUTE_FIRE] } }, 'monster');
    expect(boxIntersect(a, boxOf({ attributes: { in: [ATTRIBUTE_DARK] } }, 'monster'))).toBeNull();
    expect(
      boxIntersect(
        boxOf({ atk: '?' }, 'monster'),
        boxOf({ atk: { min: 0, max: null } }, 'monster'),
      ),
    ).toBeNull();
  });
});

describe('boxSubtract', () => {
  it('returns the box itself when the two are disjoint or of different kinds', () => {
    const a = boxOf({ level: [4] }, 'monster');
    expect(boxSubtract(a, boxOf({ level: [5] }, 'monster'))).toEqual([a]);
    expect(boxSubtract(a, fullBox('spell', []))).toEqual([a]);
  });

  it('returns nothing when the box lies inside the cut', () => {
    const a = boxOf({ level: [4], attributes: { in: [ATTRIBUTE_FIRE] } }, 'monster');
    expect(boxSubtract(a, boxOf({ level: [3, 4] }, 'monster'))).toEqual([]);
    expect(boxSubtract(a, a)).toEqual([]);
  });

  it('peels one piece per dimension the cut constrains, each restricted to the earlier slices', () => {
    const a = fullBox('monster', []);
    const cut = boxOf(
      { flags: { tuner: true }, level: [4], atk: { min: 1000, max: null } },
      'monster',
    );
    expect(boxSubtract(a, cut)).toEqual([
      boxOf({ flags: { tuner: false } }, 'monster'),
      { ...boxOf({ flags: { tuner: true } }, 'monster'), masks: withLevelOutside4() },
      {
        ...boxOf({ flags: { tuner: true }, level: [4] }, 'monster'),
        stats: [{ ranges: [{ min: 0, max: 999 }], unknown: true }, STAT_ALL],
      },
    ]);

    function withLevelOutside4(): number[] {
      const masks = [...boxOf({ flags: { tuner: true } }, 'monster').masks];
      masks[MONSTER_LAYOUT.level] = (LEVEL_OTHER * 2 - 1) & ~(1 << 4);
      return masks;
    }
  });

  it('does not touch its arguments', () => {
    const a = fullBox('monster', []);
    const cut = boxOf({ level: [4], def: '?' }, 'monster');
    const before = structuredClone([a, cut]);
    boxSubtract(a, cut);
    expect([a, cut]).toEqual(before);
  });

  it('yields disjoint non-empty pieces that hold exactly the points of a and not b', () => {
    const rng = seededRng(0xb0c50003);
    let inside = 0;
    let pieces = 0;
    for (let i = 0; i < 1500; i++) {
      const a = genMonsterBox(rng);
      const b = genMonsterBox(rng);
      const rest = boxSubtract(a, b);
      pieces += rest.length;
      same(rest.length <= a.masks.length + a.stats.length, true, () => ({ a, b }));
      same(rest.some(boxIsEmpty), false, () => ({ a, b }));
      for (let p = 0; p < 40; p++) {
        const point = genMonsterPoint(rng);
        const holders = rest.filter((box) => boxContains(box, point)).length;
        const expected = boxContains(a, point) && !boxContains(b, point);
        same(holders, expected ? 1 : 0, () => ({ a, b, point }));
        if (expected) inside++;
      }
    }
    expect(inside).toBeGreaterThan(1000);
    expect(pieces).toBeGreaterThan(1500);
  });
});

describe('subtractAll', () => {
  it('empties a range covered by two cuts that neither covers alone', () => {
    const whole = toBoxes(clauseDesc({ kinds: ['monster'], level: [1, 2, 3, 4, 5, 6] }), []);
    const halves = toBoxes(clauseDesc({ level: [1, 2, 3] }, { level: [4, 5, 6] }), []);
    expect(subtractAll(whole, halves)).toEqual([]);
    expect(subtractAll(whole, halves.slice(0, 1))).toEqual(
      toBoxes(clauseDesc({ level: [4, 5, 6] }), []),
    );
  });

  it('subtracts every cut, not only the first', () => {
    const all = KINDS.map((kind) => fullBox(kind, []));
    expect(subtractAll(all, all.slice(0, 2))).toEqual([fullBox('trap', [])]);
    expect(subtractAll(all, all)).toEqual([]);
  });

  it('returns the boxes unchanged when there is nothing to subtract', () => {
    const all = KINDS.map((kind) => fullBox(kind, []));
    expect(subtractAll(all, [])).toEqual(all);
  });

  it('holds exactly the points of the boxes that no cut holds', () => {
    const rng = seededRng(0xb0c50004);
    let inside = 0;
    for (let i = 0; i < 400; i++) {
      const boxes = [genMonsterBox(rng), genMonsterBox(rng)];
      const cuts = [genMonsterBox(rng), genMonsterBox(rng), genMonsterBox(rng)];
      const rest = subtractAll(boxes, cuts);
      for (let p = 0; p < 40; p++) {
        const point = genMonsterPoint(rng);
        const expected =
          boxes.some((box) => boxContains(box, point)) &&
          !cuts.some((box) => boxContains(box, point));
        same(
          rest.some((box) => boxContains(box, point)),
          expected,
          () => ({ boxes, cuts, point }),
        );
        if (expected) inside++;
      }
    }
    expect(inside).toBeGreaterThan(300);
  });
});
