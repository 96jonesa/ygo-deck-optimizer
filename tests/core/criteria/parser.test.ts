import { describe, expect, it } from 'vitest';
import type { Expr } from '../../../src/core/criteria/ast';
import { type CriterionParseOptions, parseCriterion } from '../../../src/core/criteria/parser';
import { printCriterion } from '../../../src/core/criteria/print';
import type { Description } from '../../../src/core/desc/ast';
import { parse } from '../../../src/core/desc/parser';
import { cardRecord, contextOf, FakeCards } from '../../helpers/desc-context';
import { genExpr } from '../../helpers/gen-criteria';
import { seededRng } from '../../helpers/prng';

// Real names hold everything the criterion grammar gives meaning to.
const ctx = contextOf(
  new FakeCards([
    cardRecord({ code: 1, name: 'C' }),
    cardRecord({ code: 2, name: 'D' }),
    cardRecord({ code: 3, name: 'E' }),
    cardRecord({ code: 4, name: 'Nibiru, the Primal Being' }),
    cardRecord({ code: 5, name: 'Live and Let Die or 2x No More (at most)' }),
  ]),
);

const [C, D, E] = [card(1), card(2), card(3)] as [Description, Description, Description];

function card(...passcodes: number[]): Description {
  return { anyOf: passcodes.map((passcode) => ({ t: 'card', passcode })) };
}

/** A description, read by the description parser on its own. */
function d(text: string): Description {
  const result = parse(text, ctx);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.desc;
}

function req(n: number, desc: Description): Expr {
  return { op: 'req', n, desc };
}

/** `a-b×`: a requirement with a ceiling. */
function range(n: number, max: number, desc: Description): Expr {
  return { op: 'req', n, max, desc };
}

function atMost(n: number, desc: Description): Expr {
  return { op: 'atMost', n, desc };
}

function and(...args: Expr[]): Expr {
  return { op: 'and', args };
}

function or(...args: Expr[]): Expr {
  return { op: 'or', args };
}

function expectExpr(text: string, expr: Expr) {
  expect(parseCriterion(text, ctx), text).toEqual({ ok: true, expr });
}

/** The message of the error `text` must produce, and the piece of `text` its span covers. */
function errorOf(
  text: string,
  opts: CriterionParseOptions = {},
): { message: string; at: string; start: number } {
  const result = parseCriterion(text, ctx, opts);
  if (result.ok) throw new Error(`${text}: expected an error, got ${JSON.stringify(result.expr)}`);
  const { start, end } = result.span;
  return { message: result.message, at: text.slice(start, end), start };
}

describe('parseCriterion', () => {
  describe('requirements', () => {
    it('reads a count and a description', () => {
      expectExpr('1x monster', req(1, d('monster')));
      expectExpr('3x level 4 or lower FIRE monster', req(3, d('level 4 or lower FIRE monster')));
      expectExpr('60x card', req(60, d('card')));
    });

    it('accepts ×, a capital X and a space before either', () => {
      for (const count of ['2x', '2X', '2×', '2 x', '2 ×', '02x'])
        expectExpr(`${count} spell`, req(2, d('spell')));
      expectExpr('2×spell', req(2, d('spell')));
      expectExpr('2x[C]', req(2, C));
    });

    it('hands the description parser everything up to the next and', () => {
      expectExpr(
        '1x FIRE/WATER non-tuner "Sky Striker" monster and 1x [C]',
        and(req(1, d('FIRE/WATER non-tuner "Sky Striker" monster')), req(1, C)),
      );
    });

    it('leaves names alone, whatever words they hold', () => {
      expectExpr('1x [Nibiru, the Primal Being], 1x [C]', and(req(1, card(4)), req(1, C)));
      expectExpr(
        '1x [Live and Let Die or 2x No More (at most)] or 2x [D]',
        or(req(1, card(5)), req(2, D)),
      );
    });
  });

  describe('limits', () => {
    it('reads at most with a count, zero included', () => {
      expectExpr('at most 1x trap', atMost(1, d('trap')));
      expectExpr('AT   Most 2× trap', atMost(2, d('trap')));
      expectExpr('at most 0x trap', atMost(0, d('trap')));
      expectExpr('at most 60x trap', atMost(60, d('trap')));
    });

    it('reads no as at most 0x', () => {
      expectExpr('no trap', atMost(0, d('trap')));
      expectExpr('No non-tuner', atMost(0, d('non-tuner')));
      expectExpr('1x monster and no [C]', and(req(1, d('monster')), atMost(0, C)));
    });

    it('does not mistake non- or normal for no', () => {
      expectExpr('1x non-tuner monster', req(1, d('non-tuner monster')));
      expectExpr('no normal monster', atMost(0, d('normal monster')));
    });
  });

  describe('and, the comma, or and parentheses', () => {
    it('reads and and the comma alike', () => {
      const expr = and(req(1, C), req(1, D), req(1, E));
      expectExpr('1x [C] and 1x [D] and 1x [E]', expr);
      expectExpr('1x [C], 1x [D], 1x [E]', expr);
      expectExpr('1x [C], 1x [D] AND 1x [E]', expr);
      expectExpr('1x [C],1x [D]and 1x [E]', expr);
    });

    it('binds and tighter than or', () => {
      expectExpr('1x [C] or 1x [D] and 1x [E]', or(req(1, C), and(req(1, D), req(1, E))));
      expectExpr('1x [C] and 1x [D] or 1x [E]', or(and(req(1, C), req(1, D)), req(1, E)));
      expectExpr(
        '1x [C], 1x [D] or 1x [E], no [C]',
        or(and(req(1, C), req(1, D)), and(req(1, E), atMost(0, C))),
      );
    });

    it('groups with parentheses', () => {
      expectExpr('(1x [C] or 1x [D]) and 1x [E]', and(or(req(1, C), req(1, D)), req(1, E)));
      expectExpr('1x [C] and (1x [D] or 2x [E])', and(req(1, C), or(req(1, D), req(2, E))));
      expectExpr(
        '1x [C] and (1x [D] or (2x [E] and (no [C] or no [D])))',
        and(req(1, C), or(req(1, D), and(req(2, E), or(atMost(0, C), atMost(0, D))))),
      );
    });

    it('returns the canonical form: redundant parentheses leave no trace', () => {
      expectExpr('((1x [C]))', req(1, C));
      expectExpr('(1x [C] and 1x [D]) and 1x [E]', and(req(1, C), req(1, D), req(1, E)));
      expectExpr('1x [C] or (1x [D] or (1x [E]))', or(req(1, C), req(1, D), req(1, E)));
      expectExpr('1x level 4/2/4 monster', req(1, d('level 2/4 monster')));
    });

    it('keeps repeats: two requirements are two cards', () => {
      expectExpr('1x [C] and 1x [C]', and(req(1, C), req(1, C)));
      expectExpr('1x [C] or 1x [C]', or(req(1, C), req(1, C)));
    });
  });

  describe('the two ors', () => {
    it('continues the description when no term follows', () => {
      expectExpr('1x [C] or [E]', req(1, card(1, 3)));
      expectExpr('1x [C] or [E] or [D]', req(1, card(1, 3, 2)));
      expectExpr('1x level 4 monster or spell', req(1, d('level 4 monster or spell')));
      expectExpr('no [C] or [E]', atMost(0, card(1, 3)));
      expectExpr('at most 1x [C] or [E]', atMost(1, card(1, 3)));
    });

    it('chooses between terms when a count, at most or no follows', () => {
      expectExpr('1x [C] or 2x [D]', or(req(1, C), req(2, D)));
      expectExpr('1x [C] or 2×[D]', or(req(1, C), req(2, D)));
      expectExpr('1x [C] or no [D]', or(req(1, C), atMost(0, D)));
      expectExpr('1x [C] or at most 1x [D]', or(req(1, C), atMost(1, D)));
      expectExpr('no [C] or no [D]', or(atMost(0, C), atMost(0, D)));
    });

    it('takes a description in parentheses after a count', () => {
      expectExpr('1x ([C] or [E])', req(1, card(1, 3)));
      expectExpr('1x (([C]) or ([E] or [D]))', req(1, card(1, 3, 2)));
      expectExpr('no ([C] or [E])', atMost(0, card(1, 3)));
      expectExpr('at most 2x ([C] or [E])', atMost(2, card(1, 3)));
    });

    it('looks through parentheses after or', () => {
      expectExpr('1x [C] or ([E] or [D])', req(1, card(1, 3, 2)));
      expectExpr('1x [C] or (([E]))', req(1, card(1, 3)));
      expectExpr('1x [C] or (2x [D] and 1x [E])', or(req(1, C), and(req(2, D), req(1, E))));
      expectExpr('1x [C] or ((2x [D]))', or(req(1, C), req(2, D)));
      expectExpr('1x [C] or ((no [D]) and 1x [E])', or(req(1, C), and(atMost(0, D), req(1, E))));
    });

    it('looks through parentheses at the start of a term', () => {
      expectExpr('(1x [C] or [E])', req(1, card(1, 3)));
      expectExpr('((1x [C] or [E]) or 2x [D])', or(req(1, card(1, 3)), req(2, D)));
      expectExpr('((no [C]))', atMost(0, C));
    });

    it('mixes them', () => {
      expectExpr('1x [C] or [E] or 2x [D]', or(req(1, card(1, 3)), req(2, D)));
      expectExpr('1x [C] or 2x [D] or [E]', or(req(1, C), req(2, card(2, 3))));
      expectExpr('1x ([C] or [E]) or 2x ([D] or [E])', or(req(1, card(1, 3)), req(2, card(2, 3))));
      expectExpr('1x ([C] or [E]) or ([D] or [E])', req(1, card(1, 3, 2)));
      expectExpr('1x [C] or [E] and 1x [D]', and(req(1, card(1, 3)), req(1, D)));
      expectExpr(
        '(1x [C] or [E]) and (1x [D] or 1x [E])',
        and(req(1, card(1, 3)), or(req(1, D), req(1, E))),
      );
    });

    it('is not confused by or lower', () => {
      expectExpr(
        '1x level 4 or lower monster or 2x ATK 1500 or more monster or spell',
        or(req(1, d('level 4 or lower monster')), req(2, d('ATK 1500 or more monster or spell'))),
      );
    });
  });

  describe('counts and hex codes', () => {
    it('reads 0x2066 as one hex code, not as the count 0x', () => {
      const warriors = d('"Warrior":0x2066 monster');
      expectExpr('1x "Warrior":0x2066 monster', req(1, warriors));
      expectExpr('1x"Warrior":0x2066 monster', req(1, warriors));
      expectExpr('at most 0x "Warrior":0x2066 monster', atMost(0, warriors));
      expectExpr('at most 0x"Warrior":0X2066 monster', atMost(0, warriors));
      expectExpr(
        '1x "Warrior":0x2066 monster or 2x "Warrior":0x66 monster',
        or(req(1, warriors), req(2, d('"Warrior":0x66 monster'))),
      );
    });

    it('explains a count that ran into the next word', () => {
      expect(errorOf('at most 0xdark monster')).toMatchObject({
        message: expect.stringContaining('space'),
        at: '0xda',
      });
      expect(errorOf('0x2066 monster')).toMatchObject({ at: '0x2066' });
    });

    it('leaves a truncated hex code to the description parser', () => {
      expect(errorOf('1x "Warrior":0x monster')).toMatchObject({
        message: expect.stringContaining('hex setcode'),
        start: 13,
      });
    });
  });

  describe('range requirements', () => {
    it('reads `a-bx` as a requirement with a ceiling', () => {
      expectExpr('1-2x monster', range(1, 2, d('monster')));
      expectExpr('0-1x trap', range(0, 1, d('trap')));
      expectExpr('2-2x [C]', range(2, 2, C));
      expectExpr('0-0x [C]', range(0, 0, C));
    });

    it('reads the criterion Andy asked for', () => {
      expectExpr('1x [C], 1-2x monster', and(req(1, C), range(1, 2, d('monster'))));
    });

    it('takes a range wherever a plain count goes', () => {
      expectExpr('1-2x ([C] or [D])', range(1, 2, card(1, 2)));
      expectExpr('1x [C] or 1-2x monster', or(req(1, C), range(1, 2, d('monster'))));
      expectExpr(
        '1x [C] and (1-2x monster or 1x trap)',
        and(req(1, C), or(range(1, 2, d('monster')), req(1, d('trap')))),
      );
    });
  });

  describe('the exactly shorthand', () => {
    it('reads `exactly n` as the range `n-n`, x or no x', () => {
      expectExpr('exactly 1x monster', range(1, 1, d('monster')));
      expectExpr('exactly 1 monster', range(1, 1, d('monster')));
      expectExpr('exactly 2x [C]', range(2, 2, C));
      expectExpr('exactly 60x card', range(60, 60, d('card')));
    });

    it('is the same AST as the range spelt out, to the last key', () => {
      for (const [n, description] of [
        [0, '[C]'],
        [1, 'monster'],
        [2, '([C] or [D])'],
        [3, 'level 4 or lower FIRE monster'],
      ] as const) {
        const spelt = parseCriterion(`${n}-${n}x ${description}`, ctx);
        for (const text of [`exactly ${n}x ${description}`, `exactly ${n} ${description}`]) {
          expect(parseCriterion(text, ctx), text).toEqual(spelt);
          // Deep equality ignores key order; the canonical JSON is what is stored.
          expect(JSON.stringify(parseCriterion(text, ctx)), text).toBe(JSON.stringify(spelt));
        }
      }
    });

    it('accepts zero, which a plain count may not', () => {
      expectExpr('exactly 0x [C]', range(0, 0, C));
      expectExpr('exactly 0 monster', range(0, 0, d('monster')));
      // `0x monster` is still the error it was: a ceiling is what makes 0 mean something.
      expect(errorOf('0x monster').message).toMatch(/at least 1/);
    });

    it('accepts ×, a capital X and whatever spacing', () => {
      for (const count of ['2x', '2X', '2×', '2 x', '02x'])
        expectExpr(`EXACTLY ${count} spell`, range(2, 2, d('spell')));
      expectExpr('exactly 2×[C]', range(2, 2, C));
      expectExpr('exactly\t2x [C]', range(2, 2, C));
    });

    it('goes wherever a plain count goes', () => {
      expectExpr('1x [C], exactly 2x monster', and(req(1, C), range(2, 2, d('monster'))));
      expectExpr('1x [C] or exactly 2x [D]', or(req(1, C), range(2, 2, D)));
      expectExpr('(exactly 1x [C] or 1x [D])', or(range(1, 1, C), req(1, D)));
      expectExpr(
        '1x [C] and (exactly 1x monster or no trap)',
        and(req(1, C), or(range(1, 1, d('monster')), atMost(0, d('trap')))),
      );
      expectExpr('exactly 1x ([C] or [E])', range(1, 1, card(1, 3)));
      // The description runs on after `or`, exactly as it does after a plain count.
      expectExpr('exactly 1x [C] or [E]', range(1, 1, card(1, 3)));
    });

    it('refuses a range after it, naming both ways to write what was meant', () => {
      expect(errorOf('exactly 1-2x monster')).toMatchObject({
        message: expect.stringMatching(/one count.*exactly 1x.*1-2x/s),
        at: '1-2x',
      });
      expect(errorOf('1x [C], exactly 3-1 monster')).toMatchObject({ at: '3-1' });
    });

    it('is a requirement word, so no limit takes it', () => {
      expect(errorOf('at most exactly 1x trap')).toMatchObject({
        message: expect.stringContaining('expected a count after `at most`'),
        at: 'exactly',
      });
      expect(errorOf('exactly at most 1x trap')).toMatchObject({
        message: expect.stringContaining('expected a count after `exactly`'),
        at: 'at most',
      });
      expect(errorOf('exactly no trap')).toMatchObject({ at: 'no' });
    });

    it('asks for the count it lacks', () => {
      expect(errorOf('exactly monster')).toMatchObject({
        message: expect.stringContaining('exactly 1x monster'),
        at: 'monster',
      });
      expect(errorOf('exactly')).toMatchObject({ at: '', start: 7 });
      expect(errorOf('1x [C] and exactly')).toMatchObject({ at: '', start: 18 });
      expect(errorOf('exactly 0xdark monster')).toMatchObject({
        message: expect.stringContaining('space'),
        at: '0xda',
      });
    });

    it('refuses a count above 60, and a description that will not parse', () => {
      expect(errorOf('exactly 61x monster')).toMatchObject({
        message: expect.stringContaining('60'),
        at: '61x',
      });
      expect(errorOf('exactly 2x levle 4 monster')).toMatchObject({ at: 'levle' });
    });

    it('starts a term, so it may not stand inside a description', () => {
      expect(errorOf('1x ([C] or exactly 1x [D])')).toMatchObject({
        message: expect.stringContaining('inside'),
        at: 'exactly',
      });
      expect(errorOf('1x monster exactly 1x spell')).toMatchObject({
        message: expect.stringMatching(/`and`.*`or`/),
        at: 'exactly',
      });
    });
  });

  describe('unique requirements', () => {
    const unique = (n: number, desc: Description): Expr => ({ op: 'req', n, unique: true, desc });

    it('reads `n unique D`, the x optional as everywhere', () => {
      for (const count of ['3', '3x', '3X', '3×', '3 x'])
        expectExpr(`${count} unique [C]`, unique(3, C));
      expectExpr('2 UNIQUE monster', unique(2, d('monster')));
      expectExpr('1 unique ([C] or [D])', unique(1, card(1, 2)));
      // The description runs on after `or`, as it does after any count.
      expectExpr('2x unique [C] or [D]', unique(2, card(1, 2)));
    });

    it('goes wherever a requirement goes, and is never merged into one by the parser', () => {
      expectExpr('2 unique [C], 1x [D]', and(unique(2, C), req(1, D)));
      expectExpr('1x [C] or 2x unique [D]', or(req(1, C), unique(2, D)));
      expectExpr('2 unique [C] and 1 unique [C]', and(unique(2, C), unique(1, C)));
      expectExpr(
        '(2 unique [C] or no trap) and 1x [D]',
        and(or(unique(2, C), atMost(0, d('trap'))), req(1, D)),
      );
    });

    it('writes the key between the count and the description, and only when it is set', () => {
      const parsed = parseCriterion('3x unique [C]', ctx);
      expect(JSON.stringify(parsed)).toBe(
        `{"ok":true,"expr":{"op":"req","n":3,"unique":true,"desc":${JSON.stringify(C)}}}`,
      );
      expect(JSON.stringify(parseCriterion('3x [C]', ctx))).toBe(
        `{"ok":true,"expr":{"op":"req","n":3,"desc":${JSON.stringify(C)}}}`,
      );
    });

    it('takes a ceiling as any requirement does: `exactly n unique`, `a-b unique`, `0-b unique`', () => {
      const ranged = (n: number, max: number, desc: Description): Expr => ({
        op: 'req',
        n,
        max,
        unique: true,
        desc,
      });
      for (const count of ['2', '2x', '2 x'])
        expectExpr(`exactly ${count} unique [C]`, ranged(2, 2, C));
      for (const count of ['2-3', '2-3x', '2-3×'])
        expectExpr(`${count} unique [C]`, ranged(2, 3, C));
      expectExpr('0-1 unique [C]', ranged(0, 1, C));
      expectExpr('exactly 2 unique [C], 1x [C]', and(ranged(2, 2, C), req(1, C)));
      // `exactly n` is the range `[n, n]` here as everywhere: one node for both.
      expect(parseCriterion('exactly 2 unique [C]', ctx)).toEqual(
        parseCriterion('2-2x unique [C]', ctx),
      );
      expect(JSON.stringify(parseCriterion('2-3x unique [C]', ctx))).toBe(
        `{"ok":true,"expr":{"op":"req","n":2,"max":3,"unique":true,"desc":${JSON.stringify(C)}}}`,
      );
    });

    it('refuses a range that runs high to low, as for any requirement', () => {
      expect(errorOf('3-2 unique [C]')).toMatchObject({
        message: expect.stringContaining('a range runs low to high'),
        at: '3-2',
      });
    });

    it('is refused on a limit, with the span of the count and the word', () => {
      expect(errorOf('at most 2 unique [C]')).toMatchObject({
        message: expect.stringContaining('a limit counts copies and takes no `unique`'),
        at: 'at most 2 unique',
      });
      expect(errorOf('at most 2 unique [C]').message).toContain('`at most 2x …`');
      expect(errorOf('no unique [C]')).toMatchObject({
        message: expect.stringContaining('write `no …`'),
        at: 'no unique',
      });
      expect(errorOf('1x [D] and no unique [C]')).toMatchObject({ at: 'no unique', start: 11 });
    });

    it('needs its count, and needs it straight before it', () => {
      expect(errorOf('unique [C]')).toMatchObject({
        message: expect.stringContaining('`unique` needs a count before it'),
        at: 'unique',
      });
      expect(errorOf('1x [D] and unique [C]')).toMatchObject({ at: 'unique' });
      expect(errorOf('3x [C] unique')).toMatchObject({
        message: expect.stringContaining('`unique` goes straight after a count'),
        at: 'unique',
      });
      expect(errorOf('3x unique unique [C]')).toMatchObject({ at: 'unique', start: 10 });
      expect(errorOf('1x ([C] or unique [D])')).toMatchObject({ at: 'unique' });
      expect(errorOf('3 unique')).toMatchObject({ at: '', start: 8 });
    });

    it('says a count after `or` keeps its x, when that is what went wrong', () => {
      expect(errorOf('1x [C] or 2 unique [D]')).toMatchObject({
        message: expect.stringContaining('`or 3x unique {starter}`'),
        at: 'unique',
      });
      expectExpr('1x [C] or 2x unique [D]', or(req(1, C), unique(2, D)));
    });

    it('refuses 0, as any requirement without a ceiling does', () => {
      expect(errorOf('0 unique [C]').message).toMatch(/at least 1/);
    });

    it('is a whole word: a card name holding it is only a name', () => {
      const named = contextOf(new FakeCards([cardRecord({ code: 9, name: 'Unique Dragon' })]));
      expect(parseCriterion('2x unique [Unique Dragon]', named)).toEqual({
        ok: true,
        expr: unique(2, card(9)),
      });
    });
  });

  describe('a count without its x', () => {
    it('reads a plain integer where a term must start', () => {
      expectExpr('2 monsters', req(2, d('monster')));
      expectExpr('1x [C], 2 monster', and(req(1, C), req(2, d('monster'))));
      expectExpr('at most 2 trap', atMost(2, d('trap')));
      expectExpr(
        '1x [C] and (2 monster and 1x trap)',
        and(req(1, C), req(2, d('monster')), req(1, d('trap'))),
      );
    });

    it('reads a range without its x the same way', () => {
      expectExpr('1-2 monster', range(1, 2, d('monster')));
      expectExpr('1x [C], 1-2 monster', and(req(1, C), range(1, 2, d('monster'))));
      expectExpr('1 - 2 monster', range(1, 2, d('monster')));
    });

    it("keeps a description's own leading number: `2000 ATK monster` is not a count", () => {
      // After `or`, a description may continue, so only an `x` makes a count.
      expectExpr('1x ([C] or 2000 ATK monster)', req(1, d('[C] or 2000 ATK monster')));
      expectExpr('1x [C] or 2000 ATK monster', req(1, d('[C] or 2000 ATK monster')));
      // A count there keeps its `x`, and then it IS a term.
      expectExpr('1x [C] or 2x monster', or(req(1, C), req(2, d('monster'))));
    });

    it('says so when a description after `or` was meant to be a count', () => {
      // `2 [D]` is not a description, and the likeliest thing meant is `2x [D]`.
      expect(errorOf('1x [C] or 2 [D]').message).toContain('a count after `or` keeps its `x`');
    });

    it('still asks for a count when the number is too large to be one', () => {
      expect(errorOf('2000 ATK monster')).toMatchObject({
        message: expect.stringContaining('expected a count before the description'),
        at: '2000',
      });
    });

    it('does not eat a level range: `1 level 2-4 monster` counts one, levels two to four', () => {
      expectExpr('1 level 2-4 monster', req(1, d('level 2-4 monster')));
      expectExpr('1-2 level 2-4 monster', range(1, 2, d('level 2-4 monster')));
      expectExpr('1x level 2-4 monster', req(1, d('level 2-4 monster')));
    });
  });

  describe('the sixth card, after then', () => {
    const split = (five: Expr | undefined, sixth: Expr): Expr =>
      five === undefined ? { op: 'split', sixth } : { op: 'split', five, sixth };

    it('separates the five cards opened on from the one drawn', () => {
      expectExpr('1x [C] then 1x [D]', split(req(1, C), req(1, D)));
      expectExpr('no [C] then no [D]', split(atMost(0, C), atMost(0, D)));
    });

    it('binds looser than and and or, so neither side needs parentheses', () => {
      expectExpr(
        '1x [C] and 1x [D] then 1x [E] or no [C]',
        split(and(req(1, C), req(1, D)), or(req(1, E), atMost(0, C))),
      );
      expectExpr('1x [C] or 2x [D] then 1x [E]', split(or(req(1, C), req(2, D)), req(1, E)));
    });

    it('may lead, which leaves the opening five unasked about', () => {
      expectExpr('then 1x [C]', split(undefined, req(1, C)));
      expectExpr('then no [C] and no [D]', split(undefined, and(atMost(0, C), atMost(0, D))));
    });

    it('allows a limit and a range of one card, which are questions about one card', () => {
      expectExpr('1x [C] then at most 1x [D]', split(req(1, C), atMost(1, D)));
      expectExpr('1x [C] then exactly 1x [D]', split(req(1, C), range(1, 1, D)));
      expectExpr('1x [C] then 0-1x [D]', split(req(1, C), range(0, 1, D)));
    });

    it('refuses more than one card of it by default, naming what asked', () => {
      expect(errorOf('1x [C] then 2x [D]')).toEqual({
        message:
          'the card you draw is one card, and this asks 2 of it: after `then`, write one requirement — `1x …` — or limits alone, as in `no trap`. Mark a line as drawing cards and `then` becomes about everything you drew, which can be more than one',
        at: '2x [D]',
        start: 12,
      });
      // `and` sums the slots; `or` takes the worse branch, which is what a
      // branch that can never hold would be.
      expect(errorOf('then 1x [C] and 1x [D]').message).toContain('asks 2 of it');
      expect(errorOf('then 1x [C] or 2x [D]').message).toContain('asks 2 of it');
      // A limit beside the one requirement costs no card.
      expect(parseCriterion('then 1x [C] and no [D]', ctx).ok).toBe(true);
    });

    /**
     * The BOUND IS THE TEMPLATE'S, not the text's (PRD §5.7). With draw cards
     * the drawn set is the card drawn for turn plus everything they fetched, so
     * the same text is a mistake in one template and a question in another —
     * and the parser is told which, rather than guessing.
     */
    describe('with draw cards, where the drawn set is larger', () => {
      it('accepts as many slots as the drawn set can hold', () => {
        expect(parseCriterion('1x [C] then 2x [D]', ctx, { maxDrawnSlots: 3 }).ok).toBe(true);
        expect(parseCriterion('then 3x [D]', ctx, { maxDrawnSlots: 3 }).ok).toBe(true);
      });

      it('still refuses what the drawn set cannot hold, and says how many it holds', () => {
        expect(errorOf('then 4x [D]', { maxDrawnSlots: 3 })).toEqual({
          message:
            'you draw at most 3 cards here, and this asks 4 of them: after `then`, write at most 3 requirement slot(s), or limits alone, as in `no trap`',
          at: '4x [D]',
          start: 5,
        });
      });

      it('names one card again where nothing draws, which is the default', () => {
        expect(parseCriterion('then 2x [D]', ctx, { maxDrawnSlots: 1 }).ok).toBe(false);
        expect(parseCriterion('then 2x [D]', ctx).ok).toBe(false);
      });
    });

    it('refuses a second then: the hand comes in two pieces, not three', () => {
      expect(errorOf('1x [C] then 1x [D] then 1x [E]')).toEqual({
        message:
          'a criterion has one `then`: it separates the cards you open on from the cards you draw, and the hand comes in two pieces, not three',
        at: 'then',
        start: 19,
      });
      // A doubled `then` has nothing where a term must start, and the message
      // names the word it came after.
      expect(errorOf('then then 1x [C]').message).toContain('after `then`');
    });

    it('refuses nothing after it', () => {
      for (const text of ['1x [C] then', 'then']) {
        const { message } = errorOf(text);
        expect(message, text).toContain('what the cards you draw must be after `then`');
      }
      expect(errorOf('1x [C] then').start).toBe(11);
    });

    it('refuses it inside parentheses, which is not where it stands', () => {
      expect(errorOf('(1x [C] then 1x [D]) and 1x [E]')).toEqual({
        message:
          '`then` separates the five cards you open on from the one you draw, so it stands between them and not inside parentheses',
        at: 'then',
        start: 8,
      });
      expect(errorOf('1x ([C] then [D])').message).toContain(
        "cannot stand inside a description's parentheses",
      );
    });
  });

  describe('the whole hand, after finally', () => {
    type Split = Extract<Expr, { op: 'split' }>;
    const split = (parts: Omit<Split, 'op'>): Expr => ({ op: 'split', ...parts });

    it('asks a full criterion of the whole hand, beside one of the first five', () => {
      expectExpr('1x [C] finally 1x [D]', split({ five: req(1, C), whole: req(1, D) }));
      // A FULL criterion: requirements, limits, ranges, `and`, `or`, nesting —
      // everything an unsplit criterion may hold, which is what `then` may not.
      expectExpr(
        '1x [C] finally 2x [D] and no [E]',
        split({ five: req(1, C), whole: and(req(2, D), atMost(0, E)) }),
      );
      expectExpr(
        '1x [C] finally 1x [D] or (1x [E] and at most 1x [C])',
        split({ five: req(1, C), whole: or(req(1, D), and(req(1, E), atMost(1, C))) }),
      );
      expectExpr('1x [C] finally 1-2x [D]', split({ five: req(1, C), whole: range(1, 2, D) }));
    });

    it('binds looser than `and` and `or`, so the whole of what precedes it is the opening part', () => {
      expectExpr(
        '1x [C] and 1x [D] finally 1x [E] or no [C]',
        split({ five: and(req(1, C), req(1, D)), whole: or(req(1, E), atMost(0, C)) }),
      );
      expectExpr(
        '1x [C] or 2x [D] finally 1x [E]',
        split({ five: or(req(1, C), req(2, D)), whole: req(1, E) }),
      );
    });

    it('binds looser than `then`, and the two come in window order', () => {
      expectExpr(
        '1x [C] then 1x [D] finally 2x [E]',
        split({ five: req(1, C), sixth: req(1, D), whole: req(2, E) }),
      );
      expectExpr('then 1x [D] finally 2x [E]', split({ sixth: req(1, D), whole: req(2, E) }));
      expectExpr(
        '1x [C] and no [D] then no [E] finally 1x [D] and at most 2x [C]',
        split({
          five: and(req(1, C), atMost(0, D)),
          sixth: atMost(0, E),
          whole: and(req(1, D), atMost(2, C)),
        }),
      );
    });

    it('leaves the five unasked about when `finally` leads', () => {
      expectExpr('finally 1x [C]', split({ whole: req(1, C) }));
      expectExpr('finally no [C] and no [D]', split({ whole: and(atMost(0, C), atMost(0, D)) }));
    });

    /**
     * It is the WHOLE HAND and not the cards drawn, so the one-card bound that
     * `then` carries does not apply: `finally 2x [D]` is a question about six
     * cards, and a perfectly ordinary one.
     */
    it('asks for more than one card, which `then` may not', () => {
      expectExpr('finally 2x [D]', split({ whole: req(2, D) }));
      expect(parseCriterion('1x [C] then 2x [D]', ctx).ok).toBe(false);
      expect(parseCriterion('1x [C] finally 2x [D]', ctx).ok).toBe(true);
      // And a `finally` asking more than any hand holds is DROPPED by `expand`,
      // exactly as `7x [D]` on its own is — never refused on the text, because
      // its window IS the whole hand and the two readings must not differ.
      expect(parseCriterion('finally 7x [D]', ctx).ok).toBe(true);
      expect(parseCriterion('7x [D]', ctx).ok).toBe(true);
    });

    it('refuses a second finally: there is one hand', () => {
      expect(errorOf('1x [C] finally 1x [D] finally 1x [E]')).toEqual({
        message:
          'a criterion has one `finally`: it is a question about the whole hand, and there is one hand',
        at: 'finally',
        start: 22,
      });
      // A doubled `finally` has nothing where a term must start.
      expect(errorOf('finally finally 1x [C]').message).toContain('after `finally`');
    });

    it('refuses a `then` after it, naming the order the two come in', () => {
      expect(errorOf('1x [C] finally 1x [D] then 1x [E]')).toEqual({
        message:
          '`then` comes before `finally`: the cards you draw first, then the whole hand they leave you with',
        at: 'then',
        start: 22,
      });
    });

    it('asks what the whole hand must be when nothing follows it', () => {
      for (const text of ['1x [C] finally', 'finally']) {
        const { message } = errorOf(text);
        expect(message, text).toContain('what the whole hand must be after `finally`');
      }
      expect(errorOf('1x [C] finally').start).toBe(14);
    });

    it('refuses it inside parentheses, which is not where it stands', () => {
      expect(errorOf('(1x [C] finally 1x [D]) and 1x [E]')).toEqual({
        message:
          '`finally` separates the cards you were dealt from the whole hand they make, so it stands between them and not inside parentheses',
        at: 'finally',
        start: 8,
      });
      expect(errorOf('1x ([C] finally [D])').message).toContain(
        "cannot stand inside a description's parentheses",
      );
    });

    /**
     * A `finally` part may not itself be split — the windows are three and they
     * are fixed. The grammar refuses it by having nowhere to put a second
     * separator, and `validateExpr` refuses the stored shape in the same words.
     */
    it('refuses a `then` or a `finally` inside the `finally` part', () => {
      expect(errorOf('1x [C] finally (1x [D] then 1x [E])').message).toContain(
        'not inside parentheses',
      );
      expect(errorOf('1x [C] finally (1x [D] finally 1x [E])').message).toContain(
        'not inside parentheses',
      );
    });

    /** `finally` is a whole word, exactly as `then` is: a name holding it is untouched. */
    it('reads `finally` only as a whole word', () => {
      expectExpr('1x [Live and Let Die or 2x No More (at most)]', req(1, card(5)));
      expect(parseCriterion('1x finallyx monster', ctx).ok).toBe(false);
    });
  });

  describe('errors', () => {
    it('asks for a term when there is nothing', () => {
      for (const text of ['', '   '])
        expect(errorOf(text)).toMatchObject({
          message: expect.stringContaining('expected a requirement'),
          at: '',
          start: text.length,
        });
    });

    it('asks for the count a description lacks', () => {
      expect(errorOf('monster')).toMatchObject({
        message: expect.stringContaining('count'),
        at: 'monster',
      });
      expect(errorOf('1x [C] and level 4 monster')).toMatchObject({ at: 'level' });
      expect(errorOf('([C] or [E])')).toMatchObject({
        message: expect.stringContaining('count'),
        at: '[C]',
      });
      // `2 monsters` used to be this error; the `x` is optional now — see
      // `a count without its x`, which owns that case.
    });

    it('refuses a range that runs high to low, naming the one meant', () => {
      expect(errorOf('4-2x monster')).toMatchObject({
        message: expect.stringContaining('write `2-4x`'),
        at: '4-2x',
      });
      expect(errorOf('1x [C], 3-1 monster')).toMatchObject({ at: '3-1' });
    });

    it('refuses a range on a limit, which has one ceiling', () => {
      expect(errorOf('at most 1-2x trap')).toMatchObject({
        message: expect.stringMatching(/one ceiling.*at most 2x/s),
        at: '1-2x',
      });
    });

    it('refuses a range whose either end is above 60', () => {
      expect(errorOf('1-61x monster')).toMatchObject({
        message: expect.stringContaining('60'),
        at: '1-61x',
      });
      expect(errorOf('61-62x monster')).toMatchObject({ message: expect.stringContaining('60') });
    });

    it('refuses a requirement of no cards, pointing at no', () => {
      expect(errorOf('1x [C] and 0x monster')).toMatchObject({
        message: expect.stringMatching(/at least 1.*`no/),
        at: '0x',
      });
    });

    it('refuses a count above 60, however long', () => {
      for (const count of ['61x', '99999999999999999999999x', `${'9'.repeat(400)}x`]) {
        expect(errorOf(`${count} monster`)).toMatchObject({
          message: expect.stringContaining('60'),
          at: count,
        });
        expect(errorOf(`at most ${count} monster`)).toMatchObject({ at: count });
      }
    });

    it('asks for the count at most lacks', () => {
      expect(errorOf('at most monster')).toMatchObject({
        message: expect.stringContaining('at most 1x'),
        at: 'monster',
      });
      expect(errorOf('at most')).toMatchObject({ at: '', start: 7 });
      // `at most 2 monster` used to be this error; the `x` is optional now.
    });

    it('reports a dangling and, comma or or', () => {
      expect(errorOf('1x [C] and')).toMatchObject({
        message: expect.stringContaining('after `and`'),
        start: 10,
      });
      expect(errorOf('1x [C],')).toMatchObject({ message: expect.stringContaining('after `,`') });
      expect(errorOf('1x [C] and and 1x [D]')).toMatchObject({ at: 'and', start: 11 });
      expect(errorOf('and 1x [C]')).toMatchObject({ at: 'and', start: 0 });
      expect(errorOf(', 1x [C]')).toMatchObject({ at: ',' });
      expect(errorOf('or 1x [C]')).toMatchObject({ at: 'or', start: 0 });
      expect(errorOf('1x [C] and or 1x [D]')).toMatchObject({ at: 'or' });
      expect(errorOf('(1x [C] and) or 1x [D]')).toMatchObject({ at: ')' });
      // After `or` a description may follow, so it is the description parser that speaks.
      expect(errorOf('1x [C] or')).toMatchObject({
        message: expect.stringContaining('after `or`'),
        start: 9,
      });
      expect(errorOf('1x [C] or or 2x [D]')).toMatchObject({ at: 'or', start: 10 });
      expect(errorOf('1x [C] or and 1x [D]')).toMatchObject({ at: 'and' });
      expect(errorOf('(1x [C] or 1x [D]) or')).toMatchObject({
        message: expect.stringContaining('after `or`'),
        at: '',
      });
    });

    it('reports unbalanced parentheses', () => {
      expect(errorOf('(1x [C] and 1x [D]')).toMatchObject({
        message: expect.stringContaining('never closed'),
        at: '(',
        start: 0,
      });
      expect(errorOf('((1x [C])')).toMatchObject({ at: '(', start: 0 });
      expect(errorOf('1x [C])')).toMatchObject({
        message: expect.stringContaining('no matching'),
        at: ')',
      });
      expect(errorOf('(1x [C])) and 1x [D]')).toMatchObject({ at: ')', start: 8 });
      expect(errorOf('1x ([C] or [E]')).toMatchObject({
        message: expect.stringContaining('never closed'),
        at: '(',
        start: 3,
      });
    });

    it('reports an empty group', () => {
      expect(errorOf('()')).toMatchObject({
        message: expect.stringContaining('nothing between'),
        at: '()',
      });
      expect(errorOf('1x [C] and ( ( ) )')).toMatchObject({ at: '( ( )' });
      expect(errorOf('1x [C] and (')).toMatchObject({ at: '', start: 12 });
      expect(errorOf('1x ()')).toMatchObject({
        message: expect.stringContaining('expected a description'),
        at: ')',
      });
    });

    it('asks for and or or between two terms', () => {
      expect(errorOf('1x [C] 2x [D]')).toMatchObject({
        message: expect.stringMatching(/`and`.*`or`/),
        at: '2x',
      });
      expect(errorOf('1x monster no spell')).toMatchObject({ at: 'no' });
      expect(errorOf('1x monster at most 1x spell')).toMatchObject({ at: 'at most' });
      expect(errorOf('(1x [C]) 2x [D]')).toMatchObject({ at: '2x' });
      expect(errorOf('(1x [C]) [D]')).toMatchObject({
        message: expect.stringMatching(/`and`.*`or`/),
        at: '[D]',
      });
      expect(errorOf('(1x [C]) (1x [D])')).toMatchObject({ at: '(', start: 9 });
    });

    it('keeps criterion words out of a description’s parentheses', () => {
      expect(errorOf('1x ([C] and [E])')).toMatchObject({
        message: expect.stringContaining('inside'),
        at: 'and',
      });
      expect(errorOf('1x ([C], [E])')).toMatchObject({ at: ',' });
      expect(errorOf('1x ([C] or 2x [D])')).toMatchObject({
        message: expect.stringContaining('inside'),
        at: '2x',
      });
      expect(errorOf('1x ([C] or no [D])')).toMatchObject({ at: 'no' });
    });

    it('caps the nesting', () => {
      const deep = (n: number) => `${'('.repeat(n)}1x [C]${')'.repeat(n)}`;
      expectExpr(deep(32), req(1, C));
      expect(errorOf(deep(33))).toMatchObject({
        message: expect.stringContaining('nested'),
        at: '(',
        start: 32,
      });
      expect(parseCriterion(deep(20000), ctx).ok).toBe(false);
      expect(parseCriterion(`1x ${'('.repeat(20000)}`, ctx).ok).toBe(false);
    });

    describe('from the description, with spans into the whole text', () => {
      it('passes on a parse error', () => {
        const text = '1x monster and 2x levle 4 monster';
        expect(errorOf(text)).toMatchObject({
          message: expect.stringContaining('unknown word "levle"'),
          at: 'levle',
          start: 18,
        });
        expect(errorOf('no [C] or 1x [Nobody]')).toMatchObject({
          message: expect.stringContaining('no card is named'),
          at: '[Nobody]',
        });
        expect(errorOf('1x [C], 1x level 4 level 5 monster')).toMatchObject({ at: 'level 5' });
        expect(errorOf('1x [C] monster or 2x [D]')).toMatchObject({ at: '[C]' });
      });

      it('points a missing description at what stands in its place', () => {
        expect(errorOf('1x and 1x [C]')).toMatchObject({
          message: expect.stringContaining('expected a description'),
          at: 'and',
        });
        expect(errorOf('1x [C] and 2x')).toMatchObject({ at: '', start: 13 });
        expect(errorOf('1x 2x [C]')).toMatchObject({ at: '2x' });
        expect(errorOf('(no) and 1x [C]')).toMatchObject({ at: ')' });
      });

      it('passes on a lex error', () => {
        expect(errorOf('1x monster and 1x [Unclosed')).toMatchObject({
          message: expect.stringContaining('never closed'),
          at: '[Unclosed',
        });
        expect(errorOf('1x monster & 1x spell')).toMatchObject({
          message: expect.stringContaining('unexpected character &'),
          at: '&',
        });
      });
    });

    it('never throws, and keeps every span inside the text', () => {
      const rng = seededRng(0xc417e410);
      const pieces = [
        ...['1x', '2×', '0x', '61x', 'at most', 'no', 'exactly', 'and', ',', 'or', '(', ')'],
        ...['[C]', '[D]'],
        ...['[Nobody]', 'monster', 'spell', 'level 4', 'or lower', 'FIRE', 'non-', '0x66', '7'],
        ...['"Warrior":0x2066', '#1', '#9', '{Starters}', 'ATK ?', '/', '-', ':', 'x', '×', 'at'],
        ...['most', 'levle', '&', '['],
      ];
      const descriptions = ['[C]', '[D] or [E]', 'level 4 or lower monster', 'spell/trap'].map(d);
      const options = {
        desc: () => rng.pick(descriptions),
        maxDepth: 3,
        maxArgs: 3,
        limitChance: 0.3,
      };
      let ok = 0;
      let failed = 0;
      for (let i = 0; i < 4000; i++) {
        // A criterion that parses, with up to three words dropped, doubled or replaced.
        const words = printCriterion(genExpr(rng, options), ctx).split(' ');
        for (let edits = rng.int(0, 3); edits > 0; edits--) {
          const at = rng.int(0, words.length - 1);
          words.splice(at, rng.int(0, 1), ...rng.subset(pieces, 0, 2));
        }
        const text = words.join(rng.chance(0.9) ? ' ' : '');
        const result = parseCriterion(text, ctx);
        if (result.ok) ok++;
        else {
          failed++;
          expect(result.message, text).not.toBe('');
          expect(result.span.start, text).toBeGreaterThanOrEqual(0);
          expect(result.span.end, text).toBeGreaterThanOrEqual(result.span.start);
          expect(result.span.end, text).toBeLessThanOrEqual(text.length);
        }
      }
      expect(ok).toBeGreaterThan(1000);
      expect(failed).toBeGreaterThan(1000);
    });
  });
});
