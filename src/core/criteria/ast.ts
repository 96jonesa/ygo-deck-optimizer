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
 * The most requirement slots the DRAWN SET's part of a split criterion may ask
 * for WHEN NOTHING DRAWS: one card. `1x [Ash Blossom & Joyous Spring]` is a
 * question about the card drawn for turn; `2x monster` is a question no one
 * card can answer. A limit there is meaningful all the same — `no trap` says
 * the card drawn is not a trap — and costs no slot.
 *
 * It is a DEFAULT and not the bound. With draw cards the drawn set is the card
 * drawn for turn and everything they fetched, and `largestDrawnSet` says how
 * many that is; the parser and `expand` take it as an option, so a template
 * that draws can write `then 2x monster` and one that does not still cannot. A
 * test holds this equal to `largestDrawnSet(H, [])`, which is the same claim
 * said twice on purpose.
 */
export const MAX_SIXTH_SLOTS = 1;

/**
 * Why a `then` part asks for more than the drawn set can hold — in the ONE
 * wording the parser, `expand` and `validateExpr` all use, so that the same
 * mistake does not read as three different mistakes depending on where it is
 * caught. The advice differs with the bound: at one card the way out is to ask
 * for less, and the reason the bound might be wrong is that no line draws.
 */
export function tooManyDrawnSlots(asked: number, allowed: number): string {
  return allowed === 1
    ? `the card you draw is one card, and this asks ${asked} of it: after \`then\`, write one requirement — \`1x …\` — or limits alone, as in \`no trap\`. Mark a line as drawing cards and \`then\` becomes about everything you drew, which can be more than one`
    : `you draw at most ${allowed} cards here, and this asks ${asked} of them: after \`then\`, write at most ${allowed} requirement slot(s), or limits alone, as in \`no trap\``;
}

/** `n×` a description: `n` distinct cards of a requirement, or the ceiling of a limit. */
export interface Counted {
  n: number;
  desc: Description;
}

/**
 * A requirement's count: at least `n` cards, and — when it was written as the
 * RANGE `a-b×` — at most `max` of them. `max: undefined` is no ceiling, which
 * is what a plain `n×` means.
 *
 * `unique` is `n× unique D`: the `n` cards it takes must be `n` DIFFERENT cards
 * (Andy, 2026-09-22). It is `n× D` plus that one rule and nothing else — it
 * takes cards exactly as a plain requirement does, so a card given to it is
 * given to nothing else — and it never has a ceiling. Absent is false, and is
 * every requirement written before it.
 */
export interface CountedRange extends Counted {
  max?: number;
  unique?: true;
}

/**
 * A success criterion (TDD §7.1): `and` / `or` over two kinds of leaf.
 * - `req`: DISTINCT drawn cards are assigned to it — at least `n` (`n >= 1`,
 *   or `n >= 0` with a ceiling), and at most `max` when it has one. A
 *   requirement with a ceiling also binds the cards NOT assigned to it: see
 *   `FlatCriterion`. With `unique` the cards assigned to it must moreover be
 *   different CARDS, not merely different copies: `3x unique {Starter}` is three
 *   starters no two of which are the same card. It never has a `max`;
 * - `atMost`: a count over the WHOLE hand, not an assignment (`n >= 0`);
 *   `no X` is `atMost 0`.
 *
 * And one node that is not a leaf and is not a connective: `split`, written
 * `five then sixth finally whole`. It says the criterion is about a hand you
 * draw in pieces — going second, the five you open on, then the cards you draw
 * — and it may stand only at the ROOT of a criterion, never inside `and`, `or`
 * or another `split`. "These five must do X **and** the sixth must be Y" fixes
 * which card is which, which is a different question from "my six cards hold X
 * and Y", and it is the question you ask when the extra card has to be the
 * answer.
 *
 * THREE WINDOWS, at most one part each, and every part present must hold
 * (PRD §5.5, TDD §10.6):
 *
 * | part | window |
 * | -- | -- |
 * | `five` | the cards OPENED ON — the first `H − 1` |
 * | `sixth` | the cards DRAWN — one where nothing draws, the whole drawn set where something does |
 * | `whole` | the WHOLE hand, which is the union of the other two |
 *
 * `whole` is a full criterion in its own right — requirements, ranges, limits,
 * nesting — and it is the one window a limit late in the hand can bind over: a
 * ceiling over five does not follow from one over six, and the extra card is
 * exactly what breaks it. It may not itself hold a `then` or a `finally`, which
 * the grammar and `validateExpr` both refuse.
 *
 * Named for their WINDOWS rather than for the words that write them, which is
 * why the `finally` part is `whole`: what a part MEANS is the cards it is judged
 * over, and every reader of this node has to know which those are.
 */
export type Expr =
  | { op: 'and'; args: Expr[] }
  | { op: 'or'; args: Expr[] }
  | { op: 'req'; n: number; max?: number; unique?: true; desc: Description }
  | { op: 'atMost'; n: number; desc: Description }
  /**
   * `five` absent is "the opening five may be anything": `then 1x [Ash Blossom
   * & Joyous Spring]`. At least one of `sixth` / `whole` is present — a split
   * with neither says nothing the language can express, and it is the invariant
   * `validateExpr` holds a loaded AST to.
   */
  | { op: 'split'; five?: Expr; sixth?: Expr; whole?: Expr };

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
 *
 * A SPLIT is a MAXIMUM and not a three-way sum, and it is the easiest thing
 * here to get wrong. `five` and `sixth` are DISJOINT windows, so their slots
 * add; `whole`'s window is their UNION, so its slots are asked of the very same
 * cards and counting them again would say `1x monster finally 1x monster` needs
 * two. It needs one — assignment does not span windows, and one monster in the
 * opening five answers both parts.
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
    case 'split': {
      const dealt =
        (expr.five === undefined ? 0 : slotsOf(expr.five)) +
        (expr.sixth === undefined ? 0 : slotsOf(expr.sixth));
      return Math.max(dealt, expr.whole === undefined ? 0 : slotsOf(expr.whole));
    }
  }
}

/**
 * One alternative of an expanded criterion (TDD §10.1). A hand meets it when
 * its cards can be assigned to the requirements so that
 *
 * 1. every card is assigned to AT MOST ONE requirement, and only to one whose
 *    description it matches;
 * 2. every requirement `i` receives a count within `[n_i, max_i]`, and a
 *    `unique` one receives cards no two of which are the same card;
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
   * The DRAWN SET's own requirements and limits, when the criterion is split.
   * Present: `reqs` and `limits` above are then about the cards OPENED ON
   * alone, judged over one card fewer than the hand holds, and rules 1–4 are
   * read twice — once over those, once over what was drawn. Absent: the
   * criterion is judged over the whole hand, exactly as it always was.
   *
   * At most `MAX_SIXTH_SLOTS` requirement slots where nothing draws, because it
   * is then one card; with draw cards, at most `largestDrawnSet` of them.
   */
  sixth?: FlatSixth;
  /**
   * The WHOLE HAND's own requirements and limits, when the criterion has a
   * `finally` part (PRD §5.5). Present: `reqs` and `limits` above are about the
   * cards OPENED ON — exactly as they are when `sixth` is present — and rules
   * 1–4 are read once more over the whole hand, which is the union of the two
   * dealt windows. Absent: nothing is asked of the whole hand as such.
   *
   * It is the window a LIMIT late in the hand binds over. `at most 1x brick`
   * over five does not give `at most 1x brick` over six, and the card drawn is
   * exactly what can break it — which is why `finally` exists and why it is a
   * full criterion rather than a second `then`.
   *
   * ASSIGNMENT DOES NOT SPAN WINDOWS. Each part is satisfied over its own window
   * independently, so `1x monster finally 1x monster` is met by the single
   * monster in the opening five counted twice, once per part.
   */
  whole?: FlatSixth;
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

/**
 * ONE WINDOW of an alternative: the same two lists, over the cards that window
 * holds. It is named for the first window that needed it — the cards drawn —
 * and `FlatCriterion.whole` reads the identical shape over the whole hand.
 */
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
    // Absent rather than `undefined`, so that a plain `n×` keeps the JSON it has
    // always had — and `unique` likewise absent when false, between the count
    // and the description, so that every AST written before it stringifies as
    // it did and `meaning.ts` calls none of them stale.
    return {
      op: 'req',
      n: expr.n,
      ...(expr.max === undefined ? {} : { max: expr.max }),
      ...(expr.unique === true ? { unique: true as const } : {}),
      desc,
    };
  }
  if (expr.op === 'atMost') return { op: 'atMost', n: expr.n, desc: canonicalize(expr.desc) };
  if (expr.op === 'split') {
    // Absent rather than `undefined`, and `five`, `sixth`, `whole` in that
    // order, because `meaning.ts` decides a stored AST is stale by stringifying
    // both: a key that appeared, or moved, would silently invalidate saved work.
    const out: Extract<Expr, { op: 'split' }> = { op: 'split' };
    if (expr.five !== undefined) out.five = canonicalizeExpr(expr.five);
    if (expr.sixth !== undefined) out.sixth = canonicalizeExpr(expr.sixth);
    if (expr.whole !== undefined) out.whole = canonicalizeExpr(expr.whole);
    return out;
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
