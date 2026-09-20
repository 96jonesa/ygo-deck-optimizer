import { canonicalize } from '../desc/ast';
import type { Counted, CountedRange, Expr, FlatCriterion } from './ast';
import { MAX_RANGES } from './ast';

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
      /**
       * Parallel to `flat`: for each alternative, the `exprs` it came from,
       * ascending. Two criteria that expand to the SAME alternative share one
       * entry of `flat` — that is the point of the deduplication — so this is
       * the only thing that can still say which criteria a hand meeting it
       * would be meeting. A run that judges a SUBSET of the criteria (going
       * first, going second) selects its alternatives by it.
       */
      sources: number[][];
      /** Distinct alternatives left out of `flat` because they need more cards than a hand holds. */
      dropped: number;
    }
  | { ok: false; message: string };

/** Internal control flow only: `expandAll` catches it and never lets it escape. */
class TooMany {}

/** A flat criterion being built: merged, and keyed by description so that merging is a lookup. */
interface Draft {
  reqs: Map<string, CountedRange>;
  limits: Map<string, Counted>;
}

/**
 * Descriptions are merged when they are structurally identical and never when
 * they merely mean the same (TDD §5.1): canonical JSON is the identity.
 */
function leafOf<T extends Counted>(counted: T): Map<string, T> {
  const desc = canonicalize(counted.desc);
  return new Map([[JSON.stringify(desc), { ...counted, desc }]]);
}

function merged<T extends Counted>(
  a: Map<string, T>,
  b: Map<string, T>,
  combine: (earlier: T, later: T) => T,
): Map<string, T> {
  const out = new Map(a);
  for (const [key, later] of b) {
    const earlier = out.get(key);
    out.set(key, earlier === undefined ? later : combine(earlier, later));
  }
  return out;
}

/**
 * Two requirements for the same description are one requirement. They take
 * DISTINCT cards, so the cards they take together number anything in the
 * SUMSET of their ranges, which over whole numbers is `[a1 + a2, b1 + b2]`:
 * the lower bounds add, and so do the ceilings.
 *
 * An unbounded one voids the ceiling. It can absorb any number of cards, so
 * nothing matching the description is ever left over against its will, and
 * `1x A and 1-2x A` is `2x A` and not `2-3x A`.
 */
function bothReqs(a: CountedRange, b: CountedRange): CountedRange {
  const n = a.n + b.n;
  return a.max === undefined || b.max === undefined
    ? { n, desc: a.desc }
    : { n, max: a.max + b.max, desc: a.desc };
}

/**
 * Both hold at once. Requirements for the same description merge by
 * `bothReqs`; of two limits on the same description the tighter one decides.
 */
function both(a: Draft, b: Draft): Draft {
  return {
    reqs: merged(a.reqs, b.reqs, bothReqs),
    limits: merged(a.limits, b.limits, (earlier, later) => ({
      n: Math.min(earlier.n, later.n),
      desc: earlier.desc,
    })),
  };
}

/** Equal for two drafts exactly when they ask the same, in whatever order. */
function identityOf(draft: Draft): string {
  const reqs = [...draft.reqs].map(([key, { n, max }]) => `${n}-${max ?? ''}x${key}`).sort();
  const limits = [...draft.limits].map(([key, { n }]) => `${n}x${key}`).sort();
  return JSON.stringify([reqs, limits]);
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

/**
 * `distinct` over the criteria at the ROOT, remembering which of them each
 * surviving alternative came from. The cap is enforced exactly as `distinct`
 * enforces it — on the distinct count, as it grows — and a criterion whose
 * every alternative another criterion already had adds no entry, only a source.
 */
function distinctWithSources(exprs: readonly Expr[]): { drafts: Draft[]; sources: number[][] } {
  const at = new Map<string, number>();
  const drafts: Draft[] = [];
  const sources: number[][] = [];
  exprs.forEach((expr, source) => {
    for (const draft of alternativesOf(expr)) {
      const identity = identityOf(draft);
      let index = at.get(identity);
      if (index === undefined) {
        index = drafts.length;
        at.set(identity, index);
        drafts.push(draft);
        sources.push([]);
        if (drafts.length > MAX_FLAT_CRITERIA) throw new TooMany();
      }
      if (!sources[index]!.includes(source)) sources[index]!.push(source);
    }
  });
  return { drafts, sources };
}

/** `and` distributed over `or`: the alternatives of `expr`, each merged, none repeated. */
function alternativesOf(expr: Expr): Draft[] {
  switch (expr.op) {
    case 'req': {
      // A requirement of no cards and no ceiling asks for nothing; `0-b×` still
      // rules out leftovers, so it stays.
      const asks = expr.n > 0 || expr.max !== undefined;
      const leaf: CountedRange =
        expr.max === undefined
          ? { n: expr.n, desc: expr.desc }
          : { n: expr.n, max: expr.max, desc: expr.desc };
      return [{ reqs: asks ? leafOf(leaf) : new Map(), limits: new Map() }];
    }
    case 'atMost':
      return [{ reqs: new Map(), limits: leafOf({ n: expr.n, desc: expr.desc }) }];
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
 *    with structurally identical descriptions are merged by `bothReqs` —
 *    lower bounds add, ceilings add, and an unbounded one voids the ceiling —
 *    limits by keeping the smaller; nothing is merged semantically.
 * 2. Duplicate alternatives are removed, whatever the order of their parts.
 *    This happens throughout the distribution, and the cap is on what is left:
 *    more than `MAX_FLAT_CRITERIA` DISTINCT alternatives at any point is an
 *    error, found while distributing and not after. Dropping (3) never rescues
 *    an expansion from the cap.
 * 3. An alternative whose requirement LOWER bounds need more than
 *    `maxHandSize` cards can never be satisfied and is dropped, and counted.
 *    `flat` may come back empty — the criteria can then never be met, which is
 *    the caller's warning to give. An alternative that survives and holds more
 *    than `MAX_RANGES` ceilings that can bind is an error, not a drop: it asks
 *    something the engine will not judge, rather than something no hand meets.
 *
 * Alternatives and their parts keep the order they were written in.
 */
export function expandAll(exprs: readonly Expr[], opts: ExpandOptions): ExpandResult {
  let drafts: Draft[];
  let from: number[][];
  try {
    ({ drafts, sources: from } = distinctWithSources(exprs));
  } catch (failure) {
    if (!(failure instanceof TooMany)) throw failure;
    return {
      ok: false,
      message: `these criteria expand to more than ${MAX_FLAT_CRITERIA} alternatives; use fewer nested \`or\`s, or put the choice inside one description, as in \`1x ([A] or [B])\``,
    };
  }
  const flat: FlatCriterion[] = [];
  const sources: number[][] = [];
  for (const [index, { reqs, limits }] of drafts.entries()) {
    // Only the LOWER bounds need cards: `0-2x A` asks for none.
    const slots = [...reqs.values()].reduce((sum, { n }) => sum + n, 0);
    if (slots > opts.maxHandSize) continue;
    // A ceiling of `maxHandSize` or more can never bind — the hand holds no
    // more cards than that — so it costs the matcher nothing and is not capped.
    const ranges = [...reqs.values()].filter(
      ({ max }) => max !== undefined && max < opts.maxHandSize,
    ).length;
    if (ranges > MAX_RANGES)
      return {
        ok: false,
        message: `this alternative has ${ranges} range requirements that can bind; the engine judges at most ${MAX_RANGES} — widen a range past the hand size, or write plain \`nx\` requirements`,
      };
    flat.push({ reqs: [...reqs.values()], limits: [...limits.values()] });
    sources.push(from[index]!);
  }
  return { ok: true, flat, sources, dropped: drafts.length - flat.length };
}

/** `expandAll` of one criterion; every alternative's source is then that one. */
export function expand(expr: Expr, opts: ExpandOptions): ExpandResult {
  return expandAll([expr], opts);
}
