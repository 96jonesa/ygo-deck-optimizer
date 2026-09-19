import type { Expr } from '../../src/core/criteria/ast';
import type { Description } from '../../src/core/desc/ast';
import type { Rng } from './prng';

export interface GenExprOptions {
  /** A canonical description for a leaf. */
  desc: (rng: Rng) => Description;
  /** How many `and` / `or` levels may sit above a leaf. */
  maxDepth: number;
  /** An `and` / `or` has between 2 and this many arguments. */
  maxArgs: number;
  /** How often a leaf is a limit rather than a requirement. */
  limitChance: number;
}

function genLeaf(rng: Rng, options: GenExprOptions): Expr {
  const desc = options.desc(rng);
  if (rng.chance(options.limitChance))
    return { op: 'atMost', n: rng.pick([0, 0, 0, 1, 1, 2]), desc };
  return { op: 'req', n: rng.pick([1, 1, 1, 1, 1, 1, 2, 2, 3]), desc };
}

function genNode(rng: Rng, options: GenExprOptions, depth: number, parent?: 'and' | 'or'): Expr {
  if (depth >= options.maxDepth || rng.chance(depth === 0 ? 0.1 : 0.4))
    return genLeaf(rng, options);
  // Canonical by construction, not by `canonicalizeExpr`: a child never repeats its parent's
  // operator, and every operator has at least two arguments.
  const op =
    parent === undefined ? rng.pick(['and', 'or'] as const) : parent === 'and' ? 'or' : 'and';
  const args = Array.from({ length: rng.int(2, options.maxArgs) }, () =>
    genNode(rng, options, depth + 1, op),
  );
  return { op, args };
}

/**
 * A canonical criterion: `and` and `or` alternate down every path, leaves sit
 * at every depth, and descriptions repeat as often as `options.desc` repeats.
 */
export function genExpr(rng: Rng, options: GenExprOptions): Expr {
  return genNode(rng, options, 0);
}

/**
 * `expr` with the noise `canonicalizeExpr` removes: operators wrapped in
 * themselves, and single-argument operators around anything. Its canonical
 * form is `expr`.
 */
export function uncanonical(rng: Rng, expr: Expr): Expr {
  let out: Expr = expr;
  if (expr.op === 'and' || expr.op === 'or') {
    const args = expr.args.map((arg) => uncanonical(rng, arg));
    // `and[a, b, c]` as `and[a, and[b, c]]`.
    const cut = rng.int(1, args.length - 1);
    out =
      args.length > 2 && rng.chance(0.5)
        ? { op: expr.op, args: [...args.slice(0, cut), { op: expr.op, args: args.slice(cut) }] }
        : { op: expr.op, args };
  }
  while (rng.chance(0.3)) out = { op: rng.pick(['and', 'or'] as const), args: [out] };
  return out;
}
