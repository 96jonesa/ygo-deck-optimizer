import { describe, expect, it } from 'vitest';
import {
  type Clause,
  canonicalize,
  type Description,
  LEVEL_MAX,
  LEVEL_MIN,
  SETCODE_MAX,
} from '../../../src/core/desc/ast';

function canonicalClause(clause: Clause): Clause {
  const [alt] = canonicalize({ anyOf: [{ t: 'clause', clause }] }).anyOf;
  if (alt?.t !== 'clause') throw new Error('expected a clause');
  return alt.clause;
}

it('pins the Level and setcode domains', () => {
  expect([LEVEL_MIN, LEVEL_MAX, SETCODE_MAX]).toEqual([0, 13, 0xffff]);
});

describe('canonicalize', () => {
  it('sorts and de-duplicates the numeric lists', () => {
    expect(
      canonicalClause({
        level: [7, 3, 7, 1],
        archetypes: [0x2066, 0x66, 0x2066],
        attributes: { in: [0x20, 0x04, 0x20] },
        races: { notIn: [0x2000, 0x1, 0x2000] },
      }),
    ).toEqual({
      level: [1, 3, 7],
      archetypes: [0x66, 0x2066],
      attributes: { in: [0x04, 0x20] },
      races: { notIn: [0x1, 0x2000] },
    });
  });

  it('sorts numbers numerically, not as text', () => {
    expect(canonicalClause({ level: [10, 9, 2] }).level).toEqual([2, 9, 10]);
  });

  it('puts kinds, sub-kinds and flags in vocabulary order, once each', () => {
    const clause = canonicalClause({
      kinds: ['trap', 'monster', 'trap', 'spell'],
      stSubkinds: ['counter', 'normal', 'field', 'normal'],
      flags: { toon: true, normal: false, tuner: true },
    });
    expect(clause.kinds).toEqual(['monster', 'spell', 'trap']);
    expect(clause.stSubkinds).toEqual(['normal', 'field', 'counter']);
    expect(Object.entries(clause.flags!)).toEqual([
      ['normal', false],
      ['tuner', true],
      ['toon', true],
    ]);
  });

  it('omits every empty field', () => {
    expect(
      canonicalClause({
        kinds: [],
        flags: {},
        stSubkinds: [],
        attributes: { in: [] },
        races: { notIn: [] },
        level: [],
        archetypes: [],
      }),
    ).toEqual({});
    expect(canonicalClause({ flags: { tuner: undefined } })).toEqual({});
  });

  it('keeps a `false` flag: it is a constraint, not an absence', () => {
    expect(canonicalClause({ flags: { tuner: false } })).toEqual({ flags: { tuner: false } });
  });

  it('keeps stats, including `?` and an open range', () => {
    expect(canonicalClause({ atk: '?', def: { min: 0, max: null } })).toEqual({
      atk: '?',
      def: { min: 0, max: null },
    });
  });

  it('writes keys in one fixed order, so JSON text is a usable identity', () => {
    const a = canonicalize({
      anyOf: [
        {
          t: 'clause',
          clause: {
            archetypes: [1],
            def: { max: 5, min: 1 },
            atk: '?',
            level: [1],
            races: { in: [1] },
            attributes: { in: [1] },
            stSubkinds: ['normal'],
            flags: { tuner: true },
            kinds: ['spell'],
          },
        },
      ],
    });
    expect(JSON.stringify(a)).toBe(
      '{"anyOf":[{"t":"clause","clause":{"kinds":["spell"],"flags":{"tuner":true},"stSubkinds":["normal"],"attributes":{"in":[1]},"races":{"in":[1]},"level":[1],"atk":"?","def":{"min":1,"max":5},"archetypes":[1]}}]}',
    );
  });

  it('drops an alternative that equals an earlier one once both are canonical', () => {
    const desc: Description = {
      anyOf: [
        { t: 'clause', clause: { level: [4, 3] } },
        { t: 'card', passcode: 7 },
        { t: 'clause', clause: { level: [3, 4, 4], kinds: [] } },
        { t: 'group', groupId: 'g' },
        { t: 'card', passcode: 7 },
        { t: 'group', groupId: 'g' },
      ],
    };
    expect(canonicalize(desc)).toEqual({
      anyOf: [
        { t: 'clause', clause: { level: [3, 4] } },
        { t: 'card', passcode: 7 },
        { t: 'group', groupId: 'g' },
      ],
    });
  });

  it('keeps alternatives in written order', () => {
    const desc: Description = {
      anyOf: [
        { t: 'group', groupId: 'z' },
        { t: 'card', passcode: 9 },
        { t: 'card', passcode: 1 },
        { t: 'clause', clause: {} },
        { t: 'group', groupId: 'a' },
      ],
    };
    expect(canonicalize(desc)).toEqual(desc);
  });

  it('tells a card from a group with the same text', () => {
    const desc: Description = {
      anyOf: [
        { t: 'group', groupId: '7' },
        { t: 'card', passcode: 7 },
      ],
    };
    expect(canonicalize(desc).anyOf).toHaveLength(2);
  });

  it('is idempotent and does not touch its input', () => {
    const desc: Description = {
      anyOf: [{ t: 'clause', clause: { level: [4, 3], kinds: ['trap', 'spell'] } }],
    };
    const once = canonicalize(desc);
    expect(canonicalize(once)).toEqual(once);
    expect(desc.anyOf[0]).toEqual({
      t: 'clause',
      clause: { level: [4, 3], kinds: ['trap', 'spell'] },
    });
  });
});
