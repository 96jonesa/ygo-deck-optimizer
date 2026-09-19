import { canonicalize, type Description } from '../desc/ast';

/** The largest count the text grammar accepts: no deck holds more cards than this. */
export const MAX_COUNT = 60;

/** `n×` a description: `n` distinct cards of a requirement, or the ceiling of a limit. */
export interface Counted {
  n: number;
  desc: Description;
}

/**
 * A success criterion (TDD §7.1): `and` / `or` over two kinds of leaf.
 * - `req`: at least `n` DISTINCT drawn cards are assigned to it (`n >= 1`);
 * - `atMost`: a count over the WHOLE hand, not an assignment (`n >= 0`);
 *   `no X` is `atMost 0`.
 */
export type Expr =
  | { op: 'and'; args: Expr[] }
  | { op: 'or'; args: Expr[] }
  | { op: 'req'; n: number; desc: Description }
  | { op: 'atMost'; n: number; desc: Description };

/**
 * One alternative of an expanded criterion: every requirement needs its own
 * cards, and every limit holds over the whole hand (TDD §10.1).
 */
export interface FlatCriterion {
  reqs: Counted[];
  limits: Counted[];
}

/**
 * The canonical form, on which structural equality is meaningful and which
 * `parseCriterion` returns: an `and` directly inside an `and` (or an `or`
 * inside an `or`) is spliced into its parent, an `and` / `or` of one argument
 * is that argument, descriptions are canonical, and keys come in one fixed
 * order. Written order is kept everywhere and nothing is merged or dropped —
 * `1x A and 1x A` needs two cards, which is `expand`'s business.
 *
 * Purely structural: counts are not validated, and an `and` / `or` of no
 * arguments (which no text can express) stays as it is.
 */
export function canonicalizeExpr(expr: Expr): Expr {
  if (expr.op === 'req' || expr.op === 'atMost')
    return { op: expr.op, n: expr.n, desc: canonicalize(expr.desc) };
  const args: Expr[] = [];
  for (const arg of expr.args) {
    const canonical = canonicalizeExpr(arg);
    // Spliced after canonicalizing: `and[or[and[A, B]]]` is `and[A, B]`.
    if (canonical.op === expr.op) args.push(...canonical.args);
    else args.push(canonical);
  }
  return args.length === 1 ? args[0]! : { op: expr.op, args };
}
