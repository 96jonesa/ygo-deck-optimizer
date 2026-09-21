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
  describe('a split', () => {
    it('accepts what the parser produces, either side present or not', () => {
      for (const text of [
        '1x monster then 1x #89631139',
        'then no trap',
        '1x monster or 2x spell then 1x trap or no spell',
      ])
        expect(errors(ast(text)), text).toEqual([]);
    });

    it('refuses one below the root: a hand comes in two pieces, not four', () => {
      const split = { op: 'split', sixth: REQ };
      expect(errors({ op: 'and', args: [split, REQ] })).toEqual([
        'expr.args[0]: `split` is the whole of a criterion — the five cards you open on, then the one you draw — and cannot stand inside `and`, `or` or another `split`',
      ]);
      expect(errors({ op: 'split', five: split, sixth: REQ })[0]).toContain('cannot stand inside');
      expect(errors({ op: 'split', sixth: split })[0]).toContain('cannot stand inside');
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
