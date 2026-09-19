import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_DIVINE,
  ATTRIBUTE_FIRE,
  ATTRIBUTE_WATER,
  RACE_BEAST,
  RACE_BEASTWARRIOR,
  RACE_DRAGON,
  RACE_WARRIOR,
  RACE_WINGEDBEAST,
} from '../../../src/core/cards/constants';
import { CardIndex } from '../../../src/core/cards/index';
import type { Clause, Description } from '../../../src/core/desc/ast';
import { evaluate } from '../../../src/core/desc/evaluate';
import { parse } from '../../../src/core/desc/parser';
import {
  echo,
  formatArchetype,
  formatLevel,
  formatSetcode,
  formatStat,
  print,
} from '../../../src/core/desc/print';
import { contextOf, FakeGroups, SETNAMES } from '../../helpers/desc-context';
import { buildCdb, CODE, FIXTURE_ROWS, POPULATION } from '../../helpers/fixture-cards';
import { type GenPool, genDescription } from '../../helpers/gen-desc';
import { seededRng } from '../../helpers/prng';

const SQL = await initSqlJs();
const fixture = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, FIXTURE_ROWS) }]);
const ctx = contextOf(fixture);
const noSetnames = contextOf(fixture, { setnames: null });

function clause(c: Clause): Description {
  return { anyOf: [{ t: 'clause', clause: c }] };
}

describe('print', () => {
  it('closes every clause with its kind word, or with `card` when the kind is open', () => {
    expect(print(clause({ kinds: ['monster'] }), ctx)).toBe('monster');
    expect(print(clause({ kinds: ['spell', 'trap'] }), ctx)).toBe('spell/trap');
    expect(print(clause({ level: [4] }), ctx)).toBe('level 4 card');
    expect(print(clause({}), ctx)).toBe('card');
  });

  it('prints qualifiers in one fixed order, whatever order the keys are in', () => {
    const desc = clause({
      archetypes: [0x115],
      def: { min: 0, max: 2000 },
      atk: { min: 1500, max: null },
      level: [1, 2, 3, 4],
      races: { in: [RACE_WARRIOR] },
      attributes: { in: [ATTRIBUTE_FIRE] },
      flags: { tuner: false, effect: true },
      kinds: ['monster'],
    });
    expect(print(desc, ctx)).toBe(
      'level 1-4 ATK 1500 or more DEF 2000 or less FIRE Warrior effect non-tuner "Sky Striker":0x115 monster',
    );
  });

  it('prints value lists with `/` and negation with one leading `non-`', () => {
    expect(print(clause({ attributes: { in: [ATTRIBUTE_WATER, ATTRIBUTE_FIRE] } }), ctx)).toBe(
      'WATER/FIRE card',
    );
    expect(print(clause({ races: { notIn: [RACE_WARRIOR, RACE_DRAGON] } }), ctx)).toBe(
      'non-Warrior/Dragon card',
    );
  });

  it('spells multi-word Types as cards print them', () => {
    expect(print(clause({ races: { in: [RACE_WINGEDBEAST, RACE_BEASTWARRIOR] } }), ctx)).toBe(
      'Winged Beast/Beast-Warrior card',
    );
  });

  it('prints sub-kinds before the kind they belong to', () => {
    expect(print(clause({ kinds: ['spell'], stSubkinds: ['normal'] }), ctx)).toBe('normal spell');
    expect(
      print(clause({ kinds: ['spell', 'trap'], stSubkinds: ['quick-play', 'counter'] }), ctx),
    ).toBe('quick-play/counter spell/trap');
  });

  it('prints `?` stats', () => {
    expect(print(clause({ atk: '?', def: '?' }), ctx)).toBe('ATK ? DEF ? card');
  });

  it('always prints an archetype with its code, named by the first alternate', () => {
    expect(print(clause({ archetypes: [0x2066] }), ctx)).toBe('"Warrior":0x2066 card');
    expect(print(clause({ archetypes: [0x46, 0x66] }), ctx)).toBe(
      '"Polymerization":0x46 "Warrior":0x66 card',
    );
  });

  it('prints "?" for an archetype the table does not name', () => {
    expect(print(clause({ archetypes: [0x9999] }), ctx)).toBe('"?":0x9999 card');
  });

  it('prints "?" for an archetype whose name contains a quote and cannot be written', () => {
    expect(SETNAMES.nameOf(0x155a)).toContain('"');
    expect(print(clause({ archetypes: [0x155a] }), ctx)).toBe('"?":0x155a card');
  });

  it('prints "?" when the table would not resolve its own name back to the code', () => {
    const stale = { lookup: () => [0x1], nameOf: () => 'Stale', alternatesOf: () => ['Stale'] };
    const desc = clause({ archetypes: [0x115] });
    expect(print(desc, contextOf(fixture, { setnames: stale }))).toBe('"?":0x115 card');
  });

  it('prints "?" for every archetype when there is no setname table', () => {
    expect(print(clause({ archetypes: [0x115] }), noSetnames)).toBe('"?":0x115 card');
  });

  it('prints a card as its passcode, never its name', () => {
    expect(print({ anyOf: [{ t: 'card', passcode: CODE.ritualSoldier }] }, ctx)).toBe(
      `#${CODE.ritualSoldier}`,
    );
  });

  it('prints a group as its name in braces', () => {
    expect(print({ anyOf: [{ t: 'group', groupId: 'g-hand-traps' }] }, ctx)).toBe('{Hand Traps}');
  });

  it('prints {?} for a group it cannot name', () => {
    expect(print({ anyOf: [{ t: 'group', groupId: 'gone' }] }, ctx)).toBe('{?}');
    const braces = contextOf(fixture, { groups: new FakeGroups([['g1', 'a}b']]) });
    expect(print({ anyOf: [{ t: 'group', groupId: 'g1' }] }, braces)).toBe('{?}');
  });

  it('joins alternatives with `or`, in their own order', () => {
    const desc: Description = {
      anyOf: [
        { t: 'clause', clause: { kinds: ['trap'] } },
        { t: 'card', passcode: CODE.harpy },
        { t: 'clause', clause: { level: [0, 1, 2, 3, 4] } },
      ],
    };
    expect(print(desc, ctx)).toBe(`trap or #${CODE.harpy} or level 4 or lower card`);
  });

  // `DIVINE Beast` lexes as the Type Divine-Beast, so the printer swaps the two lists.
  it('prints Types before Attributes when DIVINE would run into Beast or Beast-Warrior', () => {
    for (const race of [RACE_BEAST, RACE_BEASTWARRIOR]) {
      const desc = clause({
        attributes: { in: [ATTRIBUTE_DARK, ATTRIBUTE_DIVINE] },
        races: { in: [race, 0x800000] },
      });
      const text = print(desc, ctx);
      expect(text).toMatch(/^Beast(-Warrior)?\/Wyrm DARK\/DIVINE card$/);
      expect(parse(text, ctx)).toEqual({ ok: true, desc });
    }
    const negated = clause({
      attributes: { notIn: [ATTRIBUTE_DIVINE] },
      races: { in: [RACE_BEAST] },
    });
    expect(print(negated, ctx)).toBe('Beast non-DIVINE card');
    expect(parse(print(negated, ctx), ctx)).toEqual({ ok: true, desc: negated });
  });

  it('keeps Attributes first when `non-` or another Type separates DIVINE from Beast', () => {
    const attributes = { in: [ATTRIBUTE_DIVINE] };
    expect(print(clause({ attributes, races: { notIn: [RACE_BEAST] } }), ctx)).toBe(
      'DIVINE non-Beast card',
    );
    expect(print(clause({ attributes, races: { in: [RACE_WARRIOR, RACE_BEAST] } }), ctx)).toBe(
      'DIVINE Warrior/Beast card',
    );
  });
});

describe('echo', () => {
  function echoOf(text: string): string {
    const result = parse(text, ctx);
    if (!result.ok) throw new Error(result.message);
    return echo(result.desc, ctx);
  }

  it('reads a clause back as its constraints, kind last', () => {
    expect(echoOf('level 4 monster')).toBe('Level 4 · Monster');
    expect(echoOf('FIRE/WATER beast-warrior monster')).toBe(
      'FIRE or WATER · Beast-Warrior · Monster',
    );
  });

  it('joins a sub-kind to its kind', () => {
    expect(echoOf('normal spell')).toBe('Normal Spell');
    expect(echoOf('continuous')).toBe('Continuous Spell or Trap');
    expect(echoOf('quick-play/counter')).toBe('Quick-Play or Counter Spell or Trap');
  });

  it('shows that a clause without a kind word says nothing about the kind', () => {
    expect(echoOf('level 4')).toBe('Level 4 · Card');
    expect(echoOf('card')).toBe('Any card');
  });

  it('reads flags, negation, stats and level ranges', () => {
    expect(echoOf('level 4 or lower non-tuner effect monster')).toBe(
      'Level 4 or lower · Effect · Non-Tuner · Monster',
    );
    expect(echoOf('ATK 1500 or less DEF ? monster')).toBe('ATK 1500 or less · DEF ? · Monster');
    expect(echoOf('non-FIRE monster')).toBe('Not FIRE · Monster');
    expect(echoOf('non-LIGHT/DARK/FIRE monster')).toBe('Neither DARK, FIRE nor LIGHT · Monster');
    expect(echoOf('Warrior/Dragon/Fairy monster')).toBe('Dragon, Fairy or Warrior · Monster');
  });

  it('names archetypes without their code, or by code when unnamed', () => {
    expect(echoOf('"Sky Striker" spell')).toBe('"Sky Striker" · Spell');
    expect(echoOf('"?":0x9999')).toBe('Archetype 0x9999 · Card');
    expect(echo(clause({ archetypes: [0x115] }), noSetnames)).toBe('Archetype 0x115 · Card');
  });

  it('reads a card back as its name, with the passcode when the name is shared', () => {
    expect(echoOf(`#${CODE.harpy}`)).toBe('Synthetic Harpy');
    expect(echoOf(`#${CODE.ritualSoldier}`)).toBe(
      `Synthetic Ritual Soldier (#${CODE.ritualSoldier})`,
    );
    expect(echo({ anyOf: [{ t: 'card', passcode: 5 }] }, ctx)).toBe('Unknown card #5');
  });

  it('reads a group back as its name', () => {
    expect(echoOf('{hand traps}')).toBe('Hand Traps');
    expect(echo({ anyOf: [{ t: 'group', groupId: 'gone' }] }, ctx)).toBe('Unknown group');
  });

  it('separates alternatives, each of which says only what it says', () => {
    expect(echoOf('level 4 or level 3 FIRE monster')).toBe(
      'Level 4 · Card, or Level 3 · FIRE · Monster',
    );
  });
});

describe('formatLevel', () => {
  it('prints a single level as itself, including the ends of the domain', () => {
    expect(formatLevel([4])).toBe('4');
    expect(formatLevel([0])).toBe('0');
    expect(formatLevel([13])).toBe('13');
  });

  it('prints a run from the lowest level as "or lower"', () => {
    expect(formatLevel([0, 1, 2, 3, 4])).toBe('4 or lower');
    expect(formatLevel([0, 1])).toBe('1 or lower');
  });

  it('prints a run to the highest level as "or higher"', () => {
    expect(formatLevel([8, 9, 10, 11, 12, 13])).toBe('8 or higher');
    expect(formatLevel([12, 13])).toBe('12 or higher');
  });

  it('prints the whole domain as "13 or lower"', () => {
    expect(formatLevel([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])).toBe('13 or lower');
  });

  it('prints an inner run as a range', () => {
    expect(formatLevel([1, 2, 3, 4])).toBe('1-4');
    expect(formatLevel([3, 4])).toBe('3-4');
    expect(formatLevel([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe('1-12');
  });

  it('prints anything with a gap as a list', () => {
    expect(formatLevel([3, 5])).toBe('3/5');
    expect(formatLevel([0, 1, 2, 4])).toBe('0/1/2/4');
    expect(formatLevel([1, 12, 13])).toBe('1/12/13');
  });
});

describe('formatStat', () => {
  it('prints each shape of constraint', () => {
    expect(formatStat('?')).toBe('?');
    expect(formatStat({ min: 1500, max: 1500 })).toBe('1500');
    expect(formatStat({ min: 0, max: 1500 })).toBe('1500 or less');
    expect(formatStat({ min: 1500, max: null })).toBe('1500 or more');
    expect(formatStat({ min: 1000, max: 2000 })).toBe('1000-2000');
  });

  it('prefers the exact and the unbounded forms at zero', () => {
    expect(formatStat({ min: 0, max: 0 })).toBe('0');
    expect(formatStat({ min: 0, max: null })).toBe('0 or more');
  });
});

describe('formatSetcode', () => {
  it('prints lower-case unpadded hex', () => {
    expect(formatSetcode(0x2066)).toBe('0x2066');
    expect(formatSetcode(0xabc)).toBe('0xabc');
    expect(formatSetcode(0x66)).toBe('0x66');
  });
});

describe('formatArchetype', () => {
  it('quotes the name and appends the code', () => {
    expect(formatArchetype('Warrior', 0x2066)).toBe('"Warrior":0x2066');
  });

  it('writes "?" for a missing name', () => {
    expect(formatArchetype(undefined, 0x9999)).toBe('"?":0x9999');
  });
});

describe('parse/print round trip', () => {
  const pool: GenPool = {
    passcodes: POPULATION,
    groupIds: ['g-starters', 'g-hand-traps'],
    // Named, ambiguous ("Warrior", "Magnet"), two alternates, unquotable, unknown.
    setcodes: [0x46, 0x66, 0x115, 0x534, 0x1066, 0x155a, 0x2066, 0x3066, 0x9999, 0xabc],
  };
  const groups = new Map([
    ['g-starters', new Set<number>([CODE.tunerFairy, CODE.quickSpell, CODE.harpy])],
    ['g-hand-traps', new Set<number>([CODE.counterTrap])],
  ]);

  it('parses the canonical text of 3,000 generated descriptions back to the same AST', () => {
    const rng = seededRng(0x5eed0001);
    for (let i = 0; i < 3000; i++) {
      const desc = genDescription(rng, pool);
      const text = print(desc, ctx);
      const result = parse(text, ctx);
      expect(result, `case ${i}: ${text}`).toEqual({ ok: true, desc });
      // Deep equality ignores key order; the canonical form does not.
      if (result.ok) expect(JSON.stringify(result.desc), text).toBe(JSON.stringify(desc));
    }
  });

  it('round-trips without a setname table, every archetype written by code', () => {
    const rng = seededRng(0x5eed0002);
    for (let i = 0; i < 1000; i++) {
      const desc = genDescription(rng, pool);
      const text = print(desc, noSetnames);
      expect(parse(text, noSetnames), `case ${i}: ${text}`).toEqual({ ok: true, desc });
    }
  });

  it('prints a parsed description to text that is a fixed point', () => {
    const rng = seededRng(0x5eed0003);
    for (let i = 0; i < 500; i++) {
      const text = print(genDescription(rng, pool), ctx);
      const result = parse(text, ctx);
      expect(result.ok && print(result.desc, ctx)).toBe(text);
    }
  });

  it('evaluates the same before and after the trip, on every fixture card', () => {
    const rng = seededRng(0x5eed0004);
    const cards = [...fixture.all()];
    let matches = 0;
    for (let i = 0; i < 2000; i++) {
      const desc = genDescription(rng, pool);
      const result = parse(print(desc, ctx), ctx);
      if (!result.ok) throw new Error(`case ${i}: ${result.message}`);
      for (const card of cards) {
        const expected = evaluate(desc, card, groups);
        expect(evaluate(result.desc, card, groups)).toBe(expected);
        if (expected) matches++;
      }
    }
    // The generator must not be producing only unsatisfiable descriptions.
    expect(matches).toBeGreaterThan(2000);
  });

  it('exercises every shape the generator is meant to cover', () => {
    const rng = seededRng(0x5eed0001);
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++)
      for (const alt of genDescription(rng, pool).anyOf) {
        seen.add(alt.t);
        if (alt.t !== 'clause') continue;
        const c = alt.clause;
        for (const key of Object.keys(c)) seen.add(key);
        if (c.kinds === undefined) seen.add('no kinds');
        if (c.flags?.normal === true) seen.add(c.kinds ? 'normal monster' : 'bare normal flag');
        if (c.flags?.ritual === false) seen.add('non-ritual');
        if (c.atk === '?') seen.add('atk ?');
        if (c.attributes && 'notIn' in c.attributes) seen.add('notIn');
        if (c.stSubkinds?.includes('normal')) seen.add('normal sub-kind');
      }
    expect([...seen].sort()).toEqual(
      [
        'archetypes',
        'atk',
        'atk ?',
        'attributes',
        'bare normal flag',
        'card',
        'clause',
        'def',
        'flags',
        'group',
        'kinds',
        'level',
        'no kinds',
        'non-ritual',
        'normal monster',
        'normal sub-kind',
        'notIn',
        'races',
        'stSubkinds',
      ].sort(),
    );
  });
});
