import { canonicalize } from '../desc/ast';
import type { Counted, CountedRange, Expr, FlatCriterion } from './ast';
import { MAX_RANGES, MAX_SIXTH_SLOTS, tooManyDrawnSlots } from './ast';

/** Expansion is exponential in the number of `or`s in principle; more alternatives than this is an error. */
export const MAX_FLAT_CRITERIA = 256;

export interface ExpandOptions {
  /**
   * The largest hand a criterion will be held against: 6 going second, and the
   * hand DRAW CARDS can build where there are any (`largestHand`).
   */
  maxHandSize: number;
  /**
   * The most cards a SPLIT criterion's opening part can be about: `H − 1`, the
   * cards dealt before the one drawn for turn. Default `maxHandSize - 1`, which
   * is exactly that for every template without draw cards.
   *
   * It is its own option because draw cards pull the two apart: `maxHandSize`
   * becomes the hand they can BUILD — nine cards, say — while the cards opened
   * on are five however deep the prefix goes. Left to follow `maxHandSize`, an
   * opening part asking for eight cards would survive expansion and then score
   * zero on every hand, which is the one outcome this file exists to avoid.
   */
  maxOpenedSize?: number;
  /**
   * The most cards the part after `then` can ever be about (`largestDrawnSet`):
   * one where nothing draws, and the card drawn for turn plus everything the
   * draw cards fetched where something does. Default one, which is the bound
   * every template had before draw cards.
   *
   * It bounds the SLOTS that part may ask for, and it is the `room` a ceiling
   * or a limit there is weighed against — `at most 1x trap` can never bind on
   * one card and always can on three.
   */
  maxDrawnSlots?: number;
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
  | {
      ok: false;
      message: string;
      /** What went wrong, for a caller that reports these under different codes. */
      reason: 'cap' | 'ranges' | 'sixth-card';
    };

/** Internal control flow only: `expandAll` catches it and never lets it escape. */
class TooMany {}

/** A flat criterion being built: merged, and keyed by description so that merging is a lookup. */
interface Draft {
  reqs: Map<string, CountedRange>;
  limits: Map<string, Counted>;
  /**
   * The SIXTH CARD's own draft, when the criterion is split. Only a `split` at
   * the ROOT ever sets it, and `both` never sees one: merging a split with
   * anything would be asking which five of which five, which the grammar and
   * `validateExpr` both refuse.
   */
  sixth?: Parts;
  /** The WHOLE HAND's own draft, when the criterion has a `finally` part; the same rule. */
  whole?: Parts;
  /**
   * Whether this draft came from a `split` at all — which `sixth` and `whole`
   * no longer answer between them, since `then 1x A` has no `whole` and
   * `finally 1x A` has no `sixth`. It decides which WINDOW `reqs` and `limits`
   * above are about: the cards opened on where it is set, the whole hand where
   * it is not. Without it a `finally`-only criterion would have its opening part
   * judged over six cards, which is the one reading `finally` exists to deny.
   */
  split?: true;
}

/** The two lists a draft is, without the split: one side of a split criterion. */
interface Parts {
  reqs: Map<string, CountedRange>;
  limits: Map<string, Counted>;
}

const nothing = (): Parts => ({ reqs: new Map(), limits: new Map() });

/**
 * Descriptions are merged when they are structurally identical and never when
 * they merely mean the same (TDD §5.1): canonical JSON is the identity.
 *
 * A `unique` requirement is keyed apart — `#0 ` and the JSON, the number being
 * which `unique` requirement on that description it is — because it is NEVER
 * merged, with a plain requirement or with another `unique` one (`merged`).
 */
function leafOf<T extends Counted & { unique?: true }>(counted: T): Map<string, T> {
  const desc = canonicalize(counted.desc);
  const key = JSON.stringify(desc);
  return new Map([[counted.unique === true ? `#0 ${key}` : key, { ...counted, desc }]]);
}

/** The description's JSON behind a requirement's key: a `unique` one's without its ordinal. */
const descKeyOf = (key: string) => (key.startsWith('#') ? key.slice(key.indexOf(' ') + 1) : key);

function merged<T extends Counted & { unique?: true }>(
  a: Map<string, T>,
  b: Map<string, T>,
  combine: (earlier: T, later: T) => T,
): Map<string, T> {
  const out = new Map(a);
  for (const [key, later] of b) {
    // Two `unique` requirements on one description are NOT one requirement of
    // their sum: `2x unique S and 1x unique S` lets the second take another copy
    // of a card the first holds, which `3x unique S` forbids. So a `unique` one
    // takes the first ordinal free, and never `combine`s.
    if (later.unique === true) {
      let ordinal = 0;
      while (out.has(`#${ordinal} ${descKeyOf(key)}`)) ordinal++;
      out.set(`#${ordinal} ${descKeyOf(key)}`, later);
      continue;
    }
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
  // A `unique` requirement enters by its description and not its ordinal, so
  // `1x unique S and 2x unique S` and its reverse are one alternative.
  const sideOf = ({ reqs, limits }: Parts) => [
    [...reqs]
      .map(
        ([key, { n, max, unique }]) =>
          `${n}-${max ?? ''}${unique === true ? 'u' : ''}x${descKeyOf(key)}`,
      )
      .sort(),
    [...limits].map(([key, { n }]) => `${n}x${key}`).sort(),
  ];
  // Every window is part of what the alternative ASKS, so two alternatives
  // agreeing on the five and differing on the cards drawn — or on what the whole
  // hand must be — are two. `split` is in the identity as well: it says which
  // window the first side is about, and an unsplit alternative asking the same
  // of six cards is a different question from a split one asking it of five.
  return JSON.stringify([
    draft.split === true,
    sideOf(draft),
    draft.sixth === undefined ? null : sideOf(draft.sixth),
    draft.whole === undefined ? null : sideOf(draft.whole),
  ]);
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

/** One draft per (way to open, way to draw, way for the whole hand to be). */
function* splitProducts(
  five: readonly Draft[],
  sixth: readonly Draft[] | null,
  whole: readonly Draft[] | null,
): Iterable<Draft> {
  const parted = ({ reqs, limits }: Draft): Parts => ({ reqs, limits });
  for (const a of five)
    for (const b of sixth ?? [null])
      for (const c of whole ?? [null]) {
        const out: Draft = { reqs: a.reqs, limits: a.limits, split: true };
        if (b !== null) out.sixth = parted(b);
        if (c !== null) out.whole = parted(c);
        yield out;
      }
}

/**
 * The alternatives of a criterion at its ROOT, which is the one place a
 * `split` may stand. Every part distributes `and` over `or` on its own and the
 * alternatives are their product: `(1x A or 1x B) then 1x C` is two ways to open
 * and one card to draw, and each pairing is one alternative. A part the criterion
 * does not have contributes no factor rather than an empty one, so
 * `finally 1x A` expands to as many alternatives as `1x A` does.
 */
function rootAlternativesOf(expr: Expr): Draft[] {
  if (expr.op !== 'split') return alternativesOf(expr);
  // A split with neither dealt part nor a whole-hand part would flatten to an
  // alternative nothing downstream could tell from an UNSPLIT one, and would
  // then be judged over six cards here and over five there. The grammar and
  // `validateExpr` both refuse it; reaching here is a bug, not bad input.
  if (expr.sixth === undefined && expr.whole === undefined)
    throw new RangeError(
      'a `split` asks something of the cards you drew, of the whole hand, or both',
    );
  const five = expr.five === undefined ? [nothing()] : alternativesOf(expr.five);
  const sixth = expr.sixth === undefined ? null : alternativesOf(expr.sixth);
  const whole = expr.whole === undefined ? null : alternativesOf(expr.whole);
  return distinct(splitProducts(five, sixth, whole));
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
    for (const draft of rootAlternativesOf(expr)) {
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
    case 'split':
      // `rootAlternativesOf` takes it, and the grammar and `validateExpr` keep
      // it out of every other position; reaching here is a bug, not bad input.
      throw new RangeError('a `split` stands only at the root of a criterion');
    case 'req': {
      // A requirement of no cards and no ceiling asks for nothing; `0-b×` still
      // rules out leftovers, so it stays.
      const asks = expr.n > 0 || expr.max !== undefined;
      const leaf: CountedRange =
        expr.unique === true
          ? { n: expr.n, unique: true, desc: expr.desc }
          : expr.max === undefined
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
 *    limits by keeping the smaller; nothing is merged semantically. A `unique`
 *    requirement is merged with NOTHING, which is the one exception: two of
 *    them are not one of their sum, and one beside a plain requirement is not
 *    a plain requirement.
 * 2. Duplicate alternatives are removed, whatever the order of their parts.
 *    This happens throughout the distribution, and the cap is on what is left:
 *    more than `MAX_FLAT_CRITERIA` DISTINCT alternatives at any point is an
 *    error, found while distributing and not after. Dropping (3) never rescues
 *    an expansion from the cap.
 * A SPLIT criterion (`five then sixth finally whole`) distributes on every part
 * it has and its alternatives are the product: each pairs one way to open with
 * one way of drawing and one way for the whole hand to be. The opening part is
 * then judged over `maxHandSize - 1` cards — whether or not there is a `then`,
 * since a `finally` alone still makes the opening part a question about the five
 * — the drawn part over `maxDrawnSlots`, and the `finally` part over
 * `maxHandSize`, which is the whole hand.
 *
 * More slots than `maxDrawnSlots` after `then` is an ERROR and not a drop,
 * because the cards drawn can never be more than the draw cards fetch and a hand
 * that silently scores 0 teaches nobody why. A `finally` part asking more than
 * the hand holds is DROPPED, exactly as an unsplit criterion asking it is: its
 * window IS the whole hand, and the two readings must not answer differently.
 *
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
      reason: 'cap',
      message: `these criteria expand to more than ${MAX_FLAT_CRITERIA} alternatives; use fewer nested \`or\`s, or put the choice inside one description, as in \`1x ([A] or [B])\``,
    };
  }
  /** Only the LOWER bounds need cards: `0-2x A` asks for none. */
  const slotsIn = ({ reqs }: Parts) => [...reqs.values()].reduce((sum, { n }) => sum + n, 0);
  /**
   * A ceiling of `room` or more can never bind — that side of the hand holds
   * no more cards than that — so it costs the matcher nothing and is not
   * capped.
   */
  const rangesIn = ({ reqs }: Parts, room: number) =>
    [...reqs.values()].filter(({ max }) => max !== undefined && max < room).length;
  const listed = ({ reqs, limits }: Parts) => ({
    reqs: [...reqs.values()],
    limits: [...limits.values()],
  });

  const drawnRoom = opts.maxDrawnSlots ?? MAX_SIXTH_SLOTS;
  const openedRoom = opts.maxOpenedSize ?? opts.maxHandSize - 1;
  const flat: FlatCriterion[] = [];
  const sources: number[][] = [];
  for (const [index, draft] of drafts.entries()) {
    const { sixth, whole } = draft;
    // A split criterion's opening part is judged over the cards OPENED ON —
    // going second you see five and then draw the rest — and an unsplit one
    // over the whole hand, which draw cards make larger than either. A criterion
    // with a `finally` part and no `then` is still SPLIT: its opening part is
    // about the first five, which is what `finally` is for.
    const room = draft.split === true ? openedRoom : opts.maxHandSize;
    if (slotsIn(draft) > room) continue;
    // The `finally` part is judged over the WHOLE hand, so it is bounded exactly
    // as an unsplit criterion is — dropped, not refused. `then` is the one part
    // refused on the text, because the cards drawn can never be more than the
    // draw cards fetch, where the whole hand is simply the hand.
    if (whole !== undefined && slotsIn(whole) > opts.maxHandSize) continue;
    if (sixth !== undefined) {
      const asked = slotsIn(sixth);
      if (asked > drawnRoom)
        return { ok: false, reason: 'sixth-card', message: tooManyDrawnSlots(asked, drawnRoom) };
    }
    const ranges =
      rangesIn(draft, room) +
      (sixth === undefined ? 0 : rangesIn(sixth, drawnRoom)) +
      (whole === undefined ? 0 : rangesIn(whole, opts.maxHandSize));
    if (ranges > MAX_RANGES)
      return {
        ok: false,
        reason: 'ranges',
        message: `this alternative has ${ranges} range requirements that can bind; the engine judges at most ${MAX_RANGES} — widen a range past the hand size, or write plain \`nx\` requirements`,
      };
    const alternative: FlatCriterion = listed(draft);
    if (sixth !== undefined) alternative.sixth = listed(sixth);
    if (whole !== undefined) alternative.whole = listed(whole);
    flat.push(alternative);
    sources.push(from[index]!);
  }
  return { ok: true, flat, sources, dropped: drafts.length - flat.length };
}

/** `expandAll` of one criterion; every alternative's source is then that one. */
export function expand(expr: Expr, opts: ExpandOptions): ExpandResult {
  return expandAll([expr], opts);
}
