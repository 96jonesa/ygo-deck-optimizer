import { describe, expect, it } from 'vitest';
import { type Expr, type FlatCriterion, MAX_RANGES } from '../../../src/core/criteria/ast';
import { expand, expandAll, MAX_FLAT_CRITERIA } from '../../../src/core/criteria/expand';
import type { Description } from '../../../src/core/desc/ast';
import { same } from '../../helpers/assert';
import { type Fills, satisfiesAnyFlat, satisfiesTree } from '../../helpers/criteria-oracle';
import { genExpr } from '../../helpers/gen-criteria';
import { type Rng, seededRng } from '../../helpers/prng';

/** An opaque description: expansion only ever compares descriptions, it never reads them. */
function card(passcode: number): Description {
  return { anyOf: [{ t: 'card', passcode }] };
}

const [A, B, C, D] = [card(1), card(2), card(3), card(4)] as [
  Description,
  Description,
  Description,
  Description,
];

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

const HAND = { maxHandSize: 6 };

/** The flat criteria of an expansion that must succeed. */
function flatOf(expr: Expr, opts = HAND): FlatCriterion[] {
  const result = expand(expr, opts);
  if (!result.ok) throw new Error(result.message);
  return result.flat;
}

/** `k` two-way choices between distinct cards, all required: 2^k alternatives of `k` slots. */
function productOfChoices(k: number): Expr {
  return and(
    ...Array.from({ length: k }, (_, i) => or(req(1, card(2 * i)), req(1, card(2 * i + 1)))),
  );
}

it('pins the cap', () => {
  expect(MAX_FLAT_CRITERIA).toBe(256);
});

describe('expand', () => {
  it('turns a leaf into one flat criterion', () => {
    expect(expand(req(2, A), HAND)).toEqual({
      ok: true,
      flat: [{ reqs: [{ n: 2, desc: A }], limits: [] }],
      dropped: 0,
    });
    expect(flatOf(atMost(1, A))).toEqual([{ reqs: [], limits: [{ n: 1, desc: A }] }]);
  });

  it('expands the PRD example to exactly its two alternatives', () => {
    // 1x A and 1x B and (1x C or 2x D)
    expect(flatOf(and(req(1, A), req(1, B), or(req(1, C), req(2, D))))).toEqual([
      {
        reqs: [
          { n: 1, desc: A },
          { n: 1, desc: B },
          { n: 1, desc: C },
        ],
        limits: [],
      },
      {
        reqs: [
          { n: 1, desc: A },
          { n: 1, desc: B },
          { n: 2, desc: D },
        ],
        limits: [],
      },
    ]);
  });

  it('distributes and over or in written order, first choice outermost', () => {
    const flat = flatOf(and(or(req(1, A), req(1, B)), or(req(1, C), req(1, D))));
    expect(flat.map((f) => f.reqs.map((r) => r.desc))).toEqual([
      [A, C],
      [A, D],
      [B, C],
      [B, D],
    ]);
  });

  it('expands or inside and inside or', () => {
    const flat = flatOf(or(req(1, A), and(req(1, B), or(req(1, C), req(2, D)))));
    expect(flat.map((f) => f.reqs)).toEqual([
      [{ n: 1, desc: A }],
      [
        { n: 1, desc: B },
        { n: 1, desc: C },
      ],
      [
        { n: 1, desc: B },
        { n: 2, desc: D },
      ],
    ]);
  });

  describe('merging within a flat criterion', () => {
    it('sums the counts of requirements with the same description: they need distinct cards', () => {
      expect(flatOf(and(req(1, A), req(1, A)))).toEqual([
        { reqs: [{ n: 2, desc: A }], limits: [] },
      ]);
      expect(flatOf(and(req(1, A), req(1, B), req(2, A)))[0]!.reqs).toEqual([
        { n: 3, desc: A },
        { n: 1, desc: B },
      ]);
    });

    it('sums across the branches a requirement is distributed into', () => {
      const flat = flatOf(and(req(1, A), or(req(1, A), req(1, B))));
      expect(flat.map((f) => f.reqs)).toEqual([
        [{ n: 2, desc: A }],
        [
          { n: 1, desc: A },
          { n: 1, desc: B },
        ],
      ]);
    });

    it('adds the ceilings of two ranges on the same description', () => {
      expect(flatOf(and(range(1, 2, A), range(1, 2, A)))).toEqual([
        { reqs: [{ n: 2, max: 4, desc: A }], limits: [] },
      ]);
      expect(flatOf(and(range(0, 1, A), range(2, 3, A)))[0]!.reqs).toEqual([
        { n: 2, max: 4, desc: A },
      ]);
    });

    it('lets an unbounded requirement void the ceiling: it absorbs the surplus', () => {
      expect(flatOf(and(req(1, A), range(1, 2, A)))).toEqual([
        { reqs: [{ n: 2, desc: A }], limits: [] },
      ]);
      // Whichever way round they are written.
      expect(flatOf(and(range(1, 2, A), req(1, A)))[0]!.reqs).toEqual([{ n: 2, desc: A }]);
    });

    it('keeps two ranges on DIFFERENT descriptions apart', () => {
      expect(flatOf(and(range(1, 2, A), range(1, 2, B)))[0]!.reqs).toEqual([
        { n: 1, max: 2, desc: A },
        { n: 1, max: 2, desc: B },
      ]);
    });

    it('keeps `0-b` rather than dropping it as a requirement of no cards', () => {
      expect(flatOf(range(0, 2, A))).toEqual([{ reqs: [{ n: 0, max: 2, desc: A }], limits: [] }]);
      // A plain `0x` still asks for nothing and goes.
      expect(flatOf(req(0, A))).toEqual([{ reqs: [], limits: [] }]);
    });

    it('tells two alternatives apart by their ceilings, not only their counts', () => {
      const result = expand(or(range(1, 2, A), range(1, 3, A), req(1, A)), HAND);
      expect(result.ok && result.flat).toEqual([
        { reqs: [{ n: 1, max: 2, desc: A }], limits: [] },
        { reqs: [{ n: 1, max: 3, desc: A }], limits: [] },
        { reqs: [{ n: 1, desc: A }], limits: [] },
      ]);
    });

    it('keeps the tighter of two limits with the same description', () => {
      expect(flatOf(and(atMost(2, A), atMost(1, A), atMost(3, A)))).toEqual([
        { reqs: [], limits: [{ n: 1, desc: A }] },
      ]);
    });

    it('compares descriptions structurally, whatever their key order, and never semantically', () => {
      const written: Description = {
        anyOf: [{ t: 'clause', clause: { level: [4], kinds: ['monster'] } }],
      };
      const reordered: Description = {
        anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [4, 4] } }],
      };
      // The same cards as `A or B`, but alternatives keep their written order (TDD §5.1).
      const flat = flatOf(
        and(
          req(1, written),
          req(1, reordered),
          req(1, { anyOf: [...A.anyOf, ...B.anyOf] }),
          req(1, { anyOf: [...B.anyOf, ...A.anyOf] }),
        ),
      );
      expect(flat[0]!.reqs.map((r) => r.n)).toEqual([2, 1, 1]);
    });

    it('never merges a requirement with a limit', () => {
      expect(flatOf(and(req(1, A), atMost(1, A)))).toEqual([
        { reqs: [{ n: 1, desc: A }], limits: [{ n: 1, desc: A }] },
      ]);
    });

    it('treats a requirement of no cards as no requirement', () => {
      expect(flatOf(and(req(0, A), req(1, B)))).toEqual([
        { reqs: [{ n: 1, desc: B }], limits: [] },
      ]);
    });
  });

  it('carries a limit into every branch it is anded with, and into no other', () => {
    // 1x A and ((1x B and no C) or 1x D), at most 1x D over all of it
    const flat = flatOf(and(req(1, A), or(and(req(1, B), atMost(0, C)), req(1, D)), atMost(1, D)));
    expect(flat).toEqual([
      {
        reqs: [
          { n: 1, desc: A },
          { n: 1, desc: B },
        ],
        limits: [
          { n: 0, desc: C },
          { n: 1, desc: D },
        ],
      },
      {
        reqs: [
          { n: 1, desc: A },
          { n: 1, desc: D },
        ],
        limits: [{ n: 1, desc: D }],
      },
    ]);
  });

  describe('dropping what the hand cannot hold', () => {
    it('drops an alternative with more slots than cards in the hand, and counts it', () => {
      const expr = or(req(1, A), and(req(3, B), req(3, C)), and(req(2, B), req(3, C)));
      expect(expand(expr, { maxHandSize: 5 })).toEqual({
        ok: true,
        flat: [
          { reqs: [{ n: 1, desc: A }], limits: [] },
          {
            reqs: [
              { n: 2, desc: B },
              { n: 3, desc: C },
            ],
            limits: [],
          },
        ],
        dropped: 1,
      });
      expect(expand(expr, { maxHandSize: 6 })).toMatchObject({ dropped: 0 });
      expect(expand(expr, { maxHandSize: 4 })).toMatchObject({ dropped: 2 });
    });

    it('counts slots after merging', () => {
      expect(expand(and(req(3, A), req(3, A)), { maxHandSize: 5 })).toEqual({
        ok: true,
        flat: [],
        dropped: 1,
      });
    });

    it('is still ok when every alternative is dropped: the caller warns', () => {
      expect(expand(and(req(3, A), req(3, B)), { maxHandSize: 5 })).toEqual({
        ok: true,
        flat: [],
        dropped: 1,
      });
    });

    it('never drops for its limits, however many cards they mention', () => {
      expect(expand(and(atMost(40, A), atMost(40, B)), { maxHandSize: 5 })).toMatchObject({
        flat: [{ reqs: [] }],
        dropped: 0,
      });
    });

    it('counts only the LOWER bounds of ranges: `0-2x` asks for no card', () => {
      const wide = and(range(0, 2, A), range(0, 2, B), range(0, 2, C), range(0, 2, D));
      expect(expand(wide, { maxHandSize: 2 })).toMatchObject({ dropped: 0 });
      // Lower bounds still add up and still drop.
      expect(expand(and(range(3, 4, A), range(3, 4, B)), { maxHandSize: 5 })).toMatchObject({
        flat: [],
        dropped: 1,
      });
    });
  });

  describe('the cap on range requirements', () => {
    /** `n` ranges on distinct descriptions, each a ceiling that can bind at a hand of 6. */
    const ranges = (n: number) => and(...Array.from({ length: n }, (_, i) => range(0, 1, card(i))));

    it(`accepts exactly ${MAX_RANGES} ranges that can bind`, () => {
      expect(expand(ranges(MAX_RANGES), HAND).ok).toBe(true);
    });

    it('refuses one more, with a message that names the cap', () => {
      expect(expand(ranges(MAX_RANGES + 1), HAND)).toEqual({
        ok: false,
        message: expect.stringContaining(String(MAX_RANGES)),
      });
    });

    it('does not count a ceiling that can never bind: the hand is not that large', () => {
      // `0-6x` at a hand of 6 can never be exceeded, so it costs the engine nothing.
      const wide = and(...Array.from({ length: MAX_RANGES + 5 }, (_, i) => range(0, 6, card(i))));
      expect(expand(wide, HAND).ok).toBe(true);
    });

    it('is an error and not a drop: the alternative is judged or it is not', () => {
      const result = expand(or(req(1, A), ranges(MAX_RANGES + 1)), HAND);
      expect(result.ok).toBe(false);
    });
  });

  describe('duplicate alternatives', () => {
    it('removes a repeated alternative, keeping the first', () => {
      expect(flatOf(or(req(1, A), req(1, B), req(1, A)))).toEqual([
        { reqs: [{ n: 1, desc: A }], limits: [] },
        { reqs: [{ n: 1, desc: B }], limits: [] },
      ]);
    });

    it('ignores the order of requirements and of limits', () => {
      const flat = flatOf(
        or(
          and(req(1, A), req(2, B), atMost(0, C), atMost(1, D)),
          and(atMost(1, D), req(2, B), atMost(0, C), req(1, A)),
        ),
      );
      expect(flat).toHaveLength(1);
      expect(flat[0]!.reqs.map((r) => r.desc)).toEqual([A, B]);
    });

    it('compares after merging', () => {
      expect(flatOf(or(req(2, A), and(req(1, A), req(1, A))))).toHaveLength(1);
    });

    it('tells apart what differs only in a count, or in requirement against limit', () => {
      expect(flatOf(or(req(1, A), req(2, A), atMost(1, A), atMost(2, A)))).toHaveLength(4);
    });

    it('counts a dropped alternative once, however often it was written', () => {
      const big = and(req(3, A), req(3, B));
      expect(expand(or(big, req(1, C), big), { maxHandSize: 5 })).toMatchObject({ dropped: 1 });
    });
  });

  describe('the cap', () => {
    it('accepts exactly 256 alternatives', () => {
      const result = expand(productOfChoices(8), { maxHandSize: 8 });
      expect(result.ok && result.flat).toHaveLength(256);
    });

    it('refuses 512 with a message that names the cap', () => {
      const result = expand(productOfChoices(9), { maxHandSize: 9 });
      expect(result).toEqual({ ok: false, message: expect.stringContaining('256') });
    });

    it('refuses before it drops: 512 alternatives no hand can hold are still an error', () => {
      expect(expand(productOfChoices(9), { maxHandSize: 5 }).ok).toBe(false);
    });

    it('refuses 257 alternatives of a plain or', () => {
      const leaves = Array.from({ length: 257 }, (_, i) => req(1, card(i)));
      expect(expand(or(...leaves.slice(0, 256)), HAND).ok).toBe(true);
      expect(expand(or(...leaves), HAND).ok).toBe(false);
    });

    it('gives up on 2^40 alternatives during distribution, not after it', () => {
      const started = performance.now();
      expect(expand(productOfChoices(40), HAND).ok).toBe(false);
      expect(expand(or(req(1, A), and(req(1, B), productOfChoices(40))), HAND).ok).toBe(false);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('reads no further into the criterion once the cap is passed', () => {
      let read = 0;
      const tripwire = {
        op: 'or',
        get args(): Expr[] {
          read++;
          throw new Error('read past the cap');
        },
      } as Expr;
      const choices = Array.from({ length: 9 }, (_, i) =>
        or(req(1, card(2 * i)), req(1, card(2 * i + 1))),
      );
      expect(expand(and(...choices, tripwire), HAND).ok).toBe(false);
      expect(read).toBe(0);
    });

    it('counts distinct alternatives, so a choice between equals costs nothing', () => {
      const either = or(req(1, A), req(1, A));
      const result = expand(and(...Array.from({ length: 40 }, () => either)), { maxHandSize: 60 });
      expect(result).toEqual({
        ok: true,
        flat: [{ reqs: [{ n: 40, desc: A }], limits: [] }],
        dropped: 0,
      });
    });
  });

  it('gives canonical descriptions and leaves its input alone', () => {
    const messy: Description = { anyOf: [{ t: 'clause', clause: { level: [4, 2, 4] } }] };
    const expr = and(req(1, messy), atMost(1, messy));
    const before = JSON.stringify(expr);
    const tidy: Description = { anyOf: [{ t: 'clause', clause: { level: [2, 4] } }] };
    expect(flatOf(expr)).toEqual([
      { reqs: [{ n: 1, desc: tidy }], limits: [{ n: 1, desc: tidy }] },
    ]);
    expect(JSON.stringify(expr)).toBe(before);
  });

  it('reads an and of nothing as always satisfied and an or of nothing as never', () => {
    expect(flatOf(and())).toEqual([{ reqs: [], limits: [] }]);
    expect(flatOf(or())).toEqual([]);
    expect(flatOf(and(req(1, A), or()))).toEqual([]);
  });
});

describe('expandAll', () => {
  it('reads the list of criteria as an or at the root', () => {
    const exprs = [and(req(1, A), or(req(1, B), req(1, C))), req(2, D)];
    expect(expandAll(exprs, HAND)).toEqual(expand(or(...exprs), HAND));
    expect(expandAll(exprs, HAND)).toMatchObject({ ok: true, dropped: 0 });
    expect(flatOf(or(...exprs))).toHaveLength(3);
  });

  it('removes duplicates across criteria and counts drops across them', () => {
    const result = expandAll([req(1, A), and(req(3, A), req(3, B)), req(1, A), req(6, C)], {
      maxHandSize: 5,
    });
    expect(result).toEqual({
      ok: true,
      flat: [{ reqs: [{ n: 1, desc: A }], limits: [] }],
      dropped: 2,
    });
  });

  it('applies the cap to the union', () => {
    expect(expandAll([productOfChoices(7), productOfChoices(7)], HAND).ok).toBe(true);
    expect(expandAll([productOfChoices(8), req(1, card(999))], HAND).ok).toBe(false);
  });

  it('has no alternatives for no criteria', () => {
    expect(expandAll([], HAND)).toEqual({ ok: true, flat: [], dropped: 0 });
  });
});

describe('expansion against the direct evaluator of the tree (E1)', () => {
  const DESCRIPTIONS = Array.from({ length: 6 }, (_, i) => card(i + 1));
  const CARD_TYPES = 5;

  interface Case {
    expr: Expr;
    hand: number[];
    fills: Fills<number>;
  }

  /** A random table of which card type fills which description, and a hand drawn from the types. */
  function genCase(rng: Rng, rangeChance = 0): Case {
    const density = rng.pick([0.25, 0.4, 0.6]);
    const table = Array.from({ length: CARD_TYPES }, () =>
      DESCRIPTIONS.map(() => rng.chance(density)),
    );
    const expr = genExpr(rng, {
      desc: (r) => r.pick(DESCRIPTIONS),
      maxDepth: rng.pick([1, 2, 3, 3, 4]),
      maxArgs: 3,
      limitChance: 0.2,
      rangeChance,
    });
    const hand = Array.from({ length: rng.int(0, 6) }, () => rng.int(0, CARD_TYPES - 1));
    return {
      expr,
      hand,
      fills: (type, desc) => {
        const alt = desc.anyOf[0]!;
        return alt.t === 'card' && table[type]![alt.passcode - 1]!;
      },
    };
  }

  describe('the evaluators themselves, on cases worked by hand', () => {
    // Hands of card names; a description is filled by the names listed for its passcode.
    const FILLED_BY: Record<number, string> = { 1: 'a', 2: 'b', 3: 'ab', 4: 'c' };
    const fills: Fills<string> = (name, desc) => {
      const alt = desc.anyOf[0]!;
      return alt.t === 'card' && FILLED_BY[alt.passcode]!.includes(name);
    };
    const [a, b, aOrB, c] = [A, B, C, D];
    const both = (expr: Expr, hand: string, expected: boolean) => {
      expect(satisfiesTree(expr, [...hand], fills), hand).toBe(expected);
      const flat = flatOf(expr, { maxHandSize: 60 });
      expect(satisfiesAnyFlat(flat, [...hand], fills), hand).toBe(expected);
    };

    it('assigns distinct cards: one card cannot fill two requirements (PRD §5.4)', () => {
      const expr = and(req(1, a), req(1, b), req(1, aOrB));
      both(expr, 'abb', true);
      both(expr, 'abc', false);
      both(expr, 'ab', false);
    });

    it('is not greedy: the flexible card is kept for the slot only it can fill', () => {
      // `aOrB` comes first and would take the `a`, which `1x a` then misses.
      both(and(req(1, aOrB), req(1, a)), 'ab', true);
      both(and(req(1, aOrB), req(1, b)), 'ab', true);
      both(and(req(2, aOrB), req(1, a)), 'ab', false);
    });

    it('counts a limit over the whole hand, cards taken by requirements included', () => {
      both(and(req(1, a), atMost(1, a)), 'ab', true);
      both(and(req(1, a), atMost(1, a)), 'aab', false);
      both(and(req(1, a), atMost(0, aOrB)), 'ac', false);
    });

    it('takes one branch at every or, and its limits with it', () => {
      const expr = and(req(1, c), or(and(req(1, a), atMost(0, b)), req(2, b)));
      both(expr, 'ca', true);
      both(expr, 'cab', false);
      both(expr, 'cabb', true);
      both(expr, 'a', false);
    });

    it('satisfies nothing with no alternatives, and anything with an empty one', () => {
      expect(satisfiesAnyFlat([], [], fills)).toBe(false);
      expect(satisfiesAnyFlat([{ reqs: [], limits: [] }], [], fills)).toBe(true);
    });
  });

  it('agrees on 6,000 generated criteria and hands, with and without dropping', () => {
    const rng = seededRng(0xe1e10001);
    let compared = 0;
    let satisfied = 0;
    let dropped = 0;
    let merged = 0;
    for (let i = 0; i < 6000; i++) {
      const { expr, hand, fills } = genCase(rng);
      const direct = satisfiesTree(expr, hand, fills);
      const exact = expand(expr, { maxHandSize: hand.length });
      const undropped = expand(expr, { maxHandSize: 60 });
      // Only the cap may fail, and the hand size has no say in it.
      same(exact.ok, undropped.ok, () => expr);
      if (!exact.ok || !undropped.ok) continue;
      compared++;
      if (direct) satisfied++;
      dropped += exact.dropped;
      if (sumsCounts(expr, undropped.flat)) merged++;
      same(satisfiesAnyFlat(exact.flat, hand, fills), direct, () => ({ expr, hand }));
      // What was dropped could not have been satisfied: keeping it changes nothing.
      same(satisfiesAnyFlat(undropped.flat, hand, fills), direct, () => ({ expr, hand }));
      same(exact.flat.length + exact.dropped, undropped.flat.length, () => expr);
    }
    // Measured: 5,969 compared (31 hit the cap), 44% satisfied, 25,201 alternatives dropped,
    // 2,668 criteria in which counts were summed.
    expect(compared).toBeGreaterThan(5900);
    expect(satisfied / compared).toBeGreaterThan(0.35);
    expect(satisfied / compared).toBeLessThan(0.55);
    expect(dropped).toBeGreaterThan(20000);
    expect(merged).toBeGreaterThan(2000);
  });

  it('agrees on 6,000 generated criteria and hands WITH range requirements', () => {
    const rng = seededRng(0xe1e1a2e5);
    let compared = 0;
    let satisfied = 0;
    let ranged = 0;
    let merged = 0;
    for (let i = 0; i < 6000; i++) {
      const { expr, hand, fills } = genCase(rng, 0.5);
      const direct = satisfiesTree(expr, hand, fills);
      const exact = expand(expr, { maxHandSize: Math.max(hand.length, 1) });
      if (!exact.ok) continue;
      compared++;
      if (direct) satisfied++;
      if (exact.flat.some((f) => f.reqs.some((r) => r.max !== undefined))) ranged++;
      if (mergesCeilings(expr, exact.flat)) merged++;
      // The tree evaluator never merges two requirements on one description;
      // `expand` always does. That they still agree is what checks the merge
      // rule — ceilings adding, and an unbounded requirement voiding them.
      same(satisfiesAnyFlat(exact.flat, hand, fills), direct, () => ({ expr, hand }));
    }
    expect(compared).toBeGreaterThan(5500);
    expect(satisfied / compared).toBeGreaterThan(0.2);
    expect(satisfied / compared).toBeLessThan(0.8);
    expect(ranged).toBeGreaterThan(3000);
    expect(merged).toBeGreaterThan(200);
  });

  it('covers nested or-in-and-in-or, limits at every depth and repeated descriptions', () => {
    const rng = seededRng(0xe1e10001);
    const seen = new Set<string>();
    const walk = (expr: Expr, path: string) => {
      if (expr.op === 'and' || expr.op === 'or')
        for (const arg of expr.args) walk(arg, `${path}${expr.op}>`);
      else seen.add(`${path}${expr.op}`);
    };
    for (let i = 0; i < 6000; i++) walk(genCase(rng).expr, '');
    for (const path of [
      'req',
      'atMost',
      'and>atMost',
      'or>atMost',
      'or>and>or>req',
      'and>or>and>atMost',
      'or>and>or>atMost',
      'and>or>and>or>req',
    ])
      expect(seen, path).toContain(path);
  });
});

/**
 * Whether some flat requirement's ceiling is wider than any single leaf's, or
 * was voided altogether: two leaves on one description were merged.
 */
function mergesCeilings(expr: Expr, flat: readonly FlatCriterion[]): boolean {
  const widest = new Map<string, number | undefined>();
  const seen = new Set<string>();
  const walk = (node: Expr) => {
    if (node.op === 'and' || node.op === 'or') node.args.forEach(walk);
    else if (node.op === 'req') {
      const key = JSON.stringify(node.desc);
      const earlier = widest.get(key);
      if (!seen.has(key) || (earlier !== undefined && (node.max ?? Infinity) > earlier))
        widest.set(key, node.max);
      seen.add(key);
    }
  };
  walk(expr);
  return flat.some((criterion) =>
    criterion.reqs.some(({ max, desc }) => {
      const leaf = widest.get(JSON.stringify(desc));
      return max === undefined ? leaf !== undefined : leaf !== undefined && max > leaf;
    }),
  );
}

/** Whether some flat requirement asks for more than any single leaf did: two leaves were summed. */
function sumsCounts(expr: Expr, flat: readonly FlatCriterion[]): boolean {
  const largest = new Map<string, number>();
  const walk = (node: Expr) => {
    if (node.op === 'and' || node.op === 'or') node.args.forEach(walk);
    else if (node.op === 'req') {
      const key = JSON.stringify(node.desc);
      largest.set(key, Math.max(largest.get(key) ?? 0, node.n));
    }
  };
  walk(expr);
  return flat.some((criterion) =>
    criterion.reqs.some(({ n, desc }) => n > largest.get(JSON.stringify(desc))!),
  );
}
