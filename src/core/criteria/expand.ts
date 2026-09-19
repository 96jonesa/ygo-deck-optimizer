import { canonicalize } from '../desc/ast';
import type { Counted, Expr, FlatCriterion } from './ast';

/** Expansion is exponential in the number of `or`s in principle; more alternatives than this is an error. */
export const MAX_FLAT_CRITERIA = 256;

export interface ExpandOptions {
  /** The largest hand a criterion will be held against (6 when going second). */
  maxHandSize: number;
}

export type ExpandResult =
  | {
      ok: true;
      flat: FlatCriterion[];
      /** Distinct alternatives left out of `flat` because they need more cards than a hand holds. */
      dropped: number;
    }
  | { ok: false; message: string };

/** Internal control flow only: `expandAll` catches it and never lets it escape. */
class TooMany {}

/** A flat criterion being built: merged, and keyed by description so that merging is a lookup. */
interface Draft {
  reqs: Map<string, Counted>;
  limits: Map<string, Counted>;
}

/**
 * Descriptions are merged when they are structurally identical and never when
 * they merely mean the same (TDD §5.1): canonical JSON is the identity.
 */
function leafOf(n: number, desc: Counted['desc']): Map<string, Counted> {
  const canonical = canonicalize(desc);
  return new Map([[JSON.stringify(canonical), { n, desc: canonical }]]);
}

function merged(
  a: Map<string, Counted>,
  b: Map<string, Counted>,
  combine: (n: number, m: number) => number,
): Map<string, Counted> {
  const out = new Map(a);
  for (const [key, { n, desc }] of b) {
    const earlier = out.get(key);
    out.set(key, earlier === undefined ? { n, desc } : { n: combine(earlier.n, n), desc });
  }
  return out;
}

/**
 * Both hold at once. Requirements for the same description need DISTINCT
 * cards, so their counts add (`1x A and 1x A` is `2x A`); of two limits on
 * the same description the tighter one decides.
 */
function both(a: Draft, b: Draft): Draft {
  return {
    reqs: merged(a.reqs, b.reqs, (n, m) => n + m),
    limits: merged(a.limits, b.limits, Math.min),
  };
}

/** Equal for two drafts exactly when they ask the same, in whatever order. */
function identityOf(draft: Draft): string {
  const entries = (side: Map<string, Counted>) =>
    [...side].map(([key, { n }]) => `${n}x${key}`).sort();
  return JSON.stringify([entries(draft.reqs), entries(draft.limits)]);
}

/**
 * The distinct members of `drafts`, first occurrences in order — and the
 * one place the cap is enforced. Every list of alternatives the expansion
 * builds comes through here AS IT IS BUILT, so none ever grows past the cap
 * and a product of forty two-way choices gives up at its ninth.
 */
function distinct(drafts: Iterable<Draft>): Draft[] {
  const seen = new Map<string, Draft>();
  for (const draft of drafts) {
    const identity = identityOf(draft);
    if (seen.has(identity)) continue;
    seen.set(identity, draft);
    if (seen.size > MAX_FLAT_CRITERIA) throw new TooMany();
  }
  return [...seen.values()];
}

function* products(left: readonly Draft[], right: readonly Draft[]): Iterable<Draft> {
  for (const a of left) for (const b of right) yield both(a, b);
}

function* flatMapped(exprs: readonly Expr[]): Iterable<Draft> {
  for (const expr of exprs) yield* alternativesOf(expr);
}

/** `and` distributed over `or`: the alternatives of `expr`, each merged, none repeated. */
function alternativesOf(expr: Expr): Draft[] {
  switch (expr.op) {
    case 'req':
      // A requirement of no cards asks for nothing.
      return [{ reqs: expr.n > 0 ? leafOf(expr.n, expr.desc) : new Map(), limits: new Map() }];
    case 'atMost':
      return [{ reqs: new Map(), limits: leafOf(expr.n, expr.desc) }];
    case 'or':
      return distinct(flatMapped(expr.args));
    case 'and':
      // First argument outermost, so alternatives come out in reading order.
      return expr.args.reduce<Draft[]>(
        (sofar, arg) => distinct(products(sofar, alternativesOf(arg))),
        [{ reqs: new Map(), limits: new Map() }],
      );
  }
}

/**
 * The template's list of criteria, expanded together (TDD §7.2): the list is
 * an `or` at the root — a hand succeeds if it meets any one of them — and the
 * engine only ever sees the flat alternatives.
 *
 * In this order:
 * 1. `and` is distributed over `or`. Within each alternative, requirements
 *    with structurally identical descriptions are merged by ADDING their
 *    counts, limits by keeping the smaller; nothing is merged semantically.
 * 2. Duplicate alternatives are removed, whatever the order of their parts.
 *    This happens throughout the distribution, and the cap is on what is left:
 *    more than `MAX_FLAT_CRITERIA` DISTINCT alternatives at any point is an
 *    error, found while distributing and not after. Dropping (3) never rescues
 *    an expansion from the cap.
 * 3. An alternative with more requirement slots than `maxHandSize` can never
 *    be satisfied and is dropped, and counted. `flat` may come back empty —
 *    the criteria can then never be met, which is the caller's warning to give.
 *
 * Alternatives and their parts keep the order they were written in.
 */
export function expandAll(exprs: readonly Expr[], opts: ExpandOptions): ExpandResult {
  let drafts: Draft[];
  try {
    drafts = distinct(flatMapped(exprs));
  } catch (failure) {
    if (!(failure instanceof TooMany)) throw failure;
    return {
      ok: false,
      message: `these criteria expand to more than ${MAX_FLAT_CRITERIA} alternatives; use fewer nested \`or\`s, or put the choice inside one description, as in \`1x ([A] or [B])\``,
    };
  }
  const flat: FlatCriterion[] = [];
  for (const { reqs, limits } of drafts) {
    const slots = [...reqs.values()].reduce((sum, { n }) => sum + n, 0);
    if (slots <= opts.maxHandSize)
      flat.push({ reqs: [...reqs.values()], limits: [...limits.values()] });
  }
  return { ok: true, flat, dropped: drafts.length - flat.length };
}

/** `expandAll` of one criterion. */
export function expand(expr: Expr, opts: ExpandOptions): ExpandResult {
  return expandAll([expr], opts);
}
