import {
  type CompiledCriterion,
  type CompiledRequirement,
  MAX_HAND_SIZE,
  type Problem,
  validateProblem,
} from '../model/problem';

/**
 * The hand matcher (TDD §10.1). A hand is a COMPOSITION `h`: how many cards
 * it holds of each class, the blank class included. Whether a criterion's
 * requirement slots can each be given a distinct card is a transportation
 * problem — class `c` supplies `h[c]` cards, every slot demands one from the
 * classes of its mask — and by Hall's theorem it is feasible iff
 *
 *     for every set T of slots:  (cards held of the classes in the union of T's masks) >= |T|
 *
 * With at most six slots that is at most 63 sums, and no search.
 *
 * ---------------------------------------------------------------------------
 * RANGES. A requirement written `a-b×` takes a count in `[a, b]`, and no card
 * matching it may be left unassigned (`FlatCriterion`, rule 3). That is the
 * same transportation problem with a LOWER bound on what each class must send
 * and an UPPER bound on what each requirement may receive:
 *
 *     source -> class c   in [s_c, h_c]   `s_c = h_c` when some ceiling accepts c, else 0
 *     class c -> req i    in [0, inf)     when c is in the mask of i
 *     req i -> sink       in [a_i, b_i]
 *
 * Hoffman's circulation theorem turns that into a condition per cut, and every
 * cut of THIS network is trivial except two families — one over subsets `T` of
 * the requirements and one over subsets `Y` of the ceilings:
 *
 *   (A)  for every T:  held(union of T's masks) >= sum of the lower bounds of T
 *   (B)  for every Y:  held(classes whose every requirement is in Y) <= sum of Y's ceilings
 *
 * (A) is Hall's condition again, one slot per unit of lower bound, so the path
 * above computes it unchanged. (B) is the new one, and its mask is exactly the
 * classes that CANNOT put a surplus card anywhere outside `Y`: a class some
 * unbounded requirement accepts is never in it, and neither is one that a
 * ceiling outside `Y` accepts. Both families are precomputed per criterion, so
 * a hand is still a handful of sums and no search — and the bounds are whole
 * numbers, so the feasible circulation Hoffman gives is an assignment of whole
 * cards. Exact, both ways.
 *
 * A criterion with no ceiling never builds (B) and never looks for it.
 */

export interface MatcherOptions {
  /** Judge by this criterion alone, for a per-criterion probability (TDD §10.3). */
  criterion?: number;
}

/** Whether the hand `h` of `H` cards succeeds. `h` is trusted to be `H` cards over the problem's classes. */
export type Matcher = (h: ArrayLike<number>, H: number) => boolean;

interface HallCriterion {
  slotCount: number;
  /** Hall's condition, one entry per DISTINCT union of slot masks: the classes, and the most slots that share them. */
  unions: Int32Array;
  needs: Uint8Array;
  limitMasks: Int32Array;
  limitCounts: number[];
  /** Condition (B), one entry per DISTINCT trapped-class mask: the classes, and the most cards they may hold. */
  capMasks: Int32Array;
  caps: Int32Array;
}

/** The cards `h` holds of the classes in `mask`. */
function held(h: ArrayLike<number>, mask: number): number {
  let sum = 0;
  for (let rest = mask; rest !== 0; rest &= rest - 1) sum += h[31 - Math.clz32(rest & -rest)]!;
  return sum;
}

/**
 * Condition (B) as masks and caps, one per subset `Y` of the requirements that
 * HAVE a ceiling. The classes it binds are those `Y` alone can take: in the
 * union of `Y`'s masks, in no unbounded requirement's mask (`free`), and in no
 * ceiling's outside `Y`. Subsets with the same class mask are one condition —
 * the smallest cap of them — and a subset that traps no class is none at all.
 */
function capsOf(reqs: readonly CompiledRequirement[]): Map<number, number> {
  const out = new Map<number, number>();
  const capped = reqs.filter(({ max }) => max !== null);
  if (capped.length === 0) return out;
  let free = 0;
  for (const { mask, max } of reqs) if (max === null) free |= mask;

  const all = (1 << capped.length) - 1;
  const unionOf = new Int32Array(all + 1);
  const capOf = new Int32Array(all + 1);
  for (let subset = 1; subset <= all; subset++) {
    const lowest = 31 - Math.clz32(subset & -subset);
    const rest = subset & (subset - 1);
    unionOf[subset] = unionOf[rest]! | capped[lowest]!.mask;
    // `max` is the requirement's WHOLE capacity, its lower bound included.
    capOf[subset] = capOf[rest]! + capped[lowest]!.max!;
  }
  for (let subset = 1; subset <= all; subset++) {
    const trapped = (unionOf[subset]! & ~free & ~unionOf[all & ~subset]!) >>> 0;
    if (trapped === 0) continue;
    const cap = capOf[subset]!;
    const earlier = out.get(trapped);
    if (earlier === undefined || cap < earlier) out.set(trapped, cap);
  }
  return out;
}

function compileCriterion({ slots, limits, reqs }: CompiledCriterion): HallCriterion {
  const needOf = new Map<number, number>();
  // More slots than any hand holds is never met; its 2^slots subsets are never built.
  if (slots.length <= MAX_HAND_SIZE) {
    const unionOf = new Int32Array(1 << slots.length);
    const sizeOf = new Uint8Array(1 << slots.length);
    for (let subset = 1; subset < 1 << slots.length; subset++) {
      const lowest = 31 - Math.clz32(subset & -subset);
      const rest = subset & (subset - 1);
      unionOf[subset] = unionOf[rest]! | slots[lowest]!;
      sizeOf[subset] = sizeOf[rest]! + 1;
      // Subsets with the same union are one condition: the largest of them.
      const union = unionOf[subset]!;
      needOf.set(union, Math.max(needOf.get(union) ?? 0, sizeOf[subset]!));
    }
  }
  const capOf = reqs === undefined ? new Map<number, number>() : capsOf(reqs);
  return {
    slotCount: slots.length,
    unions: Int32Array.from(needOf.keys()),
    needs: Uint8Array.from(needOf.values()),
    limitMasks: Int32Array.from(limits, ({ mask }) => mask),
    limitCounts: limits.map(({ n }) => n),
    capMasks: Int32Array.from(capOf.keys()),
    caps: Int32Array.from(capOf.values()),
  };
}

function meets(criterion: HallCriterion, h: ArrayLike<number>, H: number): boolean {
  if (criterion.slotCount > H) return false;
  const { unions, needs, limitMasks, limitCounts } = criterion;
  for (let i = 0; i < limitMasks.length; i++)
    if (held(h, limitMasks[i]!) > limitCounts[i]!) return false;
  for (let i = 0; i < unions.length; i++) if (held(h, unions[i]!) < needs[i]!) return false;
  return true;
}

/** Condition (B): no class is left holding more cards than the ceilings that alone can take them. */
function withinCeilings({ capMasks, caps }: HallCriterion, h: ArrayLike<number>): boolean {
  for (let i = 0; i < capMasks.length; i++) if (held(h, capMasks[i]!) > caps[i]!) return false;
  return true;
}

/** The criteria a matcher judges by: all of them, or the one asked for. */
function chosen(problem: Problem, opts: MatcherOptions): CompiledCriterion[] {
  if (opts.criterion === undefined) return problem.criteria;
  const criterion = problem.criteria[opts.criterion];
  if (!Number.isInteger(opts.criterion) || criterion === undefined)
    throw new RangeError(
      `there is no criterion ${opts.criterion}: the problem has ${problem.criteria.length}`,
    );
  return [criterion];
}

/**
 * The matcher for `problem`, with every criterion's subset unions computed
 * once: a hand succeeds if ANY criterion has its requirements feasible and
 * all its limits satisfied.
 *
 * Which of the two loops to run is decided HERE and not per hand: a problem
 * whose criteria hold no ceiling runs exactly the loop it always ran.
 */
export function compileMatcher(problem: Problem, opts: MatcherOptions = {}): Matcher {
  validateProblem(problem);
  const criteria = chosen(problem, opts).map(compileCriterion);
  if (criteria.every(({ capMasks }) => capMasks.length === 0))
    return (h, H) => {
      for (const criterion of criteria) if (meets(criterion, h, H)) return true;
      return false;
    };
  return (h, H) => {
    for (const criterion of criteria)
      if (meets(criterion, h, H) && withinCeilings(criterion, h)) return true;
    return false;
  };
}

/** One hand, checked: `h` must hold `H` whole cards over the classes of `problem`. */
export function handSucceeds(problem: Problem, h: ArrayLike<number>, H: number): boolean {
  const matches = compileMatcher(problem);
  if (h.length !== problem.classes.length)
    throw new RangeError(
      `expected a count for each of the ${problem.classes.length} classes, got ${h.length}`,
    );
  let cards = 0;
  for (let cls = 0; cls < h.length; cls++) {
    const count = h[cls]!;
    if (!Number.isInteger(count) || count < 0)
      throw new RangeError(`class ${cls}: a hand holds a whole number of cards, not ${count}`);
    cards += count;
  }
  if (cards !== H) throw new RangeError(`the hand holds ${cards} cards, not ${H}`);
  return matches(h, H);
}
