import {
  type CompiledCriterion,
  type CompiledRequirement,
  MAX_HAND,
  maxCriterionWeight,
  type Problem,
  type SixthCard,
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

function compileCriterion({ slots, limits, reqs }: SixthCard): HallCriterion {
  const needOf = new Map<number, number>();
  // More slots than any hand holds is never met; its 2^slots subsets are never
  // built. The bound is the largest hand DRAW CARDS can build and not the
  // opening hand — `meets` refuses a criterion with more slots than the cards
  // it is given, so a hand of eight has to be able to meet a request for seven.
  if (slots.length <= MAX_HAND) {
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
 * A split criterion's `slots` and `limits` are about the OPENING FIVE, not the
 * whole hand, so anything that reads a hand as one window would read it wrong.
 * `compileValuer` is the one thing that knows a hand has two.
 */
function refuseSplit(criteria: readonly CompiledCriterion[], because: string): void {
  const at = criteria.findIndex(({ sixth }) => sixth !== undefined);
  if (at >= 0) throw new RangeError(`criterion ${at} is about the card you draw, but ${because}`);
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
  const picked = chosen(problem, opts);
  refuseSplit(
    picked,
    'a matcher reads a hand as one window — score it through `compileValuer`, which judges the cards opened on and the card drawn apart',
  );
  const criteria = picked.map(compileCriterion);
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

/** What a hand is worth: the highest weight among the criteria it meets, 0 when it meets none. */
export type Weigher = (h: ArrayLike<number>, H: number) => number;

/**
 * The WEIGHER for `problem` (PRD §5.6): a hand meeting several criteria is
 * worth the highest of their weights, never their sum — it is one hand.
 *
 * The criteria are sorted by weight, heaviest first, so the FIRST criterion met
 * is the best one and the loop stops there. That is not an optimization laid on
 * top of a maximum: it is why weighting costs nothing. An unweighted problem
 * has one weight throughout, the sort is the identity (`sort` is stable), and
 * the loop is the matcher's own — stopping at the first criterion met, exactly
 * as `compileMatcher` does, and answering 1 where it answers `true`.
 */
export function compileWeigher(problem: Problem, opts: MatcherOptions = {}): Weigher {
  validateProblem(problem);
  const picked = chosen(problem, opts);
  refuseSplit(
    picked,
    'a weigher reads a hand as one window — score it through `compileValuer`, which judges the cards opened on and the card drawn apart',
  );
  const ordered = [...picked].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
  const weights = ordered.map(({ weight }) => weight ?? 1);
  const criteria = ordered.map(compileCriterion);
  if (criteria.every(({ capMasks }) => capMasks.length === 0))
    return (h, H) => {
      for (let at = 0; at < criteria.length; at++)
        if (meets(criteria[at]!, h, H)) return weights[at]!;
      return 0;
    };
  return (h, H) => {
    for (let at = 0; at < criteria.length; at++)
      if (meets(criteria[at]!, h, H) && withinCeilings(criteria[at]!, h)) return weights[at]!;
    return 0;
  };
}

/** What one composition is worth, and how many of its outcomes succeed at all. */
export interface Worth {
  /**
   * Summed over the hand's OUTCOMES, the best weight each one meets. With the
   * sixth card drawn separately a set of `H` cards is `H` outcomes — one per
   * choice of which card was drawn — and they need not agree.
   */
  value: number;
  /** How many of those outcomes meet any criterion at all: the plain probability's share. */
  plain: number;
}

export interface Valuer {
  /** `outcomesOf` the hand: `H` when the sixth card is drawn separately, else 1. */
  outcomes: number;
  /** The most `value` any composition can be worth: `outcomes × max(weight)`. */
  maxValue: number;
  /** The most `plain` can be, which is `outcomes`. */
  maxPlain: number;
  /** Fills `into` for the hand `h` of `H` cards; `h` is trusted, and `into` is reused. */
  worth(h: ArrayLike<number>, into: Worth): void;
}

export interface ValuerOptions extends MatcherOptions {
  /**
   * Whether this hand's LAST card is drawn separately. It is an argument rather
   * than something read off `problem.handSizes`, for the reason `createScorer`
   * takes its hand size: the hand being scored decides, and a problem may
   * declare hands this valuer is not for. `successSet` reads it off the hand it
   * is enumerating, and a split criterion judged without it throws.
   */
  drawn?: boolean;
}

/**
 * The classes a SINGLE card of which meets `sixth` — the whole of the sixth
 * card's part, precomputed once as a bitmask.
 *
 * The part is a criterion like any other, judged against a hand of one card,
 * so this is the ordinary matcher run over the `k` one-card hands there are.
 * Nothing about it is special-cased: a requirement slot is a mask the class
 * must be in, `no trap` is a limit no class in its mask satisfies, and the
 * BLANK class passes a part that is limits alone — a card that implies nothing
 * implies no trap either, which is what a limit has always meant (PRD §6.3).
 */
function acceptsOf(sixth: SixthCard, classCount: number): number {
  const compiled = compileCriterion(sixth);
  const one = new Uint8Array(classCount);
  let mask = 0;
  for (let cls = 0; cls < classCount; cls++) {
    one.fill(0);
    one[cls] = 1;
    if (meets(compiled, one, 1) && withinCeilings(compiled, one)) mask |= 1 << cls;
  }
  return mask >>> 0;
}

/**
 * What a hand of `H` cards is WORTH, with the sixth card told from the other
 * five where a criterion asks it to be (PRD §5.6).
 *
 * ---------------------------------------------------------------------------
 * THE SAMPLE SPACE. Going second you see five cards and then draw one, so an
 * outcome is the ordered pair (the opening five, the card drawn) — and a SET
 * of six cards is six of those, one per choice of which card was drawn. Draw
 * the sixth first and it is uniform over the whole deck, so for a set `h` and
 * a class `c` the pairs whose drawn card is of class `c` number
 *
 *     h_c · Π_c' C(n_c', h_c')          and          Σ_c h_c = H,
 *
 * which is `H` times the ways to hold `h`. That factor of `h_c` is the whole
 * of the arithmetic: what a composition is worth is
 *
 *     value(h) = Σ_c h_c · best(h − e_c, c)
 *
 * where `best` is the highest weight among the criteria that outcome meets —
 * an unsplit criterion judged over all `H` cards, a split one judged as its
 * five-card part over `h − e_c` and its sixth-card part over `c` alone.
 *
 * TWO CONSEQUENCES WORTH STATING, because they are why this is cheap:
 *
 * - it does NOT change the enumeration. The success set still walks the
 *   compositions of `H` cards; only what each one is worth changes, and that
 *   is decided ONCE per composition rather than once per deck. A split costs
 *   the scorer's hot loop nothing at all.
 * - a composition holds at most `H` classes, so the per-class sum is at most
 *   six terms however many classes the problem has.
 *
 * With nothing split, every outcome of a hand is worth the same and the sum is
 * `H · weight(h)`: the score it always was, with both sides of the fraction
 * multiplied by `H`. That is the backward-compatibility argument, and it is
 * checked rather than asserted.
 */
export function compileValuer(problem: Problem, H: number, opts: ValuerOptions = {}): Valuer {
  validateProblem(problem);
  const classCount = problem.classes.length;
  const picked = chosen(problem, opts);
  const drawn = opts.drawn === true;
  if (!drawn)
    refuseSplit(picked, `this hand of ${H} draws none: pass \`drawn\` for the hand that does`);
  const outcomes = drawn ? H : 1;
  const maxValue = outcomes * maxCriterionWeight(problem);

  // Heaviest first in both lists, so the FIRST criterion met is the best one
  // and the loop stops there — the maximum for nothing, exactly as the
  // unsplit weigher gets it. `sort` is stable, so an unweighted problem keeps
  // the order it was written in.
  const byWeight = (a: CompiledCriterion, b: CompiledCriterion) =>
    (b.weight ?? 1) - (a.weight ?? 1);
  const whole = [...picked].filter(({ sixth }) => sixth === undefined).sort(byWeight);
  const split = [...picked].filter(({ sixth }) => sixth !== undefined).sort(byWeight);
  const wholeWeights = whole.map(({ weight }) => weight ?? 1);
  const wholeHall = whole.map(compileCriterion);
  const splitWeights = split.map(({ weight }) => weight ?? 1);
  /** A split criterion's own `slots`, `limits` and `reqs` ARE its five-card part. */
  const fiveHall = split.map(compileCriterion);
  const accepts = split.map(({ sixth }) => acceptsOf(sixth!, classCount));

  /** The best weight among `criteria` that `h` meets, or `floor` if none beats it. */
  const bestOf = (
    criteria: readonly HallCriterion[],
    weights: readonly number[],
    h: ArrayLike<number>,
    cards: number,
    floor: number,
  ): number => {
    for (let at = 0; at < criteria.length; at++) {
      if (weights[at]! <= floor) return floor;
      const criterion = criteria[at]!;
      if (meets(criterion, h, cards) && withinCeilings(criterion, h)) return weights[at]!;
    }
    return floor;
  };

  if (split.length === 0) {
    // Nothing names the card drawn, so every outcome of a hand is worth the
    // same and the whole per-class sum collapses to one multiplication.
    return {
      outcomes,
      maxValue,
      maxPlain: outcomes,
      worth: (h, into) => {
        const weight = bestOf(wholeHall, wholeWeights, h, H, 0);
        into.value = outcomes * weight;
        into.plain = weight > 0 ? outcomes : 0;
      },
    };
  }

  /** `h` with one card of some class taken out: the five you opened on. */
  const five = new Int32Array(classCount);
  return {
    outcomes,
    maxValue,
    maxPlain: outcomes,
    worth: (h, into) => {
      // The unsplit criteria read the whole hand and so are the same for every
      // outcome of it: judged once, and the floor each outcome starts from.
      const base = bestOf(wholeHall, wholeWeights, h, H, 0);
      let value = 0;
      let plain = 0;
      for (let cls = 0; cls < classCount; cls++) {
        const held = h[cls]!;
        if (held === 0) continue;
        for (let other = 0; other < classCount; other++) five[other] = h[other]!;
        five[cls] = held - 1;
        let best = base;
        for (let at = 0; at < splitWeights.length; at++) {
          if (splitWeights[at]! <= best) break;
          if (((accepts[at]! >>> cls) & 1) === 0) continue;
          const criterion = fiveHall[at]!;
          if (meets(criterion, five, H - 1) && withinCeilings(criterion, five))
            best = splitWeights[at]!;
        }
        value += held * best;
        if (best > 0) plain += held;
      }
      into.value = value;
      into.plain = plain;
    },
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
