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
  describe('a split', () => {
    const split = (five: Expr | undefined, sixth: Expr): Expr =>
      five === undefined ? { op: 'split', sixth } : { op: 'split', five, sixth };

    it('writes then between the two parts', () => {
      expect(printCriterion(split(req(1, 'monster'), atMost(0, 'trap')), ctx)).toBe(
        '1x monster then no trap',
      );
    });

    it('leads with then when the opening five are unasked about', () => {
      expect(printCriterion(split(undefined, req(1, '#89631139')), ctx)).toBe('then 1x #89631139');
    });

    it('needs no parentheses on either side: then binds looser than both', () => {
      const text = printCriterion(
        split(or(req(1, 'monster'), req(2, 'spell')), or(req(1, 'trap'), atMost(0, 'spell'))),
        ctx,
      );
      expect(text).toBe('1x monster or 2x spell then 1x trap or no spell');
      // And it reads back as itself, which is what "no parentheses" has to mean.
      expect(parseCriterion(text, ctx)).toEqual({
        ok: true,
        expr: split(or(req(1, 'monster'), req(2, 'spell')), or(req(1, 'trap'), atMost(0, 'spell'))),
      });
    });

    it('round-trips every generated split', () => {
      const rng = seededRng(0x5171e2);
      let splits = 0;
      for (let i = 0; i < 400; i++) {
        const expr = genExpr(rng, {
          desc: () => d('monster'),
          maxDepth: 2,
          maxArgs: 3,
          limitChance: 0.3,
          splitChance: 0.6,
        });
        if (expr.op === 'split') splits++;
        const text = printCriterion(expr, ctx);
        expect(parseCriterion(text, ctx), text).toEqual({ ok: true, expr });
      }
      expect(splits).toBeGreaterThan(150);
    });

    /**
     * O7 — THE ROUND TRIP over every shape the split node can take, which is
     * four: the two dealt windows with a `finally` part, either one alone with
     * it, and a `finally` part alone. `parseCriterion(printCriterion(e))` must be
     * `e` STRUCTURALLY — key order included, since `meaning.ts` decides a stored
     * AST is stale by stringifying both.
     */
    describe('a `finally` part', () => {
      type Split = Extract<Expr, { op: 'split' }>;
      const parts = (over: Omit<Split, 'op'>): Expr => ({ op: 'split', ...over });

      const SHAPES: [string, Expr, string][] = [
        [
          'five + sixth + whole',
          parts({
            five: req(1, 'monster'),
            sixth: atMost(0, 'trap'),
            whole: req(2, 'spell'),
          }),
          '1x monster then no trap finally 2x spell',
        ],
        [
          'five + whole',
          parts({ five: req(1, 'monster'), whole: atMost(1, 'trap') }),
          '1x monster finally at most 1x trap',
        ],
        [
          'sixth + whole',
          parts({ sixth: req(1, '#89631139'), whole: req(2, 'monster') }),
          'then 1x #89631139 finally 2x monster',
        ],
        ['whole alone', parts({ whole: req(2, 'monster') }), 'finally 2x monster'],
      ];

      it.each(SHAPES)('writes %s in window order', (_shape, expr, text) => {
        expect(printCriterion(expr, ctx)).toBe(text);
      });

      it.each(SHAPES)(
        'reads %s back as itself, keys and their order alike',
        (_shape, expr, text) => {
          const result = parseCriterion(text, ctx);
          expect(result).toEqual({ ok: true, expr });
          if (!result.ok) throw new Error(result.message);
          expect(JSON.stringify(result.expr)).toBe(JSON.stringify(expr));
        },
      );

      it('needs no parentheses on any part: `finally` binds loosest of all', () => {
        const expr = parts({
          five: or(req(1, 'monster'), req(2, 'spell')),
          sixth: or(req(1, 'trap'), atMost(0, 'spell')),
          whole: or(req(1, 'monster'), atMost(1, 'trap')),
        });
        const text = printCriterion(expr, ctx);
        expect(text).toBe(
          '1x monster or 2x spell then 1x trap or no spell finally 1x monster or at most 1x trap',
        );
        expect(parseCriterion(text, ctx)).toEqual({ ok: true, expr });
      });

      it('round-trips every generated `finally`', () => {
        const rng = seededRng(0x5171e3);
        const shapes = new Set<string>();
        for (let i = 0; i < 600; i++) {
          const expr = genExpr(rng, {
            desc: () => d('monster'),
            maxDepth: 2,
            maxArgs: 3,
            limitChance: 0.3,
            splitChance: 0.5,
            wholeChance: 0.5,
          });
          if (expr.op === 'split')
            shapes.add(
              [
                expr.five === undefined ? '' : 'five',
                expr.sixth === undefined ? '' : 'sixth',
                expr.whole === undefined ? '' : 'whole',
              ]
                .filter((part) => part !== '')
                .join('+'),
            );
          const text = printCriterion(expr, ctx);
          expect(parseCriterion(text, ctx), text).toEqual({ ok: true, expr });
        }
        // Every shape the node can take, reached by the generator rather than listed.
        expect([...shapes].sort()).toEqual([
          'five+sixth',
          'five+sixth+whole',
          'five+whole',
          'sixth',
          'sixth+whole',
          'whole',
        ]);
      });
    });
  });

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
    expect(printCriterion({ op: 'req', n: 1, max: 2, desc: d('#1 or #2') }, ctx)).toBe(
      '1-2x (#1 or #2)',
    );
  });

  it('prints a range whose ends agree as `exactly nx`, ceiling and all', () => {
    // `[2, 2]` is not `2x`: one has a ceiling and the other has none, and the
    // shorthand is what keeps them apart while reading as what it means.
    expect(printCriterion({ op: 'req', n: 2, max: 2, desc: d('#1') }, ctx)).toBe('exactly 2x #1');
    expect(printCriterion({ op: 'req', n: 1, max: 1, desc: d('monsters') }, ctx)).toBe(
      'exactly 1x monster',
    );
    expect(printCriterion({ op: 'req', n: 0, max: 0, desc: d('trap') }, ctx)).toBe(
      'exactly 0x trap',
    );
    expect(printCriterion({ op: 'req', n: 1, max: 1, desc: d('#1 or #2') }, ctx)).toBe(
      'exactly 1x (#1 or #2)',
    );
    expect(
      printCriterion(and(req(1, '#1'), { op: 'req', n: 2, max: 2, desc: d('monsters') }), ctx),
    ).toBe('1x #1 and exactly 2x monster');
  });

  it('parses its own `exactly` back to the range it printed', () => {
    for (const n of [0, 1, 2, 60]) {
      const expr: Expr = { op: 'req', n, max: n, desc: d('monsters') };
      const text = printCriterion(expr, ctx);
      expect(text).toBe(`exactly ${n}x monster`);
      expect(parseCriterion(text, ctx), text).toEqual({ ok: true, expr });
    }
  });

  it('prints a `unique` requirement as `nx unique`, where it was typed', () => {
    expect(printCriterion({ op: 'req', n: 3, unique: true, desc: d('#1 or #2') }, ctx)).toBe(
      '3x unique (#1 or #2)',
    );
    expect(
      printCriterion(and(req(1, '#1'), { op: 'req', n: 2, unique: true, desc: d('monster') }), ctx),
    ).toBe('1x #1 and 2x unique monster');
  });

  it('prints a ceiling on `unique` as a plain range prints, the word after the count', () => {
    const ranged = (n: number, max: number): Expr => ({
      op: 'req',
      n,
      max,
      unique: true,
      desc: d('monster'),
    });
    expect(printCriterion(ranged(2, 2), ctx)).toBe('exactly 2x unique monster');
    expect(printCriterion(ranged(2, 3), ctx)).toBe('2-3x unique monster');
    expect(printCriterion(ranged(0, 1), ctx)).toBe('0-1x unique monster');
    for (const expr of [ranged(2, 2), ranged(2, 3), ranged(0, 1)])
      expect(parseCriterion(printCriterion(expr, ctx), ctx)).toEqual({ ok: true, expr });
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
    let equal = 0;
    const counts = (expr: Expr): number => {
      if (expr.op === 'and' || expr.op === 'or')
        return expr.args.reduce((sum, arg) => sum + counts(arg), 0);
      if (expr.op !== 'req' || expr.max === undefined) return 0;
      if (expr.max === expr.n) equal++;
      return 1;
    };
    for (let i = 0; i < 3000; i++) {
      const expr = genExpr(rng, { ...options, rangeChance: 0.5 });
      ranges += counts(expr);
      const text = printCriterion(expr, ctx);
      expect(parseCriterion(text, ctx), `case ${i}: ${text}`).toEqual({ ok: true, expr });
    }
    expect(ranges).toBeGreaterThan(2000);
    // Equal bounds print as `exactly nx`, so the round trip above covers both spellings.
    expect(equal).toBeGreaterThan(500);
  });

  it('round-trips 3,000 generated criteria that include `unique` requirements, key order and all', () => {
    const rng = seededRng(0xe3e3d01e);
    let uniques = 0;
    const counts = (expr: Expr): number => {
      if (expr.op === 'and' || expr.op === 'or')
        return expr.args.reduce((sum, arg) => sum + counts(arg), 0);
      return expr.op === 'req' && expr.unique === true ? 1 : 0;
    };
    for (let i = 0; i < 3000; i++) {
      const expr = genExpr(rng, { ...options, rangeChance: 0.2, uniqueChance: 0.5 });
      uniques += counts(expr);
      const text = printCriterion(expr, ctx);
      const result = parseCriterion(text, ctx);
      expect(result, `case ${i}: ${text}`).toEqual({ ok: true, expr });
      if (result.ok) expect(JSON.stringify(result.expr), text).toBe(JSON.stringify(expr));
    }
    expect(uniques).toBeGreaterThan(1500);
  });

  it('round-trips 3,000 generated criteria with ceilings on `unique`, key order and all', () => {
    const rng = seededRng(0xe3e3a0a0);
    let ranged = 0;
    const counts = (expr: Expr): number => {
      if (expr.op === 'and' || expr.op === 'or')
        return expr.args.reduce((sum, arg) => sum + counts(arg), 0);
      return expr.op === 'req' && expr.unique === true && expr.max !== undefined ? 1 : 0;
    };
    for (let i = 0; i < 3000; i++) {
      const expr = genExpr(rng, {
        ...options,
        rangeChance: 0.4,
        uniqueChance: 0.3,
        uniqueRangeChance: 0.5,
      });
      ranged += counts(expr);
      const text = printCriterion(expr, ctx);
      const result = parseCriterion(text, ctx);
      expect(result, `case ${i}: ${text}`).toEqual({ ok: true, expr });
      if (result.ok) expect(JSON.stringify(result.expr), text).toBe(JSON.stringify(expr));
    }
    expect(ranged).toBeGreaterThan(1000);
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
      } else if (expr.op === 'split') {
        for (const part of [expr.five, expr.sixth, expr.whole])
          if (part !== undefined) walk(part, 'split');
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
