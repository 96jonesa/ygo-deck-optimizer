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

/**
 * The most requirement slots the SIXTH CARD's part of a split criterion may
 * ask for. It is one card: `1x [Ash Blossom & Joyous Spring]` is a question
 * about it, `2x monster` is a question no card can answer. A limit there is
 * meaningful all the same — `no trap` says the card drawn is not a trap — and
 * costs no slot.
 */
export const MAX_SIXTH_SLOTS = 1;

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
 *
 * And one node that is not a leaf and is not a connective: `split`, written
 * `five then sixth`. It says the criterion is about a hand you draw in two
 * pieces — going second, the five you open on and then the card you draw — and
 * it may stand only at the ROOT of a criterion, never inside `and`, `or` or
 * another `split`. "These five must do X **and** the sixth must be Y" fixes
 * which card is which, which is a different question from "my six cards hold X
 * and Y", and it is the question you ask when the extra card has to be the
 * answer.
 */
export type Expr =
  | { op: 'and'; args: Expr[] }
  | { op: 'or'; args: Expr[] }
  | { op: 'req'; n: number; max?: number; desc: Description }
  | { op: 'atMost'; n: number; desc: Description }
  /** `five` absent is "the opening five may be anything": `then 1x [Ash Blossom & Joyous Spring]`. */
  | { op: 'split'; five?: Expr; sixth: Expr };

/**
 * The most requirement slots any one alternative of `expr` asks for — `and`
 * sums, `or` takes the worse of the two, a limit costs nothing.
 *
 * It is exactly what `expand` would count per alternative, and not an estimate
 * of it: merging within an alternative only ever ADDS the lower bounds of
 * requirements sharing a description (`1x A and 1x A` is `2x A`), which is the
 * sum this already takes. So the parser can refuse `… then 2x monster` on the
 * text, with the span of the thing that is wrong, rather than leaving it to an
 * expansion the reader never sees.
 */
export function slotsOf(expr: Expr): number {
  switch (expr.op) {
    case 'req':
      return expr.n;
    case 'atMost':
      return 0;
    case 'and':
      return expr.args.reduce((sum, arg) => sum + slotsOf(arg), 0);
    case 'or':
      return expr.args.reduce((most, arg) => Math.max(most, slotsOf(arg)), 0);
    case 'split':
      return slotsOf(expr.sixth) + (expr.five === undefined ? 0 : slotsOf(expr.five));
  }
}

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
  /**
   * The SIXTH CARD's own requirements and limits, when the criterion is split.
   * Present: `reqs` and `limits` above are then about the OPENING FIVE alone,
   * judged over one card fewer than the hand holds, and rules 1–4 are read
   * twice — once over the five, once over the one card drawn. Absent: the
   * criterion is judged over the whole hand, exactly as it always was.
   *
   * At most `MAX_SIXTH_SLOTS` requirement slots, because it is one card.
   */
  sixth?: FlatSixth;
  /**
   * An alternative the player would STOP for: if the OPENING hand meets it, no
   * draw card is activated (PRD §5.7). It comes from the CRITERION and not from
   * the expression, so `expandAll` never sets it — the caller ORs it over the
   * criteria an alternative came from, exactly as it takes the MAXIMUM of their
   * weights. Absent is the default, and every alternative written before draw
   * cards.
   *
   * It does NOT change how the alternative is judged, so two criteria with the
   * same text and different answers to it are still ONE alternative: they ask
   * the same thing, and one of them would also stop for it.
   */
  stop?: true;
}

/** One alternative's sixth-card part: the same two lists, over a hand of one. */
export interface FlatSixth {
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
  if (expr.op === 'split') {
    // Absent rather than `undefined`, and `five` before `sixth`, because
    // `meaning.ts` decides a stored AST is stale by stringifying both.
    const sixth = canonicalizeExpr(expr.sixth);
    return expr.five === undefined
      ? { op: 'split', sixth }
      : { op: 'split', five: canonicalizeExpr(expr.five), sixth };
  }
  const args: Expr[] = [];
  for (const arg of expr.args) {
    const canonical = canonicalizeExpr(arg);
    // Spliced after canonicalizing: `and[or[and[A, B]]]` is `and[A, B]`.
    if (canonical.op === expr.op) args.push(...canonical.args);
    else args.push(canonical);
  }
  return args.length === 1 ? args[0]! : { op: expr.op, args };
}
