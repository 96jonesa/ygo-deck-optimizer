import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_FIRE,
  ATTRIBUTE_LIGHT,
  RACE_DRAGON,
  RACE_WARRIOR,
  TYPE_CONTINUOUS,
  TYPE_COUNTER,
  TYPE_EFFECT,
  TYPE_EQUIP,
  TYPE_FIELD,
  TYPE_FUSION,
  TYPE_LINK,
  TYPE_MONSTER,
  TYPE_QUICKPLAY,
  TYPE_RITUAL,
  TYPE_SPELL,
  TYPE_SYNCHRO,
  TYPE_TRAP,
  TYPE_TRAPMONSTER,
  TYPE_TUNER,
  TYPE_XYZ,
} from '../../../src/core/cards/constants';
import { CardIndex } from '../../../src/core/cards/index';
import type { CardRecord } from '../../../src/core/cards/record';
import type { Clause, Description } from '../../../src/core/desc/ast';
import { evaluate, type Groups, matcher } from '../../../src/core/desc/evaluate';
import { parse } from '../../../src/core/desc/parser';
import { cardRecord, contextOf } from '../../helpers/desc-context';
import { buildCdb, CODE, FIXTURE_ROWS, POPULATION } from '../../helpers/fixture-cards';

const SQL = await initSqlJs();
const fixture = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, FIXTURE_ROWS) }]);
const ctx = contextOf(fixture);
const NO_GROUPS: Groups = new Map();
const GROUPS: Groups = new Map([
  ['g-starters', new Set([CODE.tunerFairy, CODE.quickSpell])],
  ['g-hand-traps', new Set<number>()],
]);

type FixtureName = keyof typeof CODE;
const NAME_OF = new Map<number, FixtureName>(
  Object.entries(CODE).map(([name, code]) => [code, name as FixtureName]),
);
const MONSTERS: FixtureName[] = [
  'vanillaDragon',
  'tunerFairy',
  'ritualSoldier',
  'asymmetricPendulum',
  'fourSetcodes',
  'gappedSetcodes',
  'unknownAtk',
  'highRace',
  'negativeLevel',
  'sameNameDifferentCard',
  'harpy',
  'treatedAsHarpy',
  'orphanAlias',
  'prerelease',
];
const SPELLS: FixtureName[] = ['quickSpell', 'linkSpell', 'sea', 'treatedAsSea'];
const TRAPS: FixtureName[] = ['counterTrap'];

function descOf(text: string): Description {
  const result = parse(text, ctx);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.desc;
}

function clause(c: Clause): Description {
  return { anyOf: [{ t: 'clause', clause: c }] };
}

/** The fixture cards `text` matches, by the name of the trap each one sets. */
function matching(text: string): FixtureName[] {
  const test = matcher(descOf(text), GROUPS);
  return [...fixture.all()]
    .filter(test)
    .map((card) => NAME_OF.get(card.code)!)
    .sort();
}

function sorted(...names: (FixtureName | FixtureName[])[]): FixtureName[] {
  return names.flat().sort();
}

function without(names: FixtureName[], ...drop: FixtureName[]): FixtureName[] {
  return names.filter((name) => !drop.includes(name));
}

function matches(text: string, card: CardRecord): boolean {
  return evaluate(descOf(text), card, NO_GROUPS);
}

const monster = (overrides: Partial<CardRecord> = {}) =>
  cardRecord({ type: TYPE_MONSTER | TYPE_EFFECT, ...overrides });
const spell = (subkind = 0, overrides: Partial<CardRecord> = {}) =>
  cardRecord({
    type: TYPE_SPELL | subkind,
    atk: 0,
    def: 0,
    level: 0,
    race: 0,
    attribute: 0,
    ...overrides,
  });
const trap = (subkind = 0, overrides: Partial<CardRecord> = {}) =>
  cardRecord({
    type: TYPE_TRAP | subkind,
    atk: 0,
    def: 0,
    level: 0,
    race: 0,
    attribute: 0,
    ...overrides,
  });

describe('evaluate', () => {
  it('covers a fixture with all three kinds', () => {
    expect(sorted(MONSTERS, SPELLS, TRAPS)).toEqual(POPULATION.map((c) => NAME_OF.get(c)!).sort());
  });

  describe('against the fixture database', () => {
    it('tells the kinds apart, and `card` matches everything', () => {
      expect(matching('monster')).toEqual(sorted(MONSTERS));
      expect(matching('spell')).toEqual(sorted(SPELLS));
      expect(matching('trap')).toEqual(sorted(TRAPS));
      expect(matching('spell/trap')).toEqual(sorted(SPELLS, TRAPS));
      expect(matching('card')).toEqual(sorted(MONSTERS, SPELLS, TRAPS));
    });

    it('matches levels', () => {
      expect(matching('level 8 monster')).toEqual(
        sorted('vanillaDragon', 'ritualSoldier', 'sameNameDifferentCard'),
      );
      expect(matching('level 3/10')).toEqual(sorted('tunerFairy', 'unknownAtk'));
      expect(matching('level 5 or higher')).toEqual(
        sorted('vanillaDragon', 'ritualSoldier', 'sameNameDifferentCard', 'unknownAtk'),
      );
      // Level -3 (a decoding curiosity) is in no level set.
      expect(matching('level 13 or lower')).toEqual(sorted(without(MONSTERS, 'negativeLevel')));
    });

    it('matches flags, and their negation on every kind', () => {
      expect(matching('tuner')).toEqual(['tunerFairy']);
      expect(matching('ritual monster')).toEqual(['ritualSoldier']);
      expect(matching('pendulum')).toEqual(['asymmetricPendulum']);
      expect(matching('non-tuner monster')).toEqual(sorted(without(MONSTERS, 'tunerFairy')));
      expect(matching('non-tuner')).toEqual(sorted(without(MONSTERS, 'tunerFairy'), SPELLS, TRAPS));
      expect(matching('effect non-tuner non-pendulum non-ritual monster')).toEqual(
        sorted('unknownAtk', 'treatedAsHarpy'),
      );
    });

    it('matches sub-kinds', () => {
      expect(matching('quick-play')).toEqual(['quickSpell']);
      expect(matching('field spell')).toEqual(sorted('sea', 'treatedAsSea'));
      expect(matching('counter')).toEqual(['counterTrap']);
      // A Link Spell has none of the six sub-kind bits.
      expect(matching('normal spell')).toEqual(['linkSpell']);
      expect(matching('normal/field spell')).toEqual(sorted('linkSpell', 'sea', 'treatedAsSea'));
      expect(matching('continuous')).toEqual([]);
      expect(matching('normal trap')).toEqual([]);
    });

    it('matches Attributes and Types, and their negation on every kind', () => {
      expect(matching('LIGHT')).toEqual(sorted('vanillaDragon', 'tunerFairy'));
      expect(matching('LIGHT/WIND monster')).toEqual(
        sorted('vanillaDragon', 'tunerFairy', 'harpy', 'treatedAsHarpy'),
      );
      expect(matching('Winged Beast')).toEqual(sorted('harpy', 'treatedAsHarpy'));
      expect(matching('Spellcaster')).toEqual(sorted('asymmetricPendulum', 'highRace'));
      expect(matching('LIGHT Dragon')).toEqual(['vanillaDragon']);
      expect(matching('non-EARTH/LIGHT/DARK')).toEqual(
        sorted('harpy', 'treatedAsHarpy', 'orphanAlias', SPELLS, TRAPS),
      );
      expect(matching('non-Warrior monster')).toEqual(
        sorted(
          'vanillaDragon',
          'tunerFairy',
          'asymmetricPendulum',
          'unknownAtk',
          'highRace',
          'harpy',
          'treatedAsHarpy',
        ),
      );
    });

    it('matches ATK and DEF, and never lets a range match `?`', () => {
      expect(matching('ATK 3000 or more')).toEqual(
        sorted('vanillaDragon', 'ritualSoldier', 'sameNameDifferentCard'),
      );
      expect(matching('ATK 1300-1800')).toEqual(
        sorted('asymmetricPendulum', 'harpy', 'treatedAsHarpy'),
      );
      expect(matching('DEF 1800')).toEqual(['tunerFairy']);
      expect(matching('ATK ?')).toEqual(['unknownAtk']);
      expect(matching('DEF ?')).toEqual(['unknownAtk']);
      expect(matching('ATK 1500 or less')).not.toContain('unknownAtk');
      expect(matching('ATK 0 or more')).toEqual(sorted(without(MONSTERS, 'unknownAtk')));
      expect(matching('DEF 0 or more')).toEqual(sorted(without(MONSTERS, 'unknownAtk')));
    });

    it('matches archetypes through the setcodes resolved from the alias target', () => {
      expect(matching('"Harpie"')).toEqual(sorted('harpy', 'treatedAsHarpy'));
      expect(matching('"Blue-Eyes"')).toEqual(sorted('vanillaDragon', 'fourSetcodes'));
      expect(matching('"Warrior":0x2066')).toEqual(['fourSetcodes']);
      expect(matching('"?":0x10cf')).toEqual(sorted('ritualSoldier', 'sameNameDifferentCard'));
      expect(matching('"?":0xcf')).toEqual(sorted('ritualSoldier', 'sameNameDifferentCard'));
      expect(matching('"?":0x1234 "?":0xabc')).toEqual(['gappedSetcodes']);
      expect(matching('"?":0x1234 "Blue-Eyes"')).toEqual([]);
    });

    it('matches a card alternative by its own code, not by name or limit code', () => {
      expect(matching(`#${CODE.ritualSoldier}`)).toEqual(['ritualSoldier']);
      expect(matching(`#${CODE.harpy}`)).toEqual(['harpy']);
    });

    it('matches a group alternative by membership', () => {
      expect(matching('{Starters}')).toEqual(sorted('tunerFairy', 'quickSpell'));
      expect(matching('{Hand Traps}')).toEqual([]);
    });

    it('matches a description when any alternative does', () => {
      expect(matching(`counter or {Starters} or #${CODE.sea} or level 10`)).toEqual(
        sorted('counterTrap', 'tunerFairy', 'quickSpell', 'sea', 'unknownAtk'),
      );
    });

    it('requires every constraint of a clause', () => {
      expect(matching('level 4 WIND Winged Beast effect monster ATK 1800 "Harpie"')).toEqual([
        'treatedAsHarpy',
      ]);
      expect(matching('level 4 spell')).toEqual([]);
    });
  });

  describe('Level, Rank and Link Rating', () => {
    it('treats Level as undefined for an Xyz monster, whose column holds a Rank', () => {
      const xyz = monster({ type: TYPE_MONSTER | TYPE_EFFECT | TYPE_XYZ, level: 4 });
      expect(matches('level 4', xyz)).toBe(false);
      expect(matches('level 13 or lower', xyz)).toBe(false);
      expect(matches('monster', xyz)).toBe(true);
    });

    it('treats Level as undefined for a Link monster, whose column holds a Link Rating', () => {
      const link = monster({ type: TYPE_MONSTER | TYPE_EFFECT | TYPE_LINK, level: 2 });
      expect(matches('level 2', link)).toBe(false);
      expect(matches('ATK 1000 monster', link)).toBe(true);
    });

    it('keeps Level for the other Extra Deck monsters', () => {
      expect(matches('level 6', monster({ type: TYPE_MONSTER | TYPE_FUSION, level: 6 }))).toBe(
        true,
      );
      expect(matches('level 7', monster({ type: TYPE_MONSTER | TYPE_SYNCHRO, level: 7 }))).toBe(
        true,
      );
    });

    it('never gives a Spell or Trap a Level, whatever the column holds', () => {
      expect(matches('level 4', spell(0, { level: 4 }))).toBe(false);
      expect(matches('level 0', trap())).toBe(false);
    });
  });

  describe('ATK and DEF', () => {
    it('treats DEF as undefined for a Link monster, whose column holds link markers', () => {
      const link = monster({ type: TYPE_MONSTER | TYPE_EFFECT | TYPE_LINK, def: 0xa5 });
      expect(matches('DEF 200 or less', link)).toBe(false);
      expect(matches('DEF 165', link)).toBe(false);
      expect(matches('DEF ?', { ...link, def: -2 })).toBe(false);
      expect(matches('DEF 165', monster({ def: 0xa5 }))).toBe(true);
    });

    it('matches `?` only against the stored -2', () => {
      expect(matches('ATK ?', monster({ atk: -2 }))).toBe(true);
      expect(matches('ATK ?', monster({ atk: -1 }))).toBe(false);
      expect(matches('ATK ?', monster({ atk: 0 }))).toBe(false);
    });

    it('never matches a negative stored value with a range, even a range that reaches below 0', () => {
      const unknown = monster({ atk: -2, def: -2 });
      expect(matches('ATK 1500 or less', unknown)).toBe(false);
      expect(matches('ATK 0 or more', unknown)).toBe(false);
      const below = clause({ atk: { min: -10, max: 5000 }, def: { min: -10, max: null } });
      expect(evaluate(below, unknown, NO_GROUPS)).toBe(false);
      expect(evaluate(below, monster({ atk: 0, def: 0 }), NO_GROUPS)).toBe(true);
    });

    it('includes both ends of a range', () => {
      for (const [atk, expected] of [
        [999, false],
        [1000, true],
        [2000, true],
        [2001, false],
      ] as const)
        expect(matches('ATK 1000-2000', monster({ atk })), `${atk}`).toBe(expected);
      expect(matches('ATK 1500 or less', monster({ atk: 1500 }))).toBe(true);
      expect(matches('ATK 1500 or less', monster({ atk: 1501 }))).toBe(false);
      expect(matches('ATK 1500 or more', monster({ atk: 1500 }))).toBe(true);
      expect(matches('ATK 1500 or more', monster({ atk: 1499 }))).toBe(false);
    });

    it('never gives a Spell or Trap an ATK or DEF, whatever the columns hold', () => {
      const trapMonster = trap(TYPE_CONTINUOUS | TYPE_TRAPMONSTER, { atk: 1000, def: -2 });
      expect(matches('ATK 1000', trapMonster)).toBe(false);
      expect(matches('DEF ?', trapMonster)).toBe(false);
      expect(matches('ATK 0', spell())).toBe(false);
    });
  });

  // TDD §6.1 axioms 1 and 2.
  describe('monster-only dimensions on Spells and Traps', () => {
    const fireWarriorSpell = spell(TYPE_RITUAL, { attribute: ATTRIBUTE_FIRE, race: RACE_WARRIOR });

    it('makes a positive constraint false, whatever the columns hold', () => {
      expect(matches('FIRE', fireWarriorSpell)).toBe(false);
      expect(matches('Warrior', fireWarriorSpell)).toBe(false);
      expect(matches('tuner', spell(TYPE_TUNER))).toBe(false);
      expect(evaluate(clause({ flags: { ritual: true } }), fireWarriorSpell, NO_GROUPS)).toBe(
        false,
      );
    });

    it('makes a negative constraint true, whatever the columns hold', () => {
      expect(matches('non-FIRE', fireWarriorSpell)).toBe(true);
      expect(matches('non-Warrior', fireWarriorSpell)).toBe(true);
      expect(matches('non-ritual', fireWarriorSpell)).toBe(true);
      expect(matches('non-tuner', trap(TYPE_COUNTER))).toBe(true);
      expect(matches('non-effect non-FIRE non-Dragon', trap())).toBe(true);
    });

    it('applies negative constraints to monsters as written', () => {
      const fireTuner = monster({ type: TYPE_MONSTER | TYPE_TUNER, attribute: ATTRIBUTE_FIRE });
      expect(matches('non-tuner', fireTuner)).toBe(false);
      expect(matches('non-FIRE', fireTuner)).toBe(false);
      expect(matches('non-WATER non-Dragon non-ritual', fireTuner)).toBe(true);
    });
  });

  describe('value lists', () => {
    const lightDark = monster({ attribute: ATTRIBUTE_LIGHT | ATTRIBUTE_DARK, race: RACE_DRAGON });

    it('matches `in` when any listed bit is set', () => {
      expect(matches('LIGHT', lightDark)).toBe(true);
      expect(matches('DARK/FIRE', lightDark)).toBe(true);
      expect(matches('FIRE/WATER', lightDark)).toBe(false);
    });

    it('matches `notIn` only when none of the listed bits is set', () => {
      expect(matches('non-FIRE/WATER', lightDark)).toBe(true);
      expect(matches('non-FIRE/DARK', lightDark)).toBe(false);
      expect(matches('non-Dragon/Warrior', lightDark)).toBe(false);
    });

    it('matches the highest official Type bit', () => {
      expect(matches('Illusion', monster({ race: 0x2000000 }))).toBe(true);
      expect(matches('Illusion', monster({ race: 0x1000000 }))).toBe(false);
    });

    it('treats an empty list as no constraint', () => {
      const empty = clause({ kinds: [], level: [], stSubkinds: [], attributes: { in: [] } });
      expect(evaluate(empty, spell(), NO_GROUPS)).toBe(true);
      expect(evaluate(clause({ races: { notIn: [] } }), lightDark, NO_GROUPS)).toBe(true);
    });
  });

  describe('sub-kinds', () => {
    it('reads "normal" as none of the six sub-kind bits', () => {
      expect(matches('normal spell', spell())).toBe(true);
      expect(matches('normal trap', trap())).toBe(true);
      for (const bit of [TYPE_QUICKPLAY, TYPE_CONTINUOUS, TYPE_EQUIP, TYPE_FIELD, TYPE_RITUAL])
        expect(matches('normal spell', spell(bit)), `0x${bit.toString(16)}`).toBe(false);
      expect(matches('normal trap', trap(TYPE_COUNTER))).toBe(false);
      expect(matches('normal trap', trap(TYPE_CONTINUOUS))).toBe(false);
    });

    it('ignores bits that are not sub-kinds when deciding "normal"', () => {
      expect(matches('normal spell', spell(TYPE_LINK))).toBe(true);
    });

    it('matches each sub-kind by its bit', () => {
      expect(matches('quick-play', spell(TYPE_QUICKPLAY))).toBe(true);
      expect(matches('equip', spell(TYPE_EQUIP))).toBe(true);
      expect(matches('field', spell(TYPE_FIELD))).toBe(true);
      expect(matches('ritual spell', spell(TYPE_RITUAL))).toBe(true);
      expect(matches('counter', trap(TYPE_COUNTER))).toBe(true);
      expect(matches('equip', spell(TYPE_FIELD))).toBe(false);
    });

    it('matches `continuous` alone against Spells and Traps alike', () => {
      expect(matches('continuous', spell(TYPE_CONTINUOUS))).toBe(true);
      expect(matches('continuous', trap(TYPE_CONTINUOUS))).toBe(true);
      expect(matches('continuous spell', trap(TYPE_CONTINUOUS))).toBe(false);
      expect(matches('continuous', spell())).toBe(false);
    });

    it('keeps "normal spell" and "normal trap" apart', () => {
      expect(matches('normal spell', trap())).toBe(false);
      expect(matches('normal trap', spell())).toBe(false);
      expect(matches('normal spell/trap', trap())).toBe(true);
    });

    it('never matches a monster, not even a Ritual Monster against "ritual"', () => {
      const ritual = monster({ type: TYPE_MONSTER | TYPE_RITUAL });
      expect(evaluate(clause({ stSubkinds: ['ritual'] }), ritual, NO_GROUPS)).toBe(false);
      expect(evaluate(clause({ stSubkinds: ['normal'] }), monster(), NO_GROUPS)).toBe(false);
      expect(matches('ritual monster', ritual)).toBe(true);
    });

    it('only finds a sub-kind on a kind it exists for', () => {
      const desc = clause({ kinds: ['spell', 'trap'], stSubkinds: ['counter'] });
      expect(evaluate(desc, trap(TYPE_COUNTER), NO_GROUPS)).toBe(true);
      expect(evaluate(desc, spell(TYPE_COUNTER), NO_GROUPS)).toBe(false);
    });
  });

  // TDD §4.1: low 12 bits equal, and the card's high nibble a superset of the query's.
  describe('archetypes', () => {
    const magnet = monster({ setcodes: [0x1066] });
    const warrior = monster({ setcodes: [0x2066] });
    const magnetWarrior = monster({ setcodes: [0x3066] });
    const archetype = (code: number) => clause({ archetypes: [code] });

    it('matches a sub-archetype card with the query of either parent, and of the base', () => {
      for (const query of [0x66, 0x1066, 0x2066, 0x3066])
        expect(
          evaluate(archetype(query), magnetWarrior, NO_GROUPS),
          `0x${query.toString(16)}`,
        ).toBe(true);
    });

    it('does not match a parent card with the query of the sub-archetype: the rule is asymmetric', () => {
      expect(evaluate(archetype(0x3066), magnet, NO_GROUPS)).toBe(false);
      expect(evaluate(archetype(0x3066), warrior, NO_GROUPS)).toBe(false);
      expect(evaluate(archetype(0x1066), magnetWarrior, NO_GROUPS)).toBe(true);
      expect(evaluate(archetype(0x2066), magnetWarrior, NO_GROUPS)).toBe(true);
    });

    it('tells the two siblings apart, and matches both with the base', () => {
      expect(evaluate(archetype(0x1066), magnet, NO_GROUPS)).toBe(true);
      expect(evaluate(archetype(0x1066), warrior, NO_GROUPS)).toBe(false);
      expect(evaluate(archetype(0x2066), magnet, NO_GROUPS)).toBe(false);
      expect(evaluate(archetype(0x66), magnet, NO_GROUPS)).toBe(true);
      expect(evaluate(archetype(0x1066), monster({ setcodes: [0x66] }), NO_GROUPS)).toBe(false);
    });

    it('requires every listed archetype, each from any of the card codes', () => {
      const both = clause({ archetypes: [0x1066, 0x2066] });
      expect(evaluate(both, magnetWarrior, NO_GROUPS)).toBe(true);
      expect(evaluate(both, monster({ setcodes: [0xdd, 0x2066, 0x1066] }), NO_GROUPS)).toBe(true);
      expect(evaluate(both, magnet, NO_GROUPS)).toBe(false);
      expect(evaluate(both, monster({ setcodes: [] }), NO_GROUPS)).toBe(false);
    });

    it('applies to Spells and Traps too', () => {
      expect(evaluate(archetype(0x115), spell(0, { setcodes: [0x1115] }), NO_GROUPS)).toBe(true);
    });
  });

  describe('cards and groups', () => {
    it('matches a card alternative on the code alone', () => {
      const desc: Description = { anyOf: [{ t: 'card', passcode: 5 }] };
      expect(evaluate(desc, cardRecord({ code: 5 }), NO_GROUPS)).toBe(true);
      expect(evaluate(desc, cardRecord({ code: 6, limitCode: 5 }), NO_GROUPS)).toBe(false);
    });

    it('matches a group alternative on membership, and an unknown group never', () => {
      const desc: Description = { anyOf: [{ t: 'group', groupId: 'g' }] };
      const groups: Groups = new Map([['g', new Set([5])]]);
      expect(evaluate(desc, cardRecord({ code: 5 }), groups)).toBe(true);
      expect(evaluate(desc, cardRecord({ code: 6 }), groups)).toBe(false);
      expect(evaluate(desc, cardRecord({ code: 5 }), NO_GROUPS)).toBe(false);
    });

    it('matches nothing with no alternatives', () => {
      expect(evaluate({ anyOf: [] }, cardRecord(), NO_GROUPS)).toBe(false);
    });
  });
});

describe('matcher', () => {
  it('agrees with evaluate on every fixture card, and can be reused', () => {
    for (const text of ['level 4 non-tuner monster or {Starters}', 'continuous or ATK ?', 'card']) {
      const desc = descOf(text);
      const test = matcher(desc, GROUPS);
      for (const card of [...fixture.all(), ...fixture.all()])
        expect(test(card), `${text}: ${card.name}`).toBe(evaluate(desc, card, GROUPS));
    }
  });

  it('matches a bare clause with no constraints against anything', () => {
    expect(matcher(clause({}), NO_GROUPS)(cardRecord())).toBe(true);
  });
});
