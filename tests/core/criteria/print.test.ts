import { describe, expect, it } from 'vitest';
import type { Expr } from '../../../src/core/criteria/ast';
import { parseCriterion } from '../../../src/core/criteria/parser';
import { printCriterion } from '../../../src/core/criteria/print';
import type { Description } from '../../../src/core/desc/ast';
import { parse } from '../../../src/core/desc/parser';
import { cardRecord, contextOf, FakeCards } from '../../helpers/desc-context';
import { genExpr, uncanonical } from '../../helpers/gen-criteria';
import { type GenPool, genDescription } from '../../helpers/gen-desc';
import { seededRng } from '../../helpers/prng';

const PASSCODES = [1, 2, 3, 27204311, 89631139];
const ctx = contextOf(new FakeCards(PASSCODES.map((code) => cardRecord({ code }))));
const noSetnames = contextOf(ctx.cards, { setnames: null });

function d(text: string): Description {
  const result = parse(text, ctx);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.desc;
}

function req(n: number, text: string): Expr {
  return { op: 'req', n, desc: d(text) };
}

function atMost(n: number, text: string): Expr {
  return { op: 'atMost', n, desc: d(text) };
}

function and(...args: Expr[]): Expr {
  return { op: 'and', args };
}

function or(...args: Expr[]): Expr {
  return { op: 'or', args };
}

describe('printCriterion', () => {
  it('prints a requirement as its count and the canonical description', () => {
    expect(printCriterion(req(1, 'monsters'), ctx)).toBe('1x monster');
    expect(printCriterion(req(3, 'fire level 4 or lower'), ctx)).toBe(
      '3x level 4 or lower FIRE card',
    );
    expect(printCriterion(req(2, '"Warrior":0x2066 monster'), ctx)).toBe(
      '2x "Warrior":0x2066 monster',
    );
  });

  it('prints a range requirement as `a-bx`, always with its x', () => {
    expect(printCriterion({ op: 'req', n: 1, max: 2, desc: d('monsters') }, ctx)).toBe(
      '1-2x monster',
    );
    expect(printCriterion({ op: 'req', n: 0, max: 1, desc: d('trap') }, ctx)).toBe('0-1x trap');
    // `[2, 2]` is not `2x`: one has a ceiling and the other has none.
    expect(printCriterion({ op: 'req', n: 2, max: 2, desc: d('#1') }, ctx)).toBe('2-2x #1');
    expect(printCriterion({ op: 'req', n: 1, max: 2, desc: d('#1 or #2') }, ctx)).toBe(
      '1-2x (#1 or #2)',
    );
  });

  it('prints a limit as at most, and as no when nothing is allowed', () => {
    expect(printCriterion(atMost(2, 'trap'), ctx)).toBe('at most 2x trap');
    expect(printCriterion(atMost(1, '#2'), ctx)).toBe('at most 1x #2');
    expect(printCriterion(atMost(0, 'trap'), ctx)).toBe('no trap');
  });

  it('always puts a description-level or in parentheses', () => {
    expect(printCriterion(req(1, '#1 or #2'), ctx)).toBe('1x (#1 or #2)');
    expect(printCriterion(atMost(0, 'spell or trap'), ctx)).toBe('no (spell or trap)');
    expect(printCriterion(atMost(2, '#1 or level 4 monster'), ctx)).toBe(
      'at most 2x (#1 or level 4 monster)',
    );
    expect(printCriterion(or(req(1, '#1 or #2'), req(2, '#3')), ctx)).toBe(
      '1x (#1 or #2) or 2x #3',
    );
  });

  it('joins with and and or, and parenthesizes only an or inside an and', () => {
    expect(printCriterion(and(req(1, '#1'), req(1, '#2'), atMost(0, '#3')), ctx)).toBe(
      '1x #1 and 1x #2 and no #3',
    );
    expect(printCriterion(or(req(1, '#1'), and(req(1, '#2'), req(1, '#3'))), ctx)).toBe(
      '1x #1 or 1x #2 and 1x #3',
    );
    expect(
      printCriterion(and(req(1, '#1'), req(1, '#2'), or(req(1, '#3'), req(2, '#1'))), ctx),
    ).toBe('1x #1 and 1x #2 and (1x #3 or 2x #1)');
    expect(
      printCriterion(
        or(and(req(1, '#1'), or(req(1, '#2'), and(req(1, '#3'), atMost(1, '#2')))), req(2, '#3')),
        ctx,
      ),
    ).toBe('1x #1 and (1x #2 or 1x #3 and at most 1x #2) or 2x #3');
  });

  it('prints the canonical form of whatever it is given', () => {
    expect(printCriterion(and(and(or(req(1, '#1'), req(1, '#2'))), req(1, '#3')), ctx)).toBe(
      '(1x #1 or 1x #2) and 1x #3',
    );
    expect(printCriterion(or(or(req(1, '#1')), and(req(1, '#2'))), ctx)).toBe('1x #1 or 1x #2');
    const messy: Expr = {
      op: 'req',
      n: 1,
      desc: {
        anyOf: [{ t: 'clause', clause: { level: [4, 2, 4] } }, ...d('#1').anyOf, ...d('#1').anyOf],
      },
    };
    expect(printCriterion(messy, ctx)).toBe('1x (level 2/4 card or #1)');
  });

  it('prints archetypes by code when there is no setname table', () => {
    expect(printCriterion(req(1, '"Sky Striker" spell'), noSetnames)).toBe('1x "?":0x115 spell');
  });
});

describe('parseCriterion/printCriterion round trip (E3)', () => {
  const pool: GenPool = {
    passcodes: PASSCODES,
    groupIds: ['g-starters', 'g-hand-traps'],
    setcodes: [0x46, 0x66, 0x115, 0x534, 0x1066, 0x155a, 0x2066, 0x3066, 0x9999, 0xabc],
  };
  const options = {
    desc: (rng: Parameters<typeof genDescription>[0]) => genDescription(rng, pool),
    maxDepth: 4,
    maxArgs: 3,
    limitChance: 0.3,
  };

  it('round-trips 3,000 generated criteria that include RANGE requirements', () => {
    const rng = seededRng(0xe3e3a2e5);
    let ranges = 0;
    const counts = (expr: Expr): number =>
      expr.op === 'and' || expr.op === 'or'
        ? expr.args.reduce((sum, arg) => sum + counts(arg), 0)
        : expr.op === 'req' && expr.max !== undefined
          ? 1
          : 0;
    for (let i = 0; i < 3000; i++) {
      const expr = genExpr(rng, { ...options, rangeChance: 0.5 });
      ranges += counts(expr);
      const text = printCriterion(expr, ctx);
      expect(parseCriterion(text, ctx), `case ${i}: ${text}`).toEqual({ ok: true, expr });
    }
    expect(ranges).toBeGreaterThan(2000);
  });

  it('parses the canonical text of 3,000 generated criteria back to the same AST', () => {
    const rng = seededRng(0xe3e30001);
    for (let i = 0; i < 3000; i++) {
      const expr = genExpr(rng, options);
      const text = printCriterion(expr, ctx);
      const result = parseCriterion(text, ctx);
      expect(result, `case ${i}: ${text}`).toEqual({ ok: true, expr });
      // Deep equality ignores key order; the canonical form does not.
      if (result.ok) expect(JSON.stringify(result.expr), text).toBe(JSON.stringify(expr));
    }
  });

  it('round-trips without a setname table', () => {
    const rng = seededRng(0xe3e30002);
    for (let i = 0; i < 500; i++) {
      const expr = genExpr(rng, options);
      const text = printCriterion(expr, noSetnames);
      expect(parseCriterion(text, noSetnames), `case ${i}: ${text}`).toEqual({ ok: true, expr });
    }
  });

  it('prints a parsed criterion to text that is a fixed point, whatever noise it was given', () => {
    const rng = seededRng(0xe3e30003);
    for (let i = 0; i < 500; i++) {
      const expr = genExpr(rng, options);
      const text = printCriterion(expr, ctx);
      expect(printCriterion(uncanonical(rng, expr), ctx)).toBe(text);
      const result = parseCriterion(text, ctx);
      expect(result.ok && printCriterion(result.expr, ctx)).toBe(text);
    }
  });

  it('reads the comma, capitals and × as it reads its own text', () => {
    const rng = seededRng(0xe3e30004);
    for (let i = 0; i < 300; i++) {
      const expr = genExpr(rng, { ...options, desc: (r) => d(`#${r.pick(PASSCODES)}`) });
      const text = printCriterion(expr, ctx);
      const respelled = text
        .replaceAll(' and ', rng.chance(0.5) ? ', ' : ' AND ')
        .replaceAll(' or ', ' OR ')
        .replaceAll(/(\d)x /g, rng.chance(0.5) ? '$1× ' : '$1 X ')
        .replaceAll('no ', 'NO ');
      expect(parseCriterion(respelled, ctx), respelled).toEqual({ ok: true, expr });
    }
  });

  it('reads a description-level or the same without the parentheses the printer gives it', () => {
    const rng = seededRng(0xe3e30005);
    let bare = 0;
    for (let i = 0; i < 1000; i++) {
      const expr = genExpr(rng, options);
      const text = printCriterion(expr, ctx);
      // A description's parentheses follow a count or `no`; a group's never do.
      const stripped = text.replaceAll(/(\dx|no) \(([^()]*)\)/g, '$1 $2');
      if (stripped !== text) bare++;
      expect(parseCriterion(stripped, ctx), stripped).toEqual({ ok: true, expr });
    }
    expect(bare).toBeGreaterThan(500);
  });

  it('exercises every shape the generator is meant to cover', () => {
    const rng = seededRng(0xe3e30001);
    const seen = new Set<string>();
    const walk = (expr: Expr, parent: string) => {
      seen.add(`${expr.op} in ${parent}`);
      if (expr.op === 'req' || expr.op === 'atMost') {
        if (expr.op === 'atMost' && expr.n === 0) seen.add('no');
        if (expr.desc.anyOf.length > 1) seen.add(`description-level or in ${expr.op}`);
      } else for (const arg of expr.args) walk(arg, expr.op);
    };
    for (let i = 0; i < 3000; i++) walk(genExpr(rng, options), 'root');
    expect([...seen].sort()).toEqual(
      [
        'and in or',
        'and in root',
        'atMost in and',
        'atMost in or',
        'atMost in root',
        'description-level or in atMost',
        'description-level or in req',
        'no',
        'or in and',
        'or in root',
        'req in and',
        'req in or',
        'req in root',
      ].sort(),
    );
  });
});
