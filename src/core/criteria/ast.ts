import { canonicalize, type Description } from '../desc/ast';

/** The largest count the text grammar accepts: no deck holds more cards than this. */
export const MAX_COUNT = 60;

/**
 * The most RANGE requirements one flat alternative may hold. The matcher
 * decides a ceiling by a condition per subset of the ranges (see
 * `src/core/prob/matcher.ts`), so the work is `2^ranges`; past this it is
 * an error rather than a criterion that takes forever to compile. Plain `n×`
 * requirements do not count against it — an alternative can hold at most
 * `maxHandSize` of those anyway.
 */
export const MAX_RANGES = 12;

/** `n×` a description: `n` distinct cards of a requirement, or the ceiling of a limit. */
export interface Counted {
  n: number;
  desc: Description;
}

/**
 * A requirement's count: at least `n` cards, and — when it was written as the
 * RANGE `a-b×` — at most `max` of them. `max: undefined` is no ceiling, which
 * is what a plain `n×` means.
 */
export interface CountedRange extends Counted {
  max?: number;
}

/**
 * A success criterion (TDD §7.1): `and` / `or` over two kinds of leaf.
 * - `req`: DISTINCT drawn cards are assigned to it — at least `n` (`n >= 1`,
 *   or `n >= 0` with a ceiling), and at most `max` when it has one. A
 *   requirement with a ceiling also binds the cards NOT assigned to it: see
 *   `FlatCriterion`;
 * - `atMost`: a count over the WHOLE hand, not an assignment (`n >= 0`);
 *   `no X` is `atMost 0`.
 */
export type Expr =
  | { op: 'and'; args: Expr[] }
  | { op: 'or'; args: Expr[] }
  | { op: 'req'; n: number; max?: number; desc: Description }
  | { op: 'atMost'; n: number; desc: Description };

/**
 * One alternative of an expanded criterion (TDD §10.1). A hand meets it when
 * its cards can be assigned to the requirements so that
 *
 * 1. every card is assigned to AT MOST ONE requirement, and only to one whose
 *    description it matches;
 * 2. every requirement `i` receives a count within `[n_i, max_i]`;
 * 3. every card left UNASSIGNED matches no requirement that has a ceiling;
 * 4. every limit holds as a census over the whole hand.
 *
 * Rule 3 is what makes a ceiling bind: without it the surplus would simply go
 * unassigned and `1-2×` would say no more than `1×`. It is also what "in
 * addition to" means — a card matching a capped description is counted unless
 * some other requirement consumed it. With no ceiling anywhere, rules 2 and 3
 * collapse to "at least `n_i` distinct cards each", which is what the language
 * meant before ranges existed.
 */
export interface FlatCriterion {
  reqs: CountedRange[];
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
  if (expr.op === 'req') {
    const desc = canonicalize(expr.desc);
    // Absent rather than `undefined`, so that a plain `n×` keeps the JSON it has always had.
    return expr.max === undefined
      ? { op: 'req', n: expr.n, desc }
      : { op: 'req', n: expr.n, max: expr.max, desc };
  }
  if (expr.op === 'atMost') return { op: 'atMost', n: expr.n, desc: canonicalize(expr.desc) };
  const args: Expr[] = [];
  for (const arg of expr.args) {
    const canonical = canonicalizeExpr(arg);
    // Spliced after canonicalizing: `and[or[and[A, B]]]` is `and[A, B]`.
    if (canonical.op === expr.op) args.push(...canonical.args);
    else args.push(canonical);
  }
  return args.length === 1 ? args[0]! : { op: expr.op, args };
}
