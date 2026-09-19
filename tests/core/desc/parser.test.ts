import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_FIRE,
  ATTRIBUTE_LIGHT,
  ATTRIBUTE_WATER,
  RACE_BEASTWARRIOR,
  RACE_DRAGON,
  RACE_WARRIOR,
  RACE_WINGEDBEAST,
} from '../../../src/core/cards/constants';
import { CardIndex } from '../../../src/core/cards/index';
import {
  ATTRIBUTE_VOCABULARY,
  MONSTER_FLAGS,
  RACE_VOCABULARY,
  ST_SUBKIND_VOCABULARY,
} from '../../../src/core/cards/vocabulary';
import { type Clause, canonicalize, type Description } from '../../../src/core/desc/ast';
import { lex } from '../../../src/core/desc/lexer';
import { parse, parseTokens } from '../../../src/core/desc/parser';
import { cardRecord, contextOf, FakeCards, FakeGroups } from '../../helpers/desc-context';
import { buildCdb, CODE, FIXTURE_ROWS } from '../../helpers/fixture-cards';
import { seededRng } from '../../helpers/prng';

const SQL = await initSqlJs();
const fixture = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, FIXTURE_ROWS) }]);
const ctx = contextOf(fixture);
const noSetnames = contextOf(fixture, { setnames: null });

function descOf(text: string, context = ctx): Description {
  const result = parse(text, context);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.desc;
}

/** The single clause `text` parses to. */
function clauseOf(text: string, context = ctx): Clause {
  const { anyOf } = descOf(text, context);
  if (anyOf.length !== 1 || anyOf[0]!.t !== 'clause') throw new Error(`${text}: not one clause`);
  return anyOf[0]!.clause;
}

/** The error `text` fails with, and the slice of `text` its span covers. */
function failureOf(text: string, context = ctx): { message: string; at: string } {
  const result = parse(text, context);
  if (result.ok) throw new Error(`${text}: parsed, expected an error`);
  return { message: result.message, at: text.slice(result.span.start, result.span.end) };
}

function range(low: number, high: number): number[] {
  return Array.from({ length: high - low + 1 }, (_, i) => low + i);
}

describe('parse', () => {
  describe('kind words', () => {
    it('records the kind word, and nothing for `card`', () => {
      expect(clauseOf('monster')).toEqual({ kinds: ['monster'] });
      expect(clauseOf('Spell')).toEqual({ kinds: ['spell'] });
      expect(clauseOf('TRAP')).toEqual({ kinds: ['trap'] });
      expect(clauseOf('card')).toEqual({});
    });

    it('accepts plurals and a trailing `card`', () => {
      expect(clauseOf('level 4 monsters')).toEqual({ kinds: ['monster'], level: [4] });
      expect(clauseOf('spell card')).toEqual({ kinds: ['spell'] });
      expect(clauseOf('trap cards')).toEqual({ kinds: ['trap'] });
    });

    it('reads a `/` list of kinds, in canonical order', () => {
      expect(clauseOf('spell/trap')).toEqual({ kinds: ['spell', 'trap'] });
      expect(clauseOf('trap/monster card')).toEqual({ kinds: ['monster', 'trap'] });
      expect(clauseOf('spell/spell')).toEqual({ kinds: ['spell'] });
    });

    it('keeps all three kinds as written rather than dropping the constraint', () => {
      expect(clauseOf('monster/spell/trap')).toEqual({ kinds: ['monster', 'spell', 'trap'] });
    });

    it('accepts the kind word anywhere in the clause', () => {
      expect(clauseOf('monster level 4 FIRE')).toEqual(clauseOf('level 4 FIRE monster'));
    });

    it('applies no game rule: a level does not make the clause a monster', () => {
      expect(clauseOf('level 4')).toEqual({ level: [4] });
      expect(clauseOf('level 4 spell')).toEqual({ kinds: ['spell'], level: [4] });
    });

    it('rejects a second kind word, suggesting the list form', () => {
      expect(failureOf('spell trap')).toEqual({
        message: 'the kind is given twice in this clause; write `spell/trap` for either',
        at: 'trap',
      });
      expect(failureOf('card spell').at).toBe('spell');
    });

    it('rejects a `/` that no kind follows', () => {
      expect(failureOf('spell/FIRE')).toEqual({
        message: 'expected monster, spell or trap after `/`',
        at: 'FIRE',
      });
      expect(failureOf('spell/').at).toBe('');
    });
  });

  describe('monster flags', () => {
    it('records every flag as required, and as excluded after `non-`', () => {
      for (const flag of MONSTER_FLAGS) {
        expect(clauseOf(`${flag} monster`), flag).toEqual({
          kinds: ['monster'],
          flags: { [flag]: true },
        });
        expect(clauseOf(`non-${flag} monster`), flag).toEqual({
          kinds: ['monster'],
          flags: { [flag]: false },
        });
      }
    });

    it('combines several flags, in canonical key order', () => {
      const clause = clauseOf('toon non-tuner effect monster');
      expect(clause.flags).toEqual({ effect: true, tuner: false, toon: true });
      expect(Object.keys(clause.flags!)).toEqual(['effect', 'tuner', 'toon']);
    });

    it('accepts a repeated flag', () => {
      expect(clauseOf('tuner tuner monster').flags).toEqual({ tuner: true });
    });

    it('rejects a flag both required and excluded', () => {
      expect(failureOf('tuner non-tuner monster')).toEqual({
        message: '`tuner` and `non-tuner` contradict each other',
        at: 'non-tuner',
      });
      expect(failureOf('non-effect effect').at).toBe('effect');
    });

    it('rejects `non-` before anything that cannot be negated, naming what can', () => {
      const message =
        '`non-` must be followed by a monster flag, an Attribute or a Type, as in `non-tuner`, `non-FIRE` or `non-Warrior/Dragon`';
      expect(failureOf('non-monster')).toEqual({ message, at: 'monster' });
      expect(failureOf('non-level 4')).toEqual({ message, at: 'level' });
      expect(failureOf('FIRE non-')).toEqual({ message, at: 'non-' });
    });
  });

  describe('sub-kinds', () => {
    it('records every sub-kind with each kind it exists for', () => {
      for (const entry of ST_SUBKIND_VOCABULARY)
        for (const kind of entry.kinds)
          expect(clauseOf(`${entry.name} ${kind}`), `${entry.name} ${kind}`).toEqual({
            kinds: [kind],
            stSubkinds: [entry.subkind],
          });
    });

    it('implies Spell from quick-play, equip and field', () => {
      for (const subkind of ['quick-play', 'equip', 'field'] as const)
        expect(clauseOf(subkind)).toEqual({ kinds: ['spell'], stSubkinds: [subkind] });
      expect(clauseOf('quickplay card')).toEqual({ kinds: ['spell'], stSubkinds: ['quick-play'] });
    });

    it('implies Trap from counter', () => {
      expect(clauseOf('counter')).toEqual({ kinds: ['trap'], stSubkinds: ['counter'] });
    });

    it('reads `continuous` alone as a Continuous Spell or Trap', () => {
      expect(clauseOf('continuous')).toEqual({
        kinds: ['spell', 'trap'],
        stSubkinds: ['continuous'],
      });
      expect(clauseOf('continuous card')).toEqual(clauseOf('continuous'));
    });

    it('narrows `continuous` by a kind word', () => {
      expect(clauseOf('continuous trap')).toEqual({ kinds: ['trap'], stSubkinds: ['continuous'] });
    });

    it('reads a `/` list as any of the sub-kinds, in canonical order', () => {
      expect(clauseOf('continuous/quick-play spell')).toEqual({
        kinds: ['spell'],
        stSubkinds: ['quick-play', 'continuous'],
      });
      expect(clauseOf('quick-play/counter')).toEqual({
        kinds: ['spell', 'trap'],
        stSubkinds: ['quick-play', 'counter'],
      });
    });

    it('reads `normal` and `ritual` inside a list as sub-kinds, since flags have no lists', () => {
      expect(clauseOf('normal/continuous')).toEqual({
        kinds: ['spell', 'trap'],
        stSubkinds: ['normal', 'continuous'],
      });
      expect(clauseOf('normal/ritual')).toEqual({
        kinds: ['spell', 'trap'],
        stSubkinds: ['normal', 'ritual'],
      });
      expect(clauseOf('ritual/equip')).toEqual({
        kinds: ['spell'],
        stSubkinds: ['equip', 'ritual'],
      });
    });

    it('keeps the kinds that were written, even one the sub-kind does not exist for', () => {
      expect(clauseOf('counter spell/trap')).toEqual({
        kinds: ['spell', 'trap'],
        stSubkinds: ['counter'],
      });
    });

    it('rejects a sub-kind that none of the written kinds has, listing the ones it has', () => {
      expect(failureOf('counter spell')).toEqual({
        message:
          'there is no Counter Spell; spell sub-kinds are normal, quick-play, continuous, equip, field, ritual',
        at: 'counter',
      });
      expect(failureOf('quick-play trap')).toEqual({
        message: 'there is no Quick-Play Trap; trap sub-kinds are normal, continuous, counter',
        at: 'quick-play',
      });
      expect(failureOf('continuous/field trap').message).toMatch(/^there is no Field Trap;/);
    });

    it('rejects a sub-kind on a monster', () => {
      expect(failureOf('quick-play monster')).toEqual({
        message: '`quick-play` is a Spell/Trap sub-kind and cannot describe a monster',
        at: 'quick-play',
      });
      expect(failureOf('continuous monster/spell').at).toBe('continuous');
      expect(failureOf('normal/ritual monster').at).toBe('normal/ritual');
    });

    it('rejects a negated sub-kind, showing the positive way to say it', () => {
      expect(failureOf('non-counter trap')).toEqual({
        message:
          '`non-` cannot negate a Spell/Trap sub-kind; list the sub-kinds you do want, as in `normal/continuous/counter trap`',
        at: 'non-counter',
      });
      expect(failureOf('non-continuous').at).toBe('non-continuous');
    });

    it('rejects a second sub-kind qualifier, suggesting the list form', () => {
      expect(failureOf('quick-play continuous spell')).toEqual({
        message:
          'the sub-kind is given twice in this clause; write `quick-play/continuous` for any of them',
        at: 'continuous',
      });
    });

    it('rejects a list that leaves the dimension', () => {
      expect(failureOf('quick-play/FIRE')).toEqual({
        message:
          'expected a Spell/Trap sub-kind after `/`: normal, quick-play, continuous, equip, field, ritual, counter',
        at: 'FIRE',
      });
    });
  });

  describe('contextual words', () => {
    it('reads `normal` by the kind word', () => {
      expect(clauseOf('normal monster')).toEqual({ kinds: ['monster'], flags: { normal: true } });
      expect(clauseOf('normal spell')).toEqual({ kinds: ['spell'], stSubkinds: ['normal'] });
      expect(clauseOf('normal trap')).toEqual({ kinds: ['trap'], stSubkinds: ['normal'] });
      expect(clauseOf('normal spell/trap')).toEqual({
        kinds: ['spell', 'trap'],
        stSubkinds: ['normal'],
      });
    });

    it('reads `ritual` by the kind word', () => {
      expect(clauseOf('ritual monster')).toEqual({ kinds: ['monster'], flags: { ritual: true } });
      expect(clauseOf('ritual spell')).toEqual({ kinds: ['spell'], stSubkinds: ['ritual'] });
    });

    it('resolves the word wherever the kind word stands', () => {
      expect(clauseOf('spell normal')).toEqual(clauseOf('normal spell'));
      expect(clauseOf('monster normal')).toEqual(clauseOf('normal monster'));
    });

    it('rejects a bare `normal`, naming the three things it could be', () => {
      const expected = {
        message: 'normal what? write `normal monster`, `normal spell` or `normal trap`',
        at: 'normal',
      };
      expect(failureOf('normal')).toEqual(expected);
      expect(failureOf('normal card')).toEqual(expected);
      expect(failureOf('"Sky Striker" Normal')).toEqual({ ...expected, at: 'Normal' });
    });

    it('rejects a bare `ritual`, naming the two things it could be', () => {
      expect(failureOf('spell or ritual')).toEqual({
        message: 'ritual what? write `ritual monster` or `ritual spell`',
        at: 'ritual',
      });
    });

    it('rejects `ritual trap`: there is no such sub-kind', () => {
      expect(failureOf('ritual trap')).toEqual({
        message: 'there is no Ritual Trap; trap sub-kinds are normal, continuous, counter',
        at: 'ritual',
      });
    });

    it('reads the word as the monster flag beside any positive monster-only qualifier', () => {
      for (const qualifier of [
        'level 4',
        'ATK 1500',
        'DEF ?',
        'FIRE',
        'Warrior',
        'tuner',
        'level 4 card',
      ]) {
        expect(clauseOf(`${qualifier} normal`).flags, qualifier).toMatchObject({ normal: true });
        expect(clauseOf(`ritual ${qualifier}`).flags, qualifier).toMatchObject({ ritual: true });
        expect(clauseOf(`normal ${qualifier}`).kinds, qualifier).toBeUndefined();
      }
    });

    it('does not take a negative qualifier as a sign of a monster: a Spell is a non-tuner too', () => {
      for (const qualifier of ['non-tuner', 'non-FIRE', 'non-Warrior', '"Sky Striker"'])
        expect(failureOf(`${qualifier} normal`), qualifier).toEqual({
          message: 'normal what? write `normal monster`, `normal spell` or `normal trap`',
          at: 'normal',
        });
    });

    it('does not let one contextual word resolve another', () => {
      expect(failureOf('normal ritual').at).toBe('normal');
      expect(clauseOf('normal ritual monster').flags).toEqual({ normal: true, ritual: true });
      expect(clauseOf('level 8 normal ritual').flags).toEqual({ normal: true, ritual: true });
    });

    it('rejects the word when the kinds make it mean two things', () => {
      expect(failureOf('normal monster/spell')).toEqual({
        message:
          '`normal` means one thing for a monster and another for a Spell or Trap; write them as separate alternatives, as in `normal monster or normal spell`',
        at: 'normal',
      });
    });

    it('keeps a sub-kind a sub-kind beside a monster-only qualifier', () => {
      expect(clauseOf('level 4 continuous')).toEqual({
        kinds: ['spell', 'trap'],
        stSubkinds: ['continuous'],
        level: [4],
      });
    });

    it('rejects two contextual words that both resolve to sub-kinds', () => {
      expect(failureOf('normal ritual spell')).toEqual({
        message:
          'the sub-kind is given twice in this clause; write `normal/ritual` for any of them',
        at: 'ritual',
      });
    });

    it('reads the negated word as the monster flag, which needs no kind word', () => {
      expect(clauseOf('non-normal')).toEqual({ flags: { normal: false } });
      expect(clauseOf('non-ritual monster')).toEqual({
        kinds: ['monster'],
        flags: { ritual: false },
      });
      expect(clauseOf('non-normal monster/spell')).toEqual({
        kinds: ['monster', 'spell'],
        flags: { normal: false },
      });
    });

    it('rejects the negated word on a Spell or Trap, where it would silently mean nothing', () => {
      const failure = failureOf('non-normal spell');
      expect(failure.at).toBe('non-normal');
      expect(failure.message).toContain('every Spell and Trap already satisfies it');
      expect(failure.message).toContain('`quick-play/continuous spell`');
      expect(failureOf('trap non-ritual').at).toBe('non-ritual');
    });

    it('rejects a negated list', () => {
      expect(failureOf('non-normal/ritual monster')).toEqual({
        message: '`non-` negates one monster flag at a time, not a `/` list',
        at: 'non-normal',
      });
    });
  });

  describe('Attributes and Types', () => {
    it('records every Attribute and every Type by its bit', () => {
      for (const entry of ATTRIBUTE_VOCABULARY)
        expect(clauseOf(`${entry.name} monster`).attributes).toEqual({ in: [entry.bit] });
      for (const entry of RACE_VOCABULARY)
        expect(clauseOf(`${entry.name} monster`).races).toEqual({ in: [entry.bit] });
    });

    it('reads a `/` list as any of the values, sorted by bit', () => {
      expect(clauseOf('FIRE/WATER monster')).toEqual({
        kinds: ['monster'],
        attributes: { in: [ATTRIBUTE_WATER, ATTRIBUTE_FIRE] },
      });
      expect(clauseOf('beast warrior / Warrior / winged-beast').races).toEqual({
        in: [RACE_WARRIOR, RACE_WINGEDBEAST, RACE_BEASTWARRIOR],
      });
      expect(clauseOf('FIRE/fire').attributes).toEqual({ in: [ATTRIBUTE_FIRE] });
    });

    it('reads an Attribute and a Type side by side as both required', () => {
      expect(clauseOf('FIRE Beast-Warrior monster')).toEqual({
        kinds: ['monster'],
        attributes: { in: [ATTRIBUTE_FIRE] },
        races: { in: [RACE_BEASTWARRIOR] },
      });
    });

    it('reads `non-` as none of the whole list', () => {
      expect(clauseOf('non-FIRE')).toEqual({ attributes: { notIn: [ATTRIBUTE_FIRE] } });
      expect(clauseOf('non-Warrior/Dragon monster')).toEqual({
        kinds: ['monster'],
        races: { notIn: [RACE_WARRIOR, RACE_DRAGON] },
      });
    });

    it('merges several negations of one dimension', () => {
      expect(clauseOf('non-LIGHT non-DARK/FIRE monster').attributes).toEqual({
        notIn: [ATTRIBUTE_FIRE, ATTRIBUTE_LIGHT, ATTRIBUTE_DARK],
      });
    });

    it('rejects a dimension required twice, suggesting the list form', () => {
      expect(failureOf('FIRE WATER monster')).toEqual({
        message: 'Attribute is given twice in this clause; write `FIRE/WATER` for any of them',
        at: 'WATER',
      });
      expect(failureOf('Warrior FIRE Dragon/Fairy')).toEqual({
        message: 'Type is given twice in this clause; write `Warrior/Dragon/Fairy` for any of them',
        at: 'Dragon/Fairy',
      });
    });

    it('rejects a dimension both required and excluded', () => {
      expect(failureOf('FIRE non-WATER')).toEqual({
        message: 'this clause both requires and excludes Attributes; keep one of the two',
        at: 'non-WATER',
      });
      expect(failureOf('non-Warrior Dragon').at).toBe('Dragon');
    });

    it('rejects a list that mixes the two dimensions, naming both', () => {
      expect(failureOf('FIRE/Warrior monster')).toEqual({
        message:
          'a `/` list stays within one dimension: FIRE is an Attribute and Warrior is a Type; write them side by side',
        at: 'Warrior',
      });
      expect(failureOf('Dragon/DARK').message).toContain(
        'Dragon is a Type and DARK is an Attribute',
      );
    });

    it('rejects a list that ends early or repeats `non-`', () => {
      expect(failureOf('FIRE/')).toEqual({ message: 'expected an Attribute after `/`', at: '' });
      expect(failureOf('Warrior/4')).toEqual({ message: 'expected a Type after `/`', at: '4' });
      expect(failureOf('non-FIRE/non-WATER')).toEqual({
        message: '`non-` covers the whole list: write `non-FIRE/WATER`',
        at: 'non-',
      });
    });
  });

  describe('level', () => {
    it('reads a single level, at both ends of the domain too', () => {
      expect(clauseOf('level 4').level).toEqual([4]);
      expect(clauseOf('level 0').level).toEqual([0]);
      expect(clauseOf('level 13').level).toEqual([13]);
    });

    it('reads "or lower" as everything from 0, and "or higher" as everything up to 13', () => {
      expect(clauseOf('level 4 or lower monster').level).toEqual([0, 1, 2, 3, 4]);
      expect(clauseOf('level 8 or higher monster').level).toEqual([8, 9, 10, 11, 12, 13]);
      expect(clauseOf('level 0 or lower').level).toEqual([0]);
      expect(clauseOf('level 13 or higher').level).toEqual([13]);
    });

    it('accepts the stat spellings of the bounds', () => {
      expect(clauseOf('level 4 or less').level).toEqual(range(0, 4));
      expect(clauseOf('level 4 or more').level).toEqual(range(4, 13));
    });

    it('reads an inclusive range and a list', () => {
      expect(clauseOf('level 1-4').level).toEqual([1, 2, 3, 4]);
      expect(clauseOf('level 5 - 5').level).toEqual([5]);
      expect(clauseOf('level 3/4').level).toEqual([3, 4]);
      expect(clauseOf('level 7/3/7/1').level).toEqual([1, 3, 7]);
    });

    // TDD §5.1: `or` separates whole descriptions, so the first clause says nothing about FIRE.
    it('ends the clause at `or` unless it is "or lower"', () => {
      expect(descOf('level 4 or level 3 FIRE monster')).toEqual({
        anyOf: [
          { t: 'clause', clause: { level: [4] } },
          {
            t: 'clause',
            clause: { kinds: ['monster'], attributes: { in: [ATTRIBUTE_FIRE] }, level: [3] },
          },
        ],
      });
    });

    it('rejects a level outside 0-13, pointing at the number', () => {
      expect(failureOf('level 14 monster')).toEqual({
        message: 'levels run from 0 to 13',
        at: '14',
      });
      expect(failureOf('level 1-99').at).toBe('99');
      expect(failureOf('level 3/40').at).toBe('40');
    });

    it('rejects a missing level', () => {
      expect(failureOf('level')).toEqual({
        message: 'expected a level after `level`, as in `level 4`',
        at: '',
      });
      expect(failureOf('level FIRE').at).toBe('FIRE');
      expect(failureOf('level 3/').message).toBe('expected a level after `/`, as in `level 4`');
      expect(failureOf('level 3-').message).toBe(
        'expected the upper level after `-`, as in `level 4`',
      );
    });

    it('rejects a backwards range, showing it the right way round', () => {
      expect(failureOf('level 5-3 monster')).toEqual({
        message: 'a level range runs low to high: write `level 3-5`',
        at: 'level 5-3',
      });
    });

    it('rejects a second level, suggesting the list form', () => {
      expect(failureOf('level 4 level 5')).toEqual({
        message: 'the level is given twice in this clause; write `level 3/4` for either',
        at: 'level 5',
      });
    });
  });

  describe('ATK and DEF', () => {
    it('reads an exact value, keyword first or last', () => {
      expect(clauseOf('ATK 1500').atk).toEqual({ min: 1500, max: 1500 });
      expect(clauseOf('1500 ATK').atk).toEqual({ min: 1500, max: 1500 });
      expect(clauseOf('DEF 200').def).toEqual({ min: 200, max: 200 });
      expect(clauseOf('atk 0').atk).toEqual({ min: 0, max: 0 });
    });

    it('reads "or less" from 0 and "or more" without an upper bound', () => {
      expect(clauseOf('ATK 1500 or less').atk).toEqual({ min: 0, max: 1500 });
      expect(clauseOf('1500 or less ATK').atk).toEqual({ min: 0, max: 1500 });
      expect(clauseOf('DEF 2000 or more').def).toEqual({ min: 2000, max: null });
      expect(clauseOf('2000 or more DEF').def).toEqual({ min: 2000, max: null });
    });

    it('accepts the level spellings of the bounds', () => {
      expect(clauseOf('ATK 1500 or lower').atk).toEqual({ min: 0, max: 1500 });
      expect(clauseOf('ATK 1500 or higher').atk).toEqual({ min: 1500, max: null });
    });

    it('reads an inclusive range', () => {
      expect(clauseOf('ATK 1000-2000').atk).toEqual({ min: 1000, max: 2000 });
      expect(clauseOf('1000-2000 DEF').def).toEqual({ min: 1000, max: 2000 });
    });

    it('reads `?`', () => {
      expect(clauseOf('ATK ? DEF ? monster')).toEqual({ kinds: ['monster'], atk: '?', def: '?' });
    });

    it('reads ATK and DEF in one clause, next to a level', () => {
      expect(clauseOf('level 4 1500 or less ATK DEF 200 monster')).toEqual({
        kinds: ['monster'],
        level: [4],
        atk: { min: 0, max: 1500 },
        def: { min: 200, max: 200 },
      });
    });

    it('never uses Infinity, so the AST survives JSON', () => {
      const desc = descOf('ATK 3000 or more');
      expect(JSON.parse(JSON.stringify(desc))).toEqual(desc);
    });

    it('rejects a keyword without a value, showing the forms', () => {
      expect(failureOf('ATK monster')).toEqual({
        message:
          'expected a number or `?` after ATK, as in `ATK 1500`, `ATK 1500 or less` or `ATK ?`',
        at: 'monster',
      });
      expect(failureOf('DEF')).toMatchObject({ at: '' });
      expect(failureOf('DEF').message).toContain('`DEF ?`');
    });

    it('rejects a number without a keyword, showing the forms', () => {
      const message = 'a number needs its keyword: write `level 4`, `ATK 1500` or `1500 ATK`';
      expect(failureOf('4 monster')).toEqual({ message, at: '4' });
      expect(failureOf('FIRE 1500 or less')).toEqual({ message, at: '1500' });
    });

    it('rejects a second ATK, a backwards range, and a stray `?` or bound', () => {
      expect(failureOf('ATK 1500 1600 ATK')).toEqual({
        message: 'ATK is given twice in this clause',
        at: '1600 ATK',
      });
      expect(failureOf('DEF 2000-1000')).toEqual({
        message: 'a range runs low to high: write `1000-2000`',
        at: '2000-1000',
      });
      expect(failureOf('ATK 1000-').message).toBe(
        'expected the upper value after `-`, as in `ATK 1000-2000`',
      );
      expect(failureOf('? ATK')).toEqual({
        message: '`?` is a value of ATK or DEF: write `ATK ?`',
        at: '?',
      });
      expect(failureOf('FIRE or lower')).toEqual({
        message: 'this must follow a number, as in `level 4 or lower` or `ATK 1500 or less`',
        at: 'or lower',
      });
    });
  });

  describe('archetypes', () => {
    it('resolves a quoted name to its setcode', () => {
      expect(clauseOf('"Sky Striker" spell')).toEqual({ kinds: ['spell'], archetypes: [0x115] });
    });

    it('matches the name exactly, but without regard to case or outer spaces', () => {
      expect(clauseOf('" sky striker "').archetypes).toEqual([0x115]);
      expect(clauseOf('"Sky Striker Ace"').archetypes).toEqual([0x1115]);
      expect(failureOf('"Sky"').message).toBe('no archetype is named "Sky"');
    });

    it('resolves every `|` alternate of an entry', () => {
      expect(clauseOf('"Polymerization"').archetypes).toEqual([0x46]);
      expect(clauseOf('"Fusion"').archetypes).toEqual([0x46]);
    });

    it('requires all of several archetypes, sorted and de-duplicated', () => {
      expect(clauseOf('"Sky Striker" "Fusion" "sky striker" monster').archetypes).toEqual([
        0x46, 0x115,
      ]);
    });

    it('rejects an ambiguous name, listing each candidate with its code', () => {
      expect(failureOf('"warrior" monster')).toEqual({
        message: '"warrior" names 2 archetypes; pick one: "Warrior":0x66, "Warrior":0x2066',
        at: '"warrior"',
      });
      expect(failureOf('"Magnet"').message).toContain('"Magnet":0x534, "Magnet":0x1066');
    });

    it('lets a code suffix pick one of the candidates', () => {
      expect(clauseOf('"Warrior":0x2066').archetypes).toEqual([0x2066]);
      expect(clauseOf('"Warrior" : 0X66').archetypes).toEqual([0x66]);
    });

    it('accepts a suffix that merely asserts an unambiguous name', () => {
      expect(clauseOf('"Sky Striker":0x115').archetypes).toEqual([0x115]);
    });

    it('rejects a suffix the name does not map to, saying what it does map to', () => {
      expect(failureOf('"Warrior":0x3066 monster')).toEqual({
        message: '"Warrior" is "Warrior":0x66 or "Warrior":0x2066, not 0x3066',
        at: '"Warrior":0x3066',
      });
      expect(failureOf('"Striker":0x115').message).toBe(
        '0x115 is "Sky Striker":0x115, not "Striker"',
      );
      expect(failureOf('"Nothing":0x9999').message).toBe('no archetype is named "Nothing"');
    });

    it('accepts "?" with any code: how `print` writes a code it cannot name', () => {
      expect(clauseOf('"?":0x9999').archetypes).toEqual([0x9999]);
      expect(clauseOf('"?":0x115').archetypes).toEqual([0x115]);
      expect(failureOf('"?"').message).toBe('no archetype is named "?"');
    });

    it('accepts any name with a code when there is no setname table', () => {
      expect(clauseOf('"Anything":0x2066 monster', noSetnames)).toEqual({
        kinds: ['monster'],
        archetypes: [0x2066],
      });
    });

    it('rejects a bare name when there is no setname table, showing the way out', () => {
      expect(failureOf('"Sky Striker" spell', noSetnames)).toEqual({
        message: 'archetype names are unavailable (no strings.conf found); write "Name":0xCODE',
        at: '"Sky Striker"',
      });
    });

    it('rejects a code outside 0x1-0xffff, with or without a table', () => {
      const message = 'a setcode is between 0x1 and 0xffff';
      expect(failureOf('"Warrior":0x0')).toEqual({ message, at: '0x0' });
      expect(failureOf('"Warrior":0x10000', noSetnames)).toEqual({ message, at: '0x10000' });
      expect(clauseOf('"x":0xffff', noSetnames).archetypes).toEqual([0xffff]);
    });

    it('rejects a missing or decimal suffix, and an empty name', () => {
      const message = 'expected a hex setcode after `:`, as in "Warrior":0x2066';
      expect(failureOf('"Warrior":')).toEqual({ message, at: '' });
      expect(failureOf('"Warrior":2066')).toEqual({ message, at: '2066' });
      expect(failureOf('" "')).toEqual({
        message: 'an archetype name cannot be empty',
        at: '" "',
      });
    });

    it('rejects a hex code or a colon on its own', () => {
      expect(failureOf('0x2066 monster')).toEqual({
        message: 'a hex code belongs after an archetype name, as in "Warrior":0x2066',
        at: '0x2066',
      });
      expect(failureOf('monster :').at).toBe(':');
    });
  });

  describe('card references', () => {
    it('resolves a bracketed name to the passcode, whatever the case', () => {
      expect(descOf('[synthetic HARPY]')).toEqual({
        anyOf: [{ t: 'card', passcode: CODE.harpy }],
      });
    });

    it('matches the whole name, not a prefix', () => {
      expect(failureOf('[Synthetic Harp]').message).toMatch(/^no card is named "Synthetic Harp"/);
    });

    it('resolves a passcode', () => {
      expect(descOf(`#${CODE.quickSpell}`)).toEqual({
        anyOf: [{ t: 'card', passcode: CODE.quickSpell }],
      });
    });

    it('rejects a name shared by several cards, listing their passcodes', () => {
      expect(failureOf('[Synthetic Ritual Soldier]')).toEqual({
        message: `"Synthetic Ritual Soldier" names 2 different cards; write the passcode instead: #${CODE.ritualSoldier}, #${CODE.sameNameDifferentCard}`,
        at: '[Synthetic Ritual Soldier]',
      });
    });

    it('rejects an unknown name, offering the nearest names the index can find', () => {
      expect(failureOf('spell or [Synthetic Quick]')).toEqual({
        message: 'no card is named "Synthetic Quick"; did you mean [Synthetic Quick Spell]?',
        at: '[Synthetic Quick]',
      });
    });

    it('rejects an unknown name without suggestions when the lookup cannot search', () => {
      const cards = new FakeCards([cardRecord({ code: 7, name: 'Pot of Greed' })]);
      expect(failureOf('[Pot of Gred]', contextOf(cards)).message).toBe(
        'no card is named "Pot of Gred"',
      );
      expect(descOf('[pot of greed]', contextOf(cards)).anyOf).toEqual([
        { t: 'card', passcode: 7 },
      ]);
    });

    it('rejects a passcode that is not in the index, such as a collapsed alternate artwork', () => {
      expect(failureOf('#12345')).toEqual({
        message: 'no card has the passcode #12345',
        at: '#12345',
      });
      expect(failureOf(`#${CODE.nearAltArt}`).at).toBe(`#${CODE.nearAltArt}`);
    });

    it('rejects an empty name', () => {
      expect(failureOf('[ ]')).toEqual({ message: 'a card name cannot be empty', at: '[ ]' });
    });

    it('rejects a reference combined with qualifiers, on either side', () => {
      const message =
        'a card reference is a whole alternative and cannot be combined with other words; write `or` between alternatives';
      expect(failureOf('[Synthetic Harpy] monster')).toEqual({ message, at: '[Synthetic Harpy]' });
      expect(failureOf(`level 4 #${CODE.harpy}`)).toEqual({ message, at: `#${CODE.harpy}` });
      expect(failureOf(`#${CODE.harpy} #${CODE.sea}`).at).toBe(`#${CODE.harpy}`);
    });
  });

  describe('group references', () => {
    it('resolves a braced name to the group id', () => {
      expect(descOf('{hand traps}')).toEqual({ anyOf: [{ t: 'group', groupId: 'g-hand-traps' }] });
    });

    it('rejects an unknown group, listing the groups there are', () => {
      expect(failureOf('monster or {extenders}')).toEqual({
        message: 'no group is named "extenders"; groups: {Starters}, {Hand Traps}',
        at: '{extenders}',
      });
    });

    it('rejects an unknown group plainly when the lookup cannot list names', () => {
      const groups = { idOf: () => undefined, nameOf: () => undefined };
      expect(failureOf('{x}', contextOf(fixture, { groups })).message).toBe(
        'no group is named "x"',
      );
      const none = contextOf(fixture, { groups: new FakeGroups([]) });
      expect(failureOf('{x}', none).message).toBe('no group is named "x"');
    });

    it('rejects an empty name, and a group combined with qualifiers', () => {
      expect(failureOf('{}')).toEqual({ message: 'a group name cannot be empty', at: '{}' });
      expect(failureOf('FIRE {Starters}')).toEqual({
        message:
          'a group reference is a whole alternative and cannot be combined with other words; write `or` between alternatives',
        at: '{Starters}',
      });
    });
  });

  describe('alternatives', () => {
    it('separates whole descriptions with `or`, keeping their order', () => {
      expect(descOf(`trap or #${CODE.harpy} or {Starters} or level 4 monster`)).toEqual({
        anyOf: [
          { t: 'clause', clause: { kinds: ['trap'] } },
          { t: 'card', passcode: CODE.harpy },
          { t: 'group', groupId: 'g-starters' },
          { t: 'clause', clause: { kinds: ['monster'], level: [4] } },
        ],
      });
    });

    it('flattens parentheses, which only group', () => {
      const flat = descOf('level 4 monster or spell or trap');
      expect(descOf('(level 4 monster or spell) or trap')).toEqual(flat);
      expect(descOf('level 4 monster or ((spell) or (trap))')).toEqual(flat);
      expect(descOf('(((level 4 monster or spell or trap)))')).toEqual(flat);
    });

    it('drops an alternative that repeats an earlier one, however it was spelled', () => {
      expect(descOf('FIRE/WATER monster or spell or monster water/fire')).toEqual(
        descOf('FIRE/WATER monster or spell'),
      );
      expect(descOf(`#${CODE.harpy} or [Synthetic Harpy]`).anyOf).toHaveLength(1);
    });

    it('rejects a missing alternative, listing what one looks like', () => {
      const examples =
        'such as `level 4 monster`, `FIRE/WATER Warrior`, `quick-play spell`, `"Archetype"`, [Card Name] or {group}';
      expect(failureOf('')).toEqual({ message: `expected a description, ${examples}`, at: '' });
      expect(failureOf('or monster')).toEqual({
        message: `expected a description, ${examples}`,
        at: 'or',
      });
      expect(failureOf('monster or')).toEqual({
        message: `expected a description after \`or\`, ${examples}`,
        at: '',
      });
      expect(failureOf('monster or or spell').at).toBe('or');
      expect(failureOf('()').at).toBe(')');
    });

    it('points past the end of blank text', () => {
      expect(parse('   ', ctx)).toMatchObject({ ok: false, span: { start: 3, end: 3 } });
    });

    it('rejects unbalanced parentheses, pointing at the one without a partner', () => {
      expect(failureOf('spell or (level 4 monster')).toEqual({
        message: 'this `(` is never closed',
        at: '(',
      });
      expect(parse('(spell) or trap)', ctx)).toEqual({
        ok: false,
        message: 'this `)` has no matching `(`',
        span: { start: 15, end: 16 },
      });
    });

    it('rejects parentheses used for anything but a whole alternative', () => {
      expect(failureOf('(spell or trap) "Sky Striker"')).toEqual({
        message: 'parentheses group whole descriptions: expected `or` or the end after `)`',
        at: '"Sky Striker"',
      });
      expect(failureOf('level 4 (monster)')).toEqual({
        message: 'parentheses group whole descriptions; write `or` before `(`',
        at: '(',
      });
    });

    it('caps the nesting depth instead of overflowing the stack', () => {
      const nested = (depth: number) => `${'('.repeat(depth)}spell${')'.repeat(depth)}`;
      expect(descOf(nested(32))).toEqual(descOf('spell'));
      expect(parse(nested(33), ctx)).toEqual({
        ok: false,
        message: 'too many nested parentheses',
        span: { start: 32, end: 33 },
      });
      expect(parse('('.repeat(100000), ctx)).toMatchObject({ ok: false });
    });
  });

  describe('unknown words', () => {
    const hint =
      'card names go in [brackets], archetype names in "quotes" and group names in {braces}';

    it('rejects an unknown word, saying how names are written', () => {
      expect(failureOf('Blue-Eyes White Dragon')).toEqual({
        message: `unknown word "Blue"; ${hint}`,
        at: 'Blue',
      });
    });

    it('offers the nearest vocabulary for a typo', () => {
      expect(failureOf('level 4 drgon monster')).toEqual({
        message: `unknown word "drgon"; did you mean Dragon? Otherwise, ${hint}`,
        at: 'drgon',
      });
      expect(failureOf('beastwarior').message).toContain('did you mean Beast-Warrior?');
      expect(failureOf('quikplay spell').message).toContain('did you mean quick-play?');
      expect(failureOf('lvel 4').message).toContain('did you mean level?');
    });

    it('allows a short word only one edit', () => {
      expect(failureOf('fyre').message).toContain('did you mean FIRE?');
      expect(failureOf('fyer').message).toBe(`unknown word "fyer"; ${hint}`);
    });

    it('passes a lexer error through unchanged', () => {
      expect(parse('level 4, FIRE', ctx)).toEqual({
        ok: false,
        message: 'unexpected character ,',
        span: { start: 7, end: 8 },
      });
    });

    it('rejects stray punctuation, saying what could stand there', () => {
      expect(failureOf('FIRE - WATER')).toEqual({
        message:
          'unexpected `-`; expected a qualifier, a kind word (monster, spell, trap, card) or `or`',
        at: '-',
      });
      expect(failureOf('/ monster').at).toBe('/');
    });
  });

  it('returns canonical descriptions', () => {
    for (const text of [
      'trap/spell "Sky Striker" "Fusion"',
      'toon non-tuner level 7/3 WIND/EARTH Dragon/Warrior monster or spell or spell',
      'DEF ? ATK 100-200 non-DARK non-LIGHT',
    ]) {
      const desc = descOf(text);
      expect(JSON.stringify(canonicalize(desc))).toBe(JSON.stringify(desc));
    }
    expect(
      Object.keys(clauseOf('"Fusion" DEF 1 ATK 2 level 3 Warrior FIRE tuner monster')),
    ).toEqual(['kinds', 'flags', 'attributes', 'races', 'level', 'atk', 'def', 'archetypes']);
  });

  it('never throws, whatever it is given, and keeps every span inside the text', () => {
    const rng = seededRng(0xf022);
    const words = ['level', 'ATK', 'DEF', '4', '1500', 'or', 'or lower', 'or more', 'non-', '/'];
    words.push('-', '?', ':', '(', ')', 'FIRE', 'Warrior', 'beast', 'normal', 'ritual', 'tuner');
    words.push('continuous', 'counter', 'monster', 'spell', 'trap', 'card', '"Warrior"', '0x66');
    words.push('"Sky Striker"', '[Synthetic Harpy]', '[x]', '{Starters}', '{x}', '#1', 'zzz', '"');
    let parsed = 0;
    for (let i = 0; i < 5000; i++) {
      const text = Array.from({ length: rng.int(0, 7) }, () => rng.pick(words)).join(' ');
      const result = parse(text, ctx);
      if (result.ok) {
        parsed++;
        expect(JSON.stringify(canonicalize(result.desc)), text).toBe(JSON.stringify(result.desc));
        continue;
      }
      expect(result.message, text).not.toBe('');
      expect(result.span.start, text).toBeGreaterThanOrEqual(0);
      expect(result.span.end, text).toBeGreaterThanOrEqual(result.span.start);
      expect(result.span.end, text).toBeLessThanOrEqual(text.length);
    }
    // The soup must be rich enough to reach past the first token.
    expect(parsed).toBeGreaterThan(200);
  });
});

describe('parseTokens', () => {
  const END = { start: 100, end: 103 };

  function tokensOf(text: string) {
    const lexed = lex(text);
    if (!lexed.ok) throw new Error(lexed.message);
    return lexed.tokens;
  }

  it('parses a description out of the middle of a longer text', () => {
    const text = '1x level 4 monster or [Synthetic Harpy] and';
    const tokens = tokensOf(text).slice(2, -1);
    expect(parseTokens(tokens, END, ctx)).toEqual({
      ok: true,
      desc: descOf('level 4 monster or [Synthetic Harpy]'),
    });
  });

  it('keeps the spans of the tokens it was given', () => {
    const tokens = tokensOf('1x level 4 levle monster').slice(2);
    expect(parseTokens(tokens, END, ctx)).toMatchObject({
      ok: false,
      span: { start: 11, end: 16 },
    });
  });

  it('points at the given end when something is missing after the last token', () => {
    expect(parseTokens([], END, ctx)).toEqual({
      ok: false,
      message: expect.stringContaining('expected a description'),
      span: END,
    });
    expect(parseTokens(tokensOf('monster or'), END, ctx)).toMatchObject({ ok: false, span: END });
    expect(parseTokens(tokensOf('level'), END, ctx)).toMatchObject({ ok: false, span: END });
    expect(parseTokens(tokensOf('"Warrior":'), END, ctx)).toMatchObject({ ok: false, span: END });
  });

  it('is what parse does with the tokens of the whole text', () => {
    for (const text of ['FIRE/WATER non-tuner', 'normal', '(spell or trap', 'level 4 level 5', ''])
      expect(parseTokens(tokensOf(text), { start: text.length, end: text.length }, ctx)).toEqual(
        parse(text, ctx),
      );
  });
});
