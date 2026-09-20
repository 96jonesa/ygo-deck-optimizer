import { describe, expect, it } from 'vitest';
import { canonicalizeExpr, type Expr, MAX_COUNT } from '../../../src/core/criteria/ast';
import type { Description } from '../../../src/core/desc/ast';
import { genExpr, uncanonical } from '../../helpers/gen-criteria';
import { seededRng } from '../../helpers/prng';

function card(passcode: number): Description {
  return { anyOf: [{ t: 'card', passcode }] };
}

const [A, B, C] = [1, 2, 3].map((n): Expr => ({ op: 'req', n, desc: card(n) })) as [
  Expr,
  Expr,
  Expr,
];

function and(...args: Expr[]): Expr {
  return { op: 'and', args };
}

function or(...args: Expr[]): Expr {
  return { op: 'or', args };
}

it('pins the largest count', () => {
  expect(MAX_COUNT).toBe(60);
});

describe('canonicalizeExpr', () => {
  it('splices an operator into a parent of the same kind, in order', () => {
    expect(canonicalizeExpr(and(A, and(B, C)))).toEqual(and(A, B, C));
    expect(canonicalizeExpr(and(and(A, and(B)), C))).toEqual(and(A, B, C));
    expect(canonicalizeExpr(or(or(C, A), or(B, A)))).toEqual(or(C, A, B, A));
  });

  it('keeps an operator inside a parent of the other kind', () => {
    expect(canonicalizeExpr(and(A, or(B, C)))).toEqual(and(A, or(B, C)));
    expect(canonicalizeExpr(or(and(A, B), C))).toEqual(or(and(A, B), C));
  });

  it('replaces an operator of one argument by the argument, then splices', () => {
    expect(canonicalizeExpr(and(A))).toEqual(A);
    expect(canonicalizeExpr(or(and(or(A))))).toEqual(A);
    expect(canonicalizeExpr(and(A, or(and(B, C))))).toEqual(and(A, B, C));
    expect(canonicalizeExpr(or(and(or(A, B)), C))).toEqual(or(A, B, C));
  });

  it('merges and drops nothing: repeats are kept', () => {
    expect(canonicalizeExpr(and(A, A))).toEqual(and(A, A));
    expect(canonicalizeExpr(or(A, and(A, A)))).toEqual(or(A, and(A, A)));
  });

  it('leaves an operator of no arguments as it is', () => {
    expect(canonicalizeExpr(and())).toEqual(and());
    expect(canonicalizeExpr(and(A, or()))).toEqual(and(A, or()));
  });

  it('canonicalizes the descriptions and fixes the key order', () => {
    const messy = {
      desc: { anyOf: [{ t: 'clause', clause: { level: [4, 2, 4], kinds: ['monster'] } }] },
      n: 2,
      op: 'atMost',
    } as Expr;
    const canonical = canonicalizeExpr(and(A, messy));
    expect(JSON.stringify(canonical)).toBe(
      JSON.stringify(
        and(A, {
          op: 'atMost',
          n: 2,
          desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [2, 4] } }] },
        }),
      ),
    );
  });

  it("keeps a requirement's ceiling, and leaves the key out when it has none", () => {
    const ranged: Expr = { op: 'req', n: 1, max: 2, desc: card(1) };
    expect(canonicalizeExpr(ranged)).toEqual(ranged);
    expect(canonicalizeExpr(and(ranged, A))).toEqual(and(ranged, A));
    // A plain requirement keeps the JSON it has always had: `max` is absent,
    // not `undefined`, so canonical JSON is still the identity `expand` merges by.
    expect(JSON.stringify(canonicalizeExpr({ op: 'req', n: 1, desc: card(1) }))).toBe(
      JSON.stringify({ op: 'req', n: 1, desc: card(1) }),
    );
    expect(JSON.stringify(canonicalizeExpr(ranged))).toContain('"max":2');
  });

  it('does not touch its argument', () => {
    const expr = and(A, and(B, or(C)));
    const before = JSON.stringify(expr);
    canonicalizeExpr(expr);
    expect(JSON.stringify(expr)).toBe(before);
  });

  it('undoes generated noise, and is the identity on canonical criteria', () => {
    const rng = seededRng(0xca909ca1);
    const options = {
      desc: () => card(rng.int(1, 5)),
      maxDepth: 4,
      maxArgs: 3,
      limitChance: 0.3,
    };
    for (let i = 0; i < 1000; i++) {
      const expr = genExpr(rng, options);
      const text = JSON.stringify(expr);
      expect(JSON.stringify(canonicalizeExpr(expr))).toBe(text);
      expect(JSON.stringify(canonicalizeExpr(uncanonical(rng, expr)))).toBe(text);
    }
  });
});
