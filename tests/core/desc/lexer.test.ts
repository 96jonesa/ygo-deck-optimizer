import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DIVINE,
  ATTRIBUTE_FIRE,
  RACE_BEAST,
  RACE_BEASTWARRIOR,
  RACE_CREATORGOD,
  RACE_DIVINE,
  RACE_SEASERPENT,
  RACE_WARRIOR,
  RACE_WINGEDBEAST,
} from '../../../src/core/cards/constants';
import {
  ATTRIBUTE_VOCABULARY,
  KIND_VOCABULARY,
  MONSTER_FLAG_VOCABULARY,
  RACE_VOCABULARY,
  ST_SUBKIND_VOCABULARY,
} from '../../../src/core/cards/vocabulary';
import { lex, lexOne, skipSpace, type Token, type TokenBody } from '../../../src/core/desc/lexer';
import { seededRng } from '../../helpers/prng';

/** The tokens of `text` without their spans; fails the test on a lex error. */
function bodies(text: string): TokenBody[] {
  const result = lex(text);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.tokens.map(({ span: _span, ...body }) => body as TokenBody);
}

function tokens(text: string): Token[] {
  const result = lex(text);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.tokens;
}

/** Hyphenated, spaced, run-together, and in both cases: all the same word (TDD §5.1). */
function spellingsOf(name: string): string[] {
  const variants = [name, name.replaceAll(/[-\s]+/g, ' '), name.replaceAll(/[-\s]+/g, '-')];
  variants.push(name.replaceAll(/[-\s]+/g, ''), name.replaceAll(/[-\s]+/g, ' - '));
  return variants.flatMap((v) => [v, v.toLowerCase(), v.toUpperCase()]);
}

describe('lex', () => {
  it('returns no tokens for empty or blank text', () => {
    expect(bodies('')).toEqual([]);
    expect(bodies(' \t\n ')).toEqual([]);
  });

  describe('vocabulary', () => {
    it('reads every Type, under every spelling, as one race token', () => {
      for (const entry of RACE_VOCABULARY)
        for (const name of [entry.name, ...entry.synonyms])
          for (const spelling of spellingsOf(name))
            expect(bodies(spelling), spelling).toEqual([{ t: 'race', bit: entry.bit }]);
    });

    it('reads every Attribute as one attribute token', () => {
      for (const entry of ATTRIBUTE_VOCABULARY)
        for (const spelling of spellingsOf(entry.name))
          expect(bodies(spelling), spelling).toEqual([{ t: 'attribute', bit: entry.bit }]);
    });

    it('reads the kind words, their plurals, and `card`', () => {
      for (const entry of KIND_VOCABULARY)
        for (const name of [entry.name, ...entry.synonyms])
          expect(bodies(name), name).toEqual([{ t: 'kind', kind: entry.kind }]);
      expect(bodies('card Cards')).toEqual([{ t: 'cardWord' }, { t: 'cardWord' }]);
    });

    it('reads a word that is only a monster flag as a flag token', () => {
      const plain = MONSTER_FLAG_VOCABULARY.filter((e) => !['normal', 'ritual'].includes(e.flag));
      expect(plain).toHaveLength(8);
      for (const entry of plain)
        expect(bodies(entry.name), entry.name).toEqual([{ t: 'flag', flag: entry.flag }]);
    });

    it('reads a word that is only a sub-kind as a subkind token, under every spelling', () => {
      const plain = ST_SUBKIND_VOCABULARY.filter((e) => !['normal', 'ritual'].includes(e.subkind));
      expect(plain.map((entry) => entry.subkind)).toEqual([
        'quick-play',
        'continuous',
        'equip',
        'field',
        'counter',
      ]);
      for (const entry of plain)
        for (const name of [entry.name, ...entry.synonyms])
          for (const spelling of spellingsOf(name))
            expect(bodies(spelling), spelling).toEqual([{ t: 'subkind', subkind: entry.subkind }]);
    });

    it('reads `normal` and `ritual` as contextual: both a flag and a sub-kind', () => {
      expect(bodies('Normal RITUAL')).toEqual([
        { t: 'contextual', flag: 'normal', subkind: 'normal' },
        { t: 'contextual', flag: 'ritual', subkind: 'ritual' },
      ]);
    });

    it('reads the keywords in any case', () => {
      expect(bodies('level LEVEL atk ATK Def')).toEqual([
        { t: 'level' },
        { t: 'level' },
        { t: 'stat', stat: 'atk' },
        { t: 'stat', stat: 'atk' },
        { t: 'stat', stat: 'def' },
      ]);
    });
  });

  describe('longest match', () => {
    it('prefers Winged Beast and Beast-Warrior over Beast', () => {
      expect(bodies('winged beast')).toEqual([{ t: 'race', bit: RACE_WINGEDBEAST }]);
      expect(bodies('beast warrior')).toEqual([{ t: 'race', bit: RACE_BEASTWARRIOR }]);
      expect(bodies('Beast-Warrior')).toEqual([{ t: 'race', bit: RACE_BEASTWARRIOR }]);
      expect(bodies('beastwarrior')).toEqual([{ t: 'race', bit: RACE_BEASTWARRIOR }]);
    });

    it('still reads Beast and Warrior alone, and on either side of a `/`', () => {
      expect(bodies('beast')).toEqual([{ t: 'race', bit: RACE_BEAST }]);
      expect(bodies('Beast/Warrior')).toEqual([
        { t: 'race', bit: RACE_BEAST },
        { t: 'punct', ch: '/' },
        { t: 'race', bit: RACE_WARRIOR },
      ]);
      expect(bodies('warrior beast')).toEqual([
        { t: 'race', bit: RACE_WARRIOR },
        { t: 'race', bit: RACE_BEAST },
      ]);
    });

    it('prefers the other two-word Types over their parts', () => {
      expect(bodies('sea serpent')).toEqual([{ t: 'race', bit: RACE_SEASERPENT }]);
      expect(bodies('creator god')).toEqual([{ t: 'race', bit: RACE_CREATORGOD }]);
      expect(bodies('divine-beast')).toEqual([{ t: 'race', bit: RACE_DIVINE }]);
    });

    // The price of "hyphens and spaces are equivalent": the Attribute then the Type Beast
    // cannot be written in that order. `print` knows (see its tests).
    it('reads `DIVINE Beast` as the Type Divine-Beast, and `Beast DIVINE` as two words', () => {
      expect(bodies('DIVINE Beast')).toEqual([{ t: 'race', bit: RACE_DIVINE }]);
      expect(bodies('DIVINE')).toEqual([{ t: 'attribute', bit: ATTRIBUTE_DIVINE }]);
      expect(bodies('Beast DIVINE')).toEqual([
        { t: 'race', bit: RACE_BEAST },
        { t: 'attribute', bit: ATTRIBUTE_DIVINE },
      ]);
    });

    it('prefers every "or lower" family phrase over `or`', () => {
      for (const phrase of ['or lower', 'or less', 'or below', 'OR  LOWER', 'or-less'])
        expect(bodies(phrase), phrase).toEqual([{ t: 'bound', dir: 'down' }]);
      for (const phrase of ['or higher', 'or more', 'or above', 'Or Higher'])
        expect(bodies(phrase), phrase).toEqual([{ t: 'bound', dir: 'up' }]);
      expect(bodies('or')).toEqual([{ t: 'or' }]);
    });

    it('reads `or` before a word that only starts like a bound as plain `or`', () => {
      expect(bodies('4 or level')).toEqual([{ t: 'int', value: 4 }, { t: 'or' }, { t: 'level' }]);
      expect(bodies('or lowered')).toEqual([{ t: 'or' }, { t: 'word', text: 'lowered' }]);
    });

    it('matches whole words only', () => {
      expect(bodies('beastly')).toEqual([{ t: 'word', text: 'beastly' }]);
      expect(bodies('orb')).toEqual([{ t: 'word', text: 'orb' }]);
      expect(bodies('fire2')).toEqual([{ t: 'word', text: 'fire2' }]);
      expect(bodies('firé')).toEqual([{ t: 'word', text: 'firé' }]);
    });
  });

  describe('non-', () => {
    it('reads the prefix with a hyphen, a space, or nothing before a vocabulary word', () => {
      const expected = [{ t: 'non' }, { t: 'flag', flag: 'tuner' }];
      for (const text of ['non-tuner', 'non tuner', 'nontuner', 'NON-Tuner', 'non - tuner'])
        expect(bodies(text), text).toEqual(expected);
    });

    it('reads the prefix before a multi-word Type', () => {
      expect(bodies('non-beast-warrior')).toEqual([
        { t: 'non' },
        { t: 'race', bit: RACE_BEASTWARRIOR },
      ]);
      expect(bodies('nonfire')).toEqual([{ t: 'non' }, { t: 'attribute', bit: ATTRIBUTE_FIRE }]);
    });

    it('covers the hyphen in the span of the prefix', () => {
      expect(tokens('non-tuner')[0]!.span).toEqual({ start: 0, end: 4 });
      expect(tokens('nontuner')[0]!.span).toEqual({ start: 0, end: 3 });
    });

    it('reads a separated prefix even before an unknown word', () => {
      expect(bodies('non-foo')).toEqual([{ t: 'non' }, { t: 'word', text: 'foo' }]);
    });

    it('does not split an unknown word that merely starts with "non"', () => {
      expect(bodies('nonsense')).toEqual([{ t: 'word', text: 'nonsense' }]);
      expect(bodies('none')).toEqual([{ t: 'word', text: 'none' }]);
    });
  });

  describe('numbers', () => {
    it('reads integers, with or without a word run on', () => {
      expect(bodies('1500')).toEqual([{ t: 'int', value: 1500 }]);
      expect(bodies('007')).toEqual([{ t: 'int', value: 7 }]);
      expect(bodies('1500atk')).toEqual([
        { t: 'int', value: 1500 },
        { t: 'stat', stat: 'atk' },
      ]);
    });

    it('reads a level range as int, dash, int', () => {
      expect(bodies('1-4')).toEqual([
        { t: 'int', value: 1 },
        { t: 'punct', ch: '-' },
        { t: 'int', value: 4 },
      ]);
    });

    it('reads a hex code in either case', () => {
      expect(bodies('0x2066')).toEqual([{ t: 'hex', value: 0x2066 }]);
      expect(bodies('0XABC')).toEqual([{ t: 'hex', value: 0xabc }]);
      expect(bodies('0xffffffff')).toEqual([{ t: 'hex', value: 0xffffffff }]);
    });

    it('reads `0x` without digits as the integer 0 and a word', () => {
      expect(bodies('0xg')).toEqual([
        { t: 'int', value: 0 },
        { t: 'word', text: 'xg' },
      ]);
    });

    it('reads a passcode', () => {
      expect(bodies('#89631139')).toEqual([{ t: 'passcode', value: 89631139 }]);
      expect(bodies('#4294967295')).toEqual([{ t: 'passcode', value: 4294967295 }]);
    });

    it('rejects a number too large to be exact, pointing at it', () => {
      expect(lex('ATK 1234567890')).toEqual({
        ok: false,
        message: 'this number is too large',
        span: { start: 4, end: 14 },
      });
      expect(lex('0x123456789')).toMatchObject({ ok: false, span: { start: 0, end: 11 } });
      expect(lex(' #12345678901')).toMatchObject({ ok: false, span: { start: 1, end: 13 } });
    });

    it('rejects a # without digits', () => {
      expect(lex('level 4 or #x')).toEqual({
        ok: false,
        message: 'expected a passcode after #, such as #89631139',
        span: { start: 11, end: 12 },
      });
    });
  });

  describe('delimited names', () => {
    it('reads a quoted archetype without lexing its contents', () => {
      expect(bodies('"Sky Striker"')).toEqual([{ t: 'quoted', text: 'Sky Striker' }]);
      expect(bodies('"level 4 or monster"')).toEqual([{ t: 'quoted', text: 'level 4 or monster' }]);
    });

    it('reads curly quotes as pasted text has them', () => {
      expect(bodies('“Sky Striker”')).toEqual([{ t: 'quoted', text: 'Sky Striker' }]);
    });

    it('reads a bracketed card name with commas, digits and `or` inside', () => {
      expect(bodies('[Nibiru, the Primal Being]')).toEqual([
        { t: 'cardName', text: 'Nibiru, the Primal Being' },
      ]);
      expect(bodies('[Trick or Treat 2] or spell')).toEqual([
        { t: 'cardName', text: 'Trick or Treat 2' },
        { t: 'or' },
        { t: 'kind', kind: 'spell' },
      ]);
    });

    it('reads a braced group name', () => {
      expect(bodies('{hand traps}')).toEqual([{ t: 'group', text: 'hand traps' }]);
    });

    it('trims the name but spans the delimiters', () => {
      expect(tokens('  [  Pot of Greed ]')).toEqual([
        { t: 'cardName', text: 'Pot of Greed', span: { start: 2, end: 19 } },
      ]);
    });

    it('reads the suffix of an archetype as colon and hex', () => {
      expect(bodies('"Warrior":0x2066')).toEqual([
        { t: 'quoted', text: 'Warrior' },
        { t: 'punct', ch: ':' },
        { t: 'hex', value: 0x2066 },
      ]);
    });

    it('rejects an unclosed delimiter, spanning from it to the end', () => {
      expect(lex('spell or "Sky Striker')).toEqual({
        ok: false,
        message: 'this " is never closed: expected " after an archetype name',
        span: { start: 9, end: 21 },
      });
      expect(lex('[Pot of Greed')).toMatchObject({
        ok: false,
        message: 'this [ is never closed: expected ] after a card name',
        span: { start: 0, end: 13 },
      });
      expect(lex('{starters')).toMatchObject({
        ok: false,
        message: 'this { is never closed: expected } after a group name',
      });
      expect(lex('“Sky Striker"')).toMatchObject({ ok: false, span: { start: 0, end: 13 } });
    });
  });

  describe('punctuation', () => {
    it('reads each punctuation mark', () => {
      expect(bodies('()/-?:')).toEqual(
        ['(', ')', '/', '-', '?', ':'].map((ch) => ({ t: 'punct', ch })),
      );
    });

    it('rejects any other character, pointing at it', () => {
      expect(lex('level 4, FIRE')).toEqual({
        ok: false,
        message: 'unexpected character ,',
        span: { start: 7, end: 8 },
      });
      expect(lex(']')).toMatchObject({ ok: false, message: 'unexpected character ]' });
    });

    it('spans both halves of a character outside the BMP', () => {
      expect(lex('spell 🃏')).toEqual({
        ok: false,
        message: 'unexpected character 🃏',
        span: { start: 6, end: 8 },
      });
    });
  });

  describe('spans', () => {
    it('index the text as given, whatever the whitespace', () => {
      const text = '  level\t4   or lower\nFIRE  Beast - Warrior';
      expect(tokens(text).map(({ span }) => text.slice(span.start, span.end))).toEqual([
        'level',
        '4',
        'or lower',
        'FIRE',
        'Beast - Warrior',
      ]);
    });

    it('are not thrown off by characters that change length when normalized', () => {
      const text = '[Élégant Égotiste] or fire';
      const spans = tokens(text).map(({ span }) => text.slice(span.start, span.end));
      expect(spans).toEqual(['[Élégant Égotiste]', 'or', 'fire']);
    });
  });

  it('never throws, and keeps every span inside the text', () => {
    const rng = seededRng(0x1e8e7);
    const alphabet = ['non', '-', ' ', 'beast', 'warrior', 'or', 'lower', '4', '0x', '"', '['];
    alphabet.push(']', '{', '}', '#', '?', '/', '(', ')', ':', 'é', 'ſ', 'K', '🃏', ',', 'x');
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: rng.int(0, 8) }, () => rng.pick(alphabet)).join('');
      const result = lex(text);
      const spans = result.ok ? result.tokens.map((token) => token.span) : [result.span];
      for (const span of spans) {
        expect(span.start).toBeGreaterThanOrEqual(0);
        expect(span.end).toBeGreaterThanOrEqual(span.start);
        expect(span.end).toBeLessThanOrEqual(text.length);
      }
    }
  });
});

describe('lexOne', () => {
  it('reads the one token that starts at the offset, with its span in the whole text', () => {
    const text = 'level 4 or lower "Sky Striker":0x115 spell';
    expect(lexOne(text, 0)).toEqual({
      ok: true,
      token: { t: 'level', span: { start: 0, end: 5 } },
    });
    expect(lexOne(text, 8)).toEqual({
      ok: true,
      token: { t: 'bound', dir: 'down', span: { start: 8, end: 16 } },
    });
    expect(lexOne(text, 17)).toEqual({
      ok: true,
      token: { t: 'quoted', text: 'Sky Striker', span: { start: 17, end: 30 } },
    });
    expect(lexOne(text, 31)).toEqual({
      ok: true,
      token: { t: 'hex', value: 0x115, span: { start: 31, end: 36 } },
    });
  });

  it('starts where it is told, even inside a word', () => {
    expect(lexOne('beastly', 5)).toEqual({
      ok: true,
      token: { t: 'word', text: 'ly', span: { start: 5, end: 7 } },
    });
  });

  it('reports an error with its span in the whole text', () => {
    expect(lexOne('monster or [Unclosed', 11)).toEqual({
      ok: false,
      message: expect.stringContaining('never closed'),
      span: { start: 11, end: 20 },
    });
    expect(lexOne('spell & trap', 6)).toEqual({
      ok: false,
      message: 'unexpected character &',
      span: { start: 6, end: 7 },
    });
  });

  it('gives lex its tokens, one after another', () => {
    const text = '  non-FIRE/WATER Beast - Warrior  or #123 {g} ATK ? ';
    const collected: Token[] = [];
    for (let pos = skipSpace(text, 0); pos < text.length; pos = skipSpace(text, pos)) {
      const result = lexOne(text, pos);
      if (!result.ok) throw new Error(result.message);
      collected.push(result.token);
      pos = result.token.span.end;
    }
    expect(collected).toEqual(tokens(text));
  });
});

describe('skipSpace', () => {
  it('moves past a run of whitespace of any kind', () => {
    expect(skipSpace('a \t\n\u00a0 b', 1)).toBe(6);
  });

  it('stays where there is none, and at the end of the text', () => {
    expect(skipSpace('ab', 0)).toBe(0);
    expect(skipSpace('ab  ', 2)).toBe(4);
    expect(skipSpace('ab', 2)).toBe(2);
  });
});
