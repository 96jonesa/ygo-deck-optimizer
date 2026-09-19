import {
  type CompiledCriterion,
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
}

/** The cards `h` holds of the classes in `mask`. */
function held(h: ArrayLike<number>, mask: number): number {
  let sum = 0;
  for (let rest = mask; rest !== 0; rest &= rest - 1) sum += h[31 - Math.clz32(rest & -rest)]!;
  return sum;
}

function compileCriterion({ slots, limits }: CompiledCriterion): HallCriterion {
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
  return {
    slotCount: slots.length,
    unions: Int32Array.from(needOf.keys()),
    needs: Uint8Array.from(needOf.values()),
    limitMasks: Int32Array.from(limits, ({ mask }) => mask),
    limitCounts: limits.map(({ n }) => n),
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
 */
export function compileMatcher(problem: Problem, opts: MatcherOptions = {}): Matcher {
  validateProblem(problem);
  const criteria = chosen(problem, opts).map(compileCriterion);
  return (h, H) => {
    for (const criterion of criteria) if (meets(criterion, h, H)) return true;
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
