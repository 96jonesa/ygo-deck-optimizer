import { describe, expect, it } from 'vitest';
import { MAX_COUNT } from '../../../src/core/criteria/ast';
import { parseCriterion } from '../../../src/core/criteria/parser';
import { MAX_EXPR_DEPTH, validateExpr } from '../../../src/core/criteria/validate';
import { cardRecord, contextOf, FakeCards } from '../../helpers/desc-context';

const CTX = contextOf(new FakeCards([cardRecord({ code: 89631139, name: 'Blue-Eyes' })]));

/** The AST of `text`, as the parser produces it: the shape validation must accept. */
function ast(text: string): unknown {
  const parsed = parseCriterion(text, CTX);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.message}`);
  return JSON.parse(JSON.stringify(parsed.expr));
}

function errors(value: unknown): string[] {
  const result = validateExpr(value, 'expr');
  return result.ok ? [] : result.errors;
}

const REQ = { op: 'req', n: 1, desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'] } }] } };

describe('validateExpr', () => {
  describe('a unique requirement', () => {
    it('accepts what the parser produces, and gives it back canonical', () => {
      for (const text of [
        '3x unique monster',
        '1x #89631139 and 2x unique monster',
        'then 1x unique trap',
      ])
        expect(errors(ast(text)), text).toEqual([]);
      const result = validateExpr({ desc: REQ.desc, unique: true, n: 2, op: 'req' }, 'expr');
      if (!result.ok) throw new Error(result.errors.join('\n'));
      expect(Object.keys(result.expr)).toEqual(['op', 'n', 'unique', 'desc']);
    });

    it('accepts a ceiling, and a count of 0 beside one, with the keys in canonical order', () => {
      for (const text of ['exactly 2 unique monster', '2-3x unique monster', '0-1 unique monster'])
        expect(errors(ast(text)), text).toEqual([]);
      const result = validateExpr(
        { desc: REQ.desc, unique: true, max: 2, n: 0, op: 'req' },
        'expr',
      );
      if (!result.ok) throw new Error(result.errors.join('\n'));
      expect(Object.keys(result.expr)).toEqual(['op', 'n', 'max', 'unique', 'desc']);
    });

    it('refuses `unique` that is not `true`, of no cards and no ceiling, or on a limit', () => {
      expect(errors({ ...REQ, unique: false })).toEqual([
        'expr: `unique` is `true` or left out, not false',
      ]);
      expect(errors({ ...REQ, unique: 'yes' })[0]).toContain('not "yes"');
      expect(errors({ ...REQ, n: 3, max: 2, unique: true })[0]).toContain('counts up');
      expect(errors({ ...REQ, n: 0, unique: true })[0]).toContain('at least 1 card, not 0');
      expect(errors({ ...REQ, op: 'atMost', unique: true })).toEqual([
        'expr: a limit counts copies and has no `unique`',
      ]);
    });
  });

  describe('a split', () => {
    it('accepts what the parser produces, either side present or not', () => {
      for (const text of [
        '1x monster then 1x #89631139',
        'then no trap',
        '1x monster or 2x spell then 1x trap or no spell',
        // Every shape a `finally` part can come in (PRD §5.5).
        '1x monster then no trap finally 2x spell',
        '1x monster finally at most 1x trap',
        'then 1x #89631139 finally 2x monster',
        'finally 2x monster',
      ])
        expect(errors(ast(text)), text).toEqual([]);
    });

    /**
     * A split with NEITHER a drawn part nor a whole-hand part asks nothing that
     * an unsplit criterion does not ask — and would be judged over five cards by
     * `expand` and over six by anything reading `sixth`. No text writes it, so a
     * file holding one is a file to refuse rather than to guess about.
     */
    it('refuses a split that asks nothing at all', () => {
      expect(errors({ op: 'split' })).toEqual([
        'expr: a `split` needs a `five` (the opening five), a `sixth` (what you drew) or a `whole` (the whole hand) — with none it asks nothing',
      ]);
    });

    it('accepts the opening five alone: the opening-5 field filled by itself', () => {
      const result = validateExpr({ op: 'split', five: REQ }, 'expr');
      if (!result.ok) throw new Error(result.errors.join('\n'));
      expect(Object.keys(result.expr)).toEqual(['op', 'five']);
    });

    it('keeps the keys of a `finally` part in window order, canonical', () => {
      const result = validateExpr({ op: 'split', whole: REQ, sixth: REQ, five: REQ }, 'expr');
      if (!result.ok) throw new Error(result.errors.join('\n'));
      expect(Object.keys(result.expr)).toEqual(['op', 'five', 'sixth', 'whole']);
    });

    it('reports what is wrong inside a `finally` part, located', () => {
      expect(errors({ op: 'split', whole: { op: 'req' } })[0]).toContain('expr.whole');
    });

    it('refuses one below the root: a hand comes in three windows, not nine', () => {
      const split = { op: 'split', sixth: REQ };
      expect(errors({ op: 'and', args: [split, REQ] })).toEqual([
        'expr.args[0]: `split` is the whole of a criterion — the cards you open on, then the cards you draw, finally the whole hand — and cannot stand inside `and`, `or` or another `split`',
      ]);
      expect(errors({ op: 'split', five: split, sixth: REQ })[0]).toContain('cannot stand inside');
      expect(errors({ op: 'split', sixth: split })[0]).toContain('cannot stand inside');
      // The same check is what keeps a `then` or a `finally` out of a `finally` part.
      expect(errors({ op: 'split', whole: split })[0]).toContain('cannot stand inside');
      expect(errors({ op: 'split', whole: { op: 'split', whole: REQ } })[0]).toContain(
        'cannot stand inside',
      );
    });

    /**
     * HOW MANY CARDS `then` may ask for is a question about the TEMPLATE and
     * not about this expression: draw cards make the drawn set larger than one
     * card. So a stored AST asking for two is READ here and refused where the
     * bound is known — by the parser, which is given it, and by `expand`, which
     * refuses it for the run. Exactly the rule `stop` is read by.
     */
    it('reads a drawn part asking for two cards, and leaves the bound to the template', () => {
      const two: unknown = { op: 'split', sixth: { op: 'and', args: [REQ, REQ] } };
      expect(errors(two)).toEqual([]);
      const result = validateExpr(two, 'expr');
      if (!result.ok) throw new Error(result.errors.join('\n'));
      expect(result.expr).toMatchObject({ op: 'split' });
    });

    it('reports what is wrong inside either side, located', () => {
      expect(errors({ op: 'split', five: { op: 'req' }, sixth: REQ })[0]).toContain('expr.five');
      expect(errors({ op: 'split', sixth: { op: 'nand' } })[0]).toContain('expr.sixth');
    });

    it('gives back the canonical form, an absent five-card part left out', () => {
      const result = validateExpr({ op: 'split', sixth: { op: 'or', args: [REQ] } }, 'expr');
      if (!result.ok) throw new Error(result.errors.join('\n'));
      expect(result.expr).toEqual({ op: 'split', sixth: REQ });
      expect(Object.keys(result.expr)).toEqual(['op', 'sixth']);
    });
  });

  it('accepts every expression the parser produces', () => {
    for (const text of [
      '1x monster',
      '1x #89631139 and 1x monster',
      '1x monster or 2x spell',
      'exactly 2x monster',
      '1-2x monster and no trap',
      'at most 1x trap',
      '(1x monster or 1x spell) and 1x trap',
    ])
      expect(errors(ast(text))).toEqual([]);
  });

  it('gives back the CANONICAL form, descriptions included', () => {
    const result = validateExpr({ op: 'and', args: [{ op: 'and', args: [REQ] }] }, 'expr');
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.expr).toEqual(REQ);
  });

  it('refuses anything that is not an expression', () => {
    expect(errors(null)).toEqual(['expr: must be an expression object, not null']);
    expect(errors({ op: 'nand', args: [] })).toEqual([
      'expr: `op` must be "and", "or", "req", "atMost" or "split", not "nand"',
    ]);
  });

  it('refuses an `and` or `or` with no arguments: no criterion means that', () => {
    expect(errors({ op: 'and', args: [] })).toEqual(['expr: `and` needs at least one argument']);
    expect(errors({ op: 'or', args: 'both' })).toEqual(['expr: `args` must be a list, not "both"']);
  });

  it('refuses a count that is not a count', () => {
    expect(errors({ ...REQ, n: -1 })).toEqual([
      `expr: \`n\` must be a whole number from 0 to ${MAX_COUNT}, not -1`,
    ]);
    expect(errors({ ...REQ, n: MAX_COUNT + 1 })).toHaveLength(1);
    expect(errors({ op: 'atMost', n: 1.5, desc: REQ.desc })).toHaveLength(1);
  });

  it('refuses a requirement range whose ceiling is under its floor', () => {
    expect(errors({ ...REQ, n: 2, max: 1 })).toEqual([
      'expr: `max` 1 is less than `n` 2; a range requirement counts up',
    ]);
    expect(errors({ ...REQ, n: 2, max: 2 })).toEqual([]);
  });

  it('refuses a limit that carries a ceiling: `at most n` already is one', () => {
    expect(errors({ op: 'atMost', n: 1, max: 2, desc: REQ.desc })).toEqual([
      'expr: a limit has no `max`; `at most n` is the ceiling',
    ]);
  });

  it('carries the description validator’s own messages, located in the expression', () => {
    expect(errors({ op: 'req', n: 1, desc: { anyOf: [{ t: 'card', passcode: 0 }] } })).toEqual([
      'expr.desc.anyOf[0]: `passcode` must be a whole number above 0, not 0',
    ]);
  });

  it('refuses an expression nested past the parser’s own depth cap', () => {
    let deep: unknown = REQ;
    for (let n = 0; n <= MAX_EXPR_DEPTH; n++) deep = { op: 'and', args: [deep] };
    const [message, ...rest] = errors(deep);
    expect(rest).toEqual([]);
    expect(message).toContain(
      `nested more than ${MAX_EXPR_DEPTH} deep; no criterion is written that way`,
    );
    // The path locates the offending node, so a nesting cap is not a mystery.
    expect(message?.startsWith(`expr${'.args[0]'.repeat(MAX_EXPR_DEPTH + 1)}:`)).toBe(true);
  });

  it('reports every problem, not only the first', () => {
    expect(
      errors({
        op: 'or',
        args: [
          { ...REQ, n: -1 },
          { op: 'atMost', n: 99 },
        ],
      }),
    ).toHaveLength(3);
  });
});
