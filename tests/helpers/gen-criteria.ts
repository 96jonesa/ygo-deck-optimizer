import { type Expr, MAX_SIXTH_SLOTS, slotsOf } from '../../src/core/criteria/ast';
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
  /** How often a requirement is a RANGE, `a-b×`; 0 by default, so old callers generate what they did. */
  rangeChance?: number;
  /**
   * How often the WHOLE criterion is split across the five cards opened on and
   * the one drawn; 0 by default, so a generator that never splits consumes no
   * draw and every problem the older suites pinned stays the problem it was.
   */
  splitChance?: number;
}

/**
 * A criterion for the SIXTH CARD: it is one card, so at most one requirement
 * — `slotsOf` is held to `MAX_SIXTH_SLOTS` here rather than generate-and-reject
 * — with any number of limits beside it, and `or` between whole branches.
 */
function genSixthPart(rng: Rng, options: GenExprOptions): Expr {
  const limit = (): Expr => ({
    op: 'atMost',
    n: rng.pick([0, 0, 0, 1]),
    desc: options.desc(rng),
  });
  const branch = (): Expr => {
    const terms: Expr[] = [
      rng.chance(options.limitChance) ? limit() : { op: 'req', n: 1, desc: options.desc(rng) },
    ];
    while (rng.chance(0.3)) terms.push(limit());
    return terms.length === 1 ? terms[0]! : { op: 'and', args: terms };
  };
  const branches = [branch()];
  while (rng.chance(0.25)) branches.push(branch());
  const sixth: Expr = branches.length === 1 ? branches[0]! : { op: 'or', args: branches };
  if (slotsOf(sixth) > MAX_SIXTH_SLOTS)
    throw new Error(`the generator asked ${slotsOf(sixth)} cards of the sixth card`);
  return sixth;
}

function genLeaf(rng: Rng, options: GenExprOptions): Expr {
  const desc = options.desc(rng);
  if (rng.chance(options.limitChance))
    return { op: 'atMost', n: rng.pick([0, 0, 0, 1, 1, 2]), desc };
  // Asked for only when wanted: `chance` draws whatever it is given, so a
  // generator that never makes ranges must not consume the draw and shift
  // every problem the older suites pinned.
  const rangeChance = options.rangeChance ?? 0;
  if (rangeChance > 0 && rng.chance(rangeChance)) {
    // `0-b` as often as anything: its lower bound asks for nothing, and only
    // its ceiling and the leftovers it forbids decide.
    const n = rng.pick([0, 0, 1, 1, 1, 2]);
    return { op: 'req', n, max: n + rng.pick([0, 0, 1, 1, 2]), desc };
  }
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
  const splitChance = options.splitChance ?? 0;
  if (splitChance > 0 && rng.chance(splitChance)) {
    const sixth = genSixthPart(rng, options);
    // A fifth of them leave the opening five unasked about, which is the
    // `then 1x [Ash Blossom & Joyous Spring]` form.
    return rng.chance(0.2)
      ? { op: 'split', sixth }
      : { op: 'split', five: genNode(rng, options, 0), sixth };
  }
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
