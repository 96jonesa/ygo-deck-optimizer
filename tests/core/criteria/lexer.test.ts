import { describe, expect, it } from 'vitest';
import { type CriterionTokenBody, lexCriterion } from '../../../src/core/criteria/lexer';
import { lex } from '../../../src/core/desc/lexer';

/** The tokens of `text` without their spans; fails the test on a lex error. */
function bodies(text: string): CriterionTokenBody[] {
  const result = lexCriterion(text);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.tokens.map(({ span: _span, ...body }) => body as CriterionTokenBody);
}

function spansOf(text: string): string[] {
  const result = lexCriterion(text);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.tokens.map(({ span }) => text.slice(span.start, span.end));
}

describe('lexCriterion', () => {
  describe('then', () => {
    it('reads it as a word of its own, in any case', () => {
      for (const text of ['then', 'THEN', 'Then'])
        expect(bodies(text), text).toEqual([{ t: 'then' }]);
    });

    it('leaves it alone inside a word, and inside a bracketed or quoted name', () => {
      // `lexOne` takes a bracketed name whole, so nothing inside one is a keyword.
      expect(bodies('[Then and Now]')).toEqual([{ t: 'cardName', text: 'Then and Now' }]);
      expect(bodies('thenar')).toEqual([{ t: 'word', text: 'thenar' }]);
    });

    it('spans exactly the word', () => {
      expect(spansOf('1x monster then no trap')).toEqual(['1x', 'monster', 'then', 'no', 'trap']);
    });
  });

  it('returns no tokens for empty or blank text', () => {
    expect(bodies('')).toEqual([]);
    expect(bodies(' \n\t')).toEqual([]);
  });

  describe('counts', () => {
    it('reads digits and an x or a ×, in either case, with or without a space', () => {
      for (const text of ['2x', '2X', '2×', '2 x', '2  ×', '002x'])
        expect(bodies(text), text).toEqual([{ t: 'count', n: 2 }]);
      expect(bodies('0x')).toEqual([{ t: 'count', n: 0 }]);
      expect(bodies('60x 61x')).toEqual([
        { t: 'count', n: 60 },
        { t: 'count', n: 61 },
      ]);
    });

    it('spans the digits through the x', () => {
      expect(spansOf('1x monster, 2 × spell')).toEqual(['1x', 'monster', ',', '2 ×', 'spell']);
    });

    it('ends at the x when a delimiter or a × makes that unmistakable', () => {
      expect(bodies('1x[C]')).toEqual([
        { t: 'count', n: 1 },
        { t: 'cardName', text: 'C' },
      ]);
      expect(bodies('1x(2×monster')).toEqual([
        { t: 'count', n: 1 },
        { t: 'punct', ch: '(' },
        { t: 'count', n: 2 },
        { t: 'kind', kind: 'monster' },
      ]);
    });

    it('reads a range, `1-2x`, with or without spaces around the dash', () => {
      for (const text of ['1-2x', '1 - 2x', '1-2 ×', '1-2X'])
        expect(bodies(text), text).toEqual([{ t: 'count', n: 1, max: 2 }]);
      expect(bodies('0-0x')).toEqual([{ t: 'count', n: 0, max: 0 }]);
      // Not validated here: a backwards range is a count, and the parser refuses it.
      expect(bodies('4-2x')).toEqual([{ t: 'count', n: 4, max: 2 }]);
      expect(spansOf('1-2x monster')).toEqual(['1-2x', 'monster']);
    });

    it("leaves a description's own range alone: `level 2-4` ends in no x", () => {
      expect(bodies('1x level 2-4 monster')).toEqual([
        { t: 'count', n: 1 },
        { t: 'level' },
        { t: 'int', value: 2 },
        { t: 'punct', ch: '-' },
        { t: 'int', value: 4 },
        { t: 'kind', kind: 'monster' },
      ]);
      // And the two together, the count a range and the level a range.
      expect(bodies('1-2x level 2-4 monster').slice(0, 2)).toEqual([
        { t: 'count', n: 1, max: 2 },
        { t: 'level' },
      ]);
      expect(bodies('1x ATK 1000-2000')).toEqual([
        { t: 'count', n: 1 },
        { t: 'stat', stat: 'atk' },
        { t: 'int', value: 1000 },
        { t: 'punct', ch: '-' },
        { t: 'int', value: 2000 },
      ]);
    });

    it('leaves a hex code whole: 0x2066 is not the count 0x', () => {
      expect(bodies('0x2066')).toEqual([{ t: 'hex', value: 0x2066 }]);
      expect(bodies('0X2066')).toEqual([{ t: 'hex', value: 0x2066 }]);
      expect(bodies('1x "Warrior":0x2066 monster')).toEqual([
        { t: 'count', n: 1 },
        { t: 'quoted', text: 'Warrior' },
        { t: 'punct', ch: ':' },
        { t: 'hex', value: 0x2066 },
        { t: 'kind', kind: 'monster' },
      ]);
      expect(bodies('0x 2066')).toEqual([
        { t: 'count', n: 0 },
        { t: 'int', value: 2066 },
      ]);
      // An x that runs into a word is no count either: `0xdark` starts as the hex code 0xda.
      expect(bodies('0xdark')).toEqual([
        { t: 'hex', value: 0xda },
        { t: 'word', text: 'rk' },
      ]);
      expect(bodies('10x2066')).toEqual([
        { t: 'int', value: 10 },
        { t: 'word', text: 'x2066' },
      ]);
    });

    it('reads no count straight after a colon, where a setcode belongs', () => {
      expect(bodies('"Warrior":0x monster')).toEqual([
        { t: 'quoted', text: 'Warrior' },
        { t: 'punct', ch: ':' },
        { t: 'int', value: 0 },
        { t: 'word', text: 'x' },
        { t: 'kind', kind: 'monster' },
      ]);
    });

    it('reads a long run of digits as a count too large for anything, never as an error', () => {
      for (const digits of ['99999999999999999999', '9'.repeat(400)]) {
        const [token] = bodies(`${digits}x`);
        expect(token?.t === 'count' && token.n > 1e9, digits).toBe(true);
      }
    });

    it('leaves a number without an x to the description', () => {
      expect(bodies('2 monsters')).toEqual([
        { t: 'int', value: 2 },
        { t: 'kind', kind: 'monster' },
      ]);
      expect(bodies('1500 ATK')).toEqual([
        { t: 'int', value: 1500 },
        { t: 'stat', stat: 'atk' },
      ]);
    });
  });

  describe('keywords', () => {
    it('reads at most, no, and and the comma, in any case', () => {
      expect(bodies('at most AT  MOST At\nMost')).toEqual([
        { t: 'atMost' },
        { t: 'atMost' },
        { t: 'atMost' },
      ]);
      expect(bodies('no NO')).toEqual([{ t: 'no' }, { t: 'no' }]);
      expect(bodies('and , AND')).toEqual([{ t: 'and' }, { t: 'and' }, { t: 'and' }]);
      expect(spansOf('1x monster,no spell')).toEqual(['1x', 'monster', ',', 'no', 'spell']);
    });

    it('reads exactly, in any case, as its own word', () => {
      expect(bodies('exactly EXACTLY ExAcTlY')).toEqual([
        { t: 'exactly' },
        { t: 'exactly' },
        { t: 'exactly' },
      ]);
      expect(bodies('exactly 1x monster')).toEqual([
        { t: 'exactly' },
        { t: 'count', n: 1 },
        { t: 'kind', kind: 'monster' },
      ]);
      expect(spansOf('exactly 1x monster')).toEqual(['exactly', '1x', 'monster']);
    });

    it('only reads whole words', () => {
      expect(bodies('non-tuner normal nothing android atmost at mostly')).toEqual([
        { t: 'non' },
        { t: 'flag', flag: 'tuner' },
        { t: 'contextual', flag: 'normal', subkind: 'normal' },
        { t: 'word', text: 'nothing' },
        { t: 'word', text: 'android' },
        { t: 'word', text: 'atmost' },
        { t: 'word', text: 'at' },
        { t: 'word', text: 'mostly' },
      ]);
      expect(bodies('exact exactlyx exactly2')).toEqual([
        { t: 'word', text: 'exact' },
        { t: 'word', text: 'exactlyx' },
        { t: 'word', text: 'exactly2' },
      ]);
    });

    it('leaves or, and or lower, to the description lexer', () => {
      expect(bodies('or or lower OR')).toEqual([
        { t: 'or' },
        { t: 'bound', dir: 'down' },
        { t: 'or' },
      ]);
    });

    it('reads nothing inside a name', () => {
      expect(bodies('[Nibiru, the Primal Being] "Live and Let Die" {no 2x}')).toEqual([
        { t: 'cardName', text: 'Nibiru, the Primal Being' },
        { t: 'quoted', text: 'Live and Let Die' },
        { t: 'group', text: 'no 2x' },
      ]);
    });
  });

  it('agrees with the description lexer on text without criterion words', () => {
    for (const text of [
      'level 4 or lower FIRE/WATER Beast-Warrior monster or quick-play spell',
      '"Sky Striker":0x115 spell or [Some Card] or #123 or {group}',
      'ATK 1500 or more non-tuner (DEF ? or 2000-2500 DEF)',
    ])
      expect(lexCriterion(text)).toEqual(lex(text));
  });

  it('passes on the description lexer’s errors, spans and all', () => {
    expect(lexCriterion('1x monster and 1x [Unclosed')).toEqual({
      ok: false,
      message: expect.stringContaining('never closed'),
      span: { start: 18, end: 27 },
    });
    expect(lexCriterion('1x monster & 1x spell')).toEqual({
      ok: false,
      message: 'unexpected character &',
      span: { start: 11, end: 12 },
    });
  });
});
