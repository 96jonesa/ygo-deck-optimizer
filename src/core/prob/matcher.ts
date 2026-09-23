import {
  type CompiledCriterion,
  type CompiledRequirement,
  type CompiledUnique,
  isSplit,
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
 *
 * ---------------------------------------------------------------------------
 * UNIQUE. A requirement written `n× unique D` takes `n` cards no two of which
 * are the same card, and `compileProblem` makes every card it can take a class
 * of its own — so it is a requirement node of demand `n` whose edge from each
 * class in its mask carries AT MOST ONE card:
 *
 *     class c -> unique u   in [0, 1]      when c is in the mask of u
 *     unique u -> sink      in [n_u, inf)
 *
 * The cut argument goes through with that one capacity changed. For a set `T`
 * of requirement nodes — each slot of a plain requirement, each `unique` one
 * whole — a class either sends its cards across (cost `h_c`) or keeps them and
 * pays for its edges into `T`: unbounded if a plain slot of `T` accepts it, and
 * otherwise ONE for each `unique` node of `T` that does. So (A) becomes
 *
 *   (A') for every T:  Σ_c min(h_c, cap_T(c)) >= Σ demand(T)
 *
 * which is Hall's condition when `T` holds no `unique` node. Beside a ceiling
 * the same edge relieves (B) by one card per `unique` requirement accepting the
 * class, since a trapped class may send that many elsewhere:
 *
 *   (B') for every Y:  Σ_{c trapped by Y} max(0, h_c − k_c) <= Σ_{i ∈ Y} b_i
 *
 * `k_c` being the number of `unique` requirements whose mask holds `c`. Both
 * were checked against brute-force assignment of concrete cards on 40,000
 * random instances, ceilings included, before any of this was written, and a
 * test keeps checking them (`tests/core/prob/matcher.test.ts`). Capacities are
 * whole numbers, so a feasible flow is still an assignment of whole cards.
 *
 * A criterion with no `unique` requirement builds none of it: `gale` is absent,
 * and the loops above are the loops it always ran.
 *
 * ---------------------------------------------------------------------------
 * A CEILING ON `unique`. `exactly 2x unique D`, `2-3x unique D`: at most `b_u`
 * DIFFERENT cards (Andy, 2026-09-22). Its edge `c -> u` is `[0, 1]` as before
 * and `u -> sink` is `[n_u, b_u]`, and the new thing is what a card left to
 * nothing may be: one of a class some capped `unique` requirement accepts is
 * allowed only if EVERY such requirement took a card of that class — another
 * copy of a card already counted is no new different card. So each class `c`
 * whose ceilings are all `unique` ones (`U_c`) is in one of two modes:
 *
 *     absorbed:  every card of c is assigned           s -> c in [h_c, h_c]
 *     counted:   each u in U_c takes one card of c     c -> u in [1, 1], s -> c in [0, h_c]
 *
 * and a class under a plain ceiling is always absorbed. For FIXED modes that is
 * a circulation with lower bounds, and Hoffman's cuts over it come to (A') with
 * the counted edges' lower bounds taken off the supply — never more than (A')
 * itself asks — and, over each set `Y` of the capped requirements, plain and
 * `unique` alike:
 *
 *   (B*) Σ_c cost_Y(c) <= Σ_{i ∈ Y} b_i,  where for a class in Y's masks that
 *        no plain requirement outside Y accepts
 *          absorbed:  cost = max(0, h_c − o_c)      o_c = `unique` requirements outside Y accepting c
 *          counted:   cost = |U_c ∩ Y|              (only if no plain requirement in Y accepts c)
 *        and 0 for every other class.
 *
 * The modes are chosen PER CUT: each class pays the cheaper of its two, and
 * (A') is read with nothing taken off. That the choice may be made cut by cut,
 * rather than once for all of them, is not something the derivation gives —
 * it was checked against an independent assignment search over concrete cards
 * on 100,000 random instances (mixes of capped and uncapped plain and `unique`
 * requirements, several `unique` ones, overlapping masks) with no disagreement
 * before any of this was written, and a test keeps checking it. Without a
 * capped `unique` requirement, (B*) is (B') term for term.
 *
 * A criterion with no capped `unique` requirement builds none of it: `spill`
 * is absent, and (B) or (B') is judged exactly as before.
 */

export interface MatcherOptions {
  /** Judge by this criterion alone, for a per-criterion probability (TDD §10.3). */
  criterion?: number;
}

/** Whether the hand `h` of `H` cards succeeds. `h` is trusted to be `H` cards over the problem's classes. */
export type Matcher = (h: ArrayLike<number>, H: number) => boolean;

interface HallCriterion {
  /** The cards its requirements ask for: slots, and every `unique` requirement's `n`. */
  slotCount: number;
  /** Hall's condition, one entry per DISTINCT union of slot masks: the classes, and the most slots that share them. */
  unions: Int32Array;
  needs: Uint8Array;
  limitMasks: Int32Array;
  limitCounts: number[];
  /** Condition (B), one entry per DISTINCT trapped-class mask: the classes, and the most cards they may hold. */
  capMasks: Int32Array;
  caps: Int32Array;
  /** Condition (A') in place of `unions` / `needs`, where there is a `unique` requirement. */
  gale?: Gale;
  /**
   * For condition (B') beside a `unique` requirement: how many `unique`
   * requirements accept each class, by class index. Absent without one.
   */
  uniqueCounts?: Uint8Array;
  /** Condition (B*) in place of (B) and (B'), where a `unique` requirement has a ceiling. */
  spill?: Spill;
}

/**
 * Condition (B*), one entry per DISTINCT set of (class, `o_c`, counted cost)
 * triples — the smallest cap of the subsets `Y` sharing it. A counted cost of
 * `CANNOT` is a class a plain ceiling in `Y` holds, which must be absorbed.
 */
interface Spill {
  /** `classes.slice(start[i], start[i + 1])` and the same of `others` and `counted` belong to entry `i`. */
  start: Int32Array;
  classes: Uint8Array;
  others: Uint8Array;
  counted: Uint8Array;
  caps: Int32Array;
}

/** A counted cost no hand reaches: the class cannot be counted, only absorbed. */
const CANNOT = 255;

/**
 * Condition (A'), one entry per DISTINCT pair of (plain-slot union, per-class
 * `unique` counts) — the most demand of the subsets sharing it. A class's count
 * is carried as LEVELS: `levels[j]` holds the classes outside `unions[i]` that
 * at least `j + 1` of the subset's `unique` nodes accept, so that
 * `Σ min(h_c, count_c)` is `Σ_j #{c ∈ levels[j] : h_c > j}` and never a loop
 * over classes that are not there.
 */
interface Gale {
  unions: Int32Array;
  needs: Uint8Array;
  /** `levels.slice(levelStart[i], levelStart[i + 1])` belong to entry `i`. */
  levelStart: Int32Array;
  levels: Int32Array;
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

/**
 * Condition (A') over every subset of the requirement NODES — each plain slot,
 * and each `unique` requirement whole. Built only when `uniques` is not empty,
 * and only when the cards asked for fit the largest hand: past it `meets`
 * refuses the criterion without reading any of this.
 */
function galeOf(slots: readonly number[], uniques: readonly CompiledUnique[]): Gale {
  const nodes = slots.length + uniques.length;
  const byKey = new Map<string, { union: number; levels: number[]; need: number }>();
  const counts = new Uint8Array(32);
  for (let subset = 1; subset < 1 << nodes; subset++) {
    let union = 0;
    let need = 0;
    counts.fill(0);
    let most = 0;
    for (let node = 0; node < nodes; node++) {
      if (((subset >>> node) & 1) === 0) continue;
      if (node < slots.length) {
        union |= slots[node]!;
        need++;
        continue;
      }
      const { mask, n } = uniques[node - slots.length]!;
      need += n;
      for (let rest = mask; rest !== 0; rest &= rest - 1) {
        const cls = 31 - Math.clz32(rest & -rest);
        counts[cls]!++;
        if (counts[cls]! > most) most = counts[cls]!;
      }
    }
    // A class some plain slot of the subset accepts can send it every card, so
    // it counts in full through `union` and not through its levels.
    const levels: number[] = [];
    for (let level = 1; level <= most; level++) {
      let mask = 0;
      for (let cls = 0; cls < 32; cls++)
        if (counts[cls]! >= level && ((union >>> cls) & 1) === 0) mask |= 1 << cls;
      if (mask === 0) break;
      levels.push(mask);
    }
    const key = `${union}|${levels.join(',')}`;
    const known = byKey.get(key);
    if (known === undefined) byKey.set(key, { union, levels, need });
    else if (need > known.need) known.need = need;
  }
  const entries = [...byKey.values()];
  const levelStart = new Int32Array(entries.length + 1);
  entries.forEach(({ levels }, at) => {
    levelStart[at + 1] = levelStart[at]! + levels.length;
  });
  return {
    unions: Int32Array.from(entries, ({ union }) => union),
    needs: Uint8Array.from(entries, ({ need }) => need),
    levelStart,
    levels: Int32Array.from(entries.flatMap(({ levels }) => levels)),
  };
}

/**
 * Condition (B*) over every subset `Y` of the capped requirements, plain and
 * `unique`. Built only where some `unique` requirement has a ceiling.
 */
function spillOf(
  slots: readonly number[],
  reqs: readonly CompiledRequirement[] | undefined,
  uniques: readonly CompiledUnique[],
): Spill {
  // Without `reqs` every plain requirement is uncapped, and its slots carry its mask.
  let free = 0;
  if (reqs === undefined) for (const mask of slots) free |= mask;
  else for (const { mask, max } of reqs) if (max === null) free |= mask;
  const capped = [
    ...(reqs ?? []).flatMap(({ mask, max }) =>
      max === null ? [] : [{ mask, max, unique: false }],
    ),
    ...uniques.flatMap(({ mask, max }) => (max === undefined ? [] : [{ mask, max, unique: true }])),
  ];
  /** Per class, the `unique` requirements WITHOUT a ceiling that accept it: always outside `Y`. */
  const uncapped = new Uint8Array(32);
  for (const { mask, max } of uniques)
    if (max === undefined)
      for (let rest = mask; rest !== 0; rest &= rest - 1)
        uncapped[31 - Math.clz32(rest & -rest)]!++;

  const byKey = new Map<string, { triples: number[]; cap: number }>();
  for (let subset = 1; subset < 1 << capped.length; subset++) {
    let union = 0;
    let plainIn = 0;
    let plainOut = free;
    let cap = 0;
    const inside = new Uint8Array(32);
    const outside = uncapped.slice();
    capped.forEach(({ mask, max, unique }, at) => {
      const isIn = ((subset >>> at) & 1) === 1;
      if (isIn) {
        union |= mask;
        cap += max;
      }
      if (!unique) {
        if (isIn) plainIn |= mask;
        else plainOut |= mask;
        return;
      }
      const counts = isIn ? inside : outside;
      for (let rest = mask; rest !== 0; rest &= rest - 1) counts[31 - Math.clz32(rest & -rest)]!++;
    });
    const trapped = union & ~plainOut;
    if (trapped === 0) continue;
    const triples: number[] = [];
    for (let rest = trapped; rest !== 0; rest &= rest - 1) {
      const cls = 31 - Math.clz32(rest & -rest);
      triples.push(cls, outside[cls]!, ((plainIn >>> cls) & 1) === 1 ? CANNOT : inside[cls]!);
    }
    const key = triples.join(',');
    const known = byKey.get(key);
    if (known === undefined) byKey.set(key, { triples, cap });
    else if (cap < known.cap) known.cap = cap;
  }
  const entries = [...byKey.values()];
  const start = new Int32Array(entries.length + 1);
  entries.forEach(({ triples }, at) => {
    start[at + 1] = start[at]! + triples.length / 3;
  });
  const every = entries.flatMap(({ triples }) => triples);
  return {
    start,
    classes: Uint8Array.from(every.filter((_, at) => at % 3 === 0)),
    others: Uint8Array.from(every.filter((_, at) => at % 3 === 1)),
    counted: Uint8Array.from(every.filter((_, at) => at % 3 === 2)),
    caps: Int32Array.from(entries, ({ cap }) => cap),
  };
}

function compileCriterion({ slots, limits, reqs, uniques }: SixthCard): HallCriterion {
  const needOf = new Map<number, number>();
  const slotCount = slots.length + (uniques ?? []).reduce((sum, { n }) => sum + n, 0);
  const unique = uniques !== undefined && uniques.length > 0;
  // More slots than any hand holds is never met; its 2^slots subsets are never
  // built. The bound is the largest hand DRAW CARDS can build and not the
  // opening hand — `meets` refuses a criterion with more slots than the cards
  // it is given, so a hand of eight has to be able to meet a request for seven.
  if (!unique && slots.length <= MAX_HAND) {
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
  const spill = uniques?.some(({ max }) => max !== undefined) === true;
  // (B*) replaces (B) and (B') outright where it is built, so neither is.
  const capOf = reqs === undefined || spill ? new Map<number, number>() : capsOf(reqs);
  const out: HallCriterion = {
    slotCount,
    unions: Int32Array.from(needOf.keys()),
    needs: Uint8Array.from(needOf.values()),
    limitMasks: Int32Array.from(limits, ({ mask }) => mask),
    limitCounts: limits.map(({ n }) => n),
    capMasks: Int32Array.from(capOf.keys()),
    caps: Int32Array.from(capOf.values()),
  };
  if (!unique) return out;
  // `uniques.length <= slotCount`, so the nodes number at most `MAX_HAND`.
  if (slotCount <= MAX_HAND) out.gale = galeOf(slots, uniques);
  if (spill) out.spill = spillOf(slots, reqs, uniques);
  else if (capOf.size > 0) {
    const counts = new Uint8Array(32);
    for (const { mask } of uniques)
      for (let rest = mask; rest !== 0; rest &= rest - 1) counts[31 - Math.clz32(rest & -rest)]!++;
    out.uniqueCounts = counts;
  }
  return out;
}

/** Condition (A'): every subset of requirement nodes can be paid, a `unique` one a card per class. */
function galeHolds({ unions, needs, levelStart, levels }: Gale, h: ArrayLike<number>): boolean {
  for (let i = 0; i < unions.length; i++) {
    let supply = held(h, unions[i]!);
    for (let at = levelStart[i]!; at < levelStart[i + 1]!; at++) {
      const level = at - levelStart[i]!;
      for (let rest = levels[at]!; rest !== 0; rest &= rest - 1)
        if (h[31 - Math.clz32(rest & -rest)]! > level) supply++;
    }
    if (supply < needs[i]!) return false;
  }
  return true;
}

function meets(criterion: HallCriterion, h: ArrayLike<number>, H: number): boolean {
  if (criterion.slotCount > H) return false;
  const { unions, needs, limitMasks, limitCounts, gale } = criterion;
  for (let i = 0; i < limitMasks.length; i++)
    if (held(h, limitMasks[i]!) > limitCounts[i]!) return false;
  if (gale !== undefined) return galeHolds(gale, h);
  for (let i = 0; i < unions.length; i++) if (held(h, unions[i]!) < needs[i]!) return false;
  return true;
}

/** Condition (B): no class is left holding more cards than the ceilings that alone can take them. */
function withinCeilings(
  { capMasks, caps, uniqueCounts, spill }: HallCriterion,
  h: ArrayLike<number>,
): boolean {
  if (spill !== undefined) return spillHolds(spill, h);
  if (uniqueCounts !== undefined) return withinCeilingsBeside(capMasks, caps, uniqueCounts, h);
  for (let i = 0; i < capMasks.length; i++) if (held(h, capMasks[i]!) > caps[i]!) return false;
  return true;
}

/** Condition (B'): as (B), less a card of each trapped class per `unique` requirement that takes it. */
function withinCeilingsBeside(
  capMasks: Int32Array,
  caps: Int32Array,
  uniqueCounts: Uint8Array,
  h: ArrayLike<number>,
): boolean {
  for (let i = 0; i < capMasks.length; i++) {
    let trapped = 0;
    for (let rest = capMasks[i]!; rest !== 0; rest &= rest - 1) {
      const cls = 31 - Math.clz32(rest & -rest);
      trapped += Math.max(0, h[cls]! - uniqueCounts[cls]!);
    }
    if (trapped > caps[i]!) return false;
  }
  return true;
}

/** Condition (B*): each trapped class pays the cheaper of absorbing its cards and being counted. */
function spillHolds(
  { start, classes, others, counted, caps }: Spill,
  h: ArrayLike<number>,
): boolean {
  for (let i = 0; i < caps.length; i++) {
    let cost = 0;
    for (let at = start[i]!; at < start[i + 1]!; at++) {
      const extra = h[classes[at]!]! - others[at]!;
      if (extra > 0) cost += Math.min(extra, counted[at]!);
    }
    if (cost > caps[i]!) return false;
  }
  return true;
}

/** Whether a criterion has a ceiling of any kind to check, beside what `meets` checks. */
const hasCeiling = ({ capMasks, spill }: HallCriterion): boolean =>
  capMasks.length > 0 || spill !== undefined;

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
 * `compileValuer` is the one thing that knows a hand has more than one.
 *
 * `isSplit` and not `sixth !== undefined`: a criterion with a `finally` part and
 * no `then` reads its first window as the cards opened on just the same, so it
 * must be refused here just the same.
 */
function refuseSplit(criteria: readonly CompiledCriterion[], because: string): void {
  const at = criteria.findIndex(isSplit);
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
  if (!criteria.some(hasCeiling))
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
  if (!criteria.some(hasCeiling))
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

/**
 * What a hand DEALT IN TWO PIECES is worth: `opened` is the cards opened on and
 * `drawn` is everything from the card drawn for turn onwards. Both are
 * compositions over the problem's classes, and both are trusted to hold the
 * number of cards they are given.
 */
export type SplitWeigher = (
  opened: ArrayLike<number>,
  openedSize: number,
  drawn: ArrayLike<number>,
  drawnSize: number,
) => number;

/**
 * The weigher for a hand read as (opened on, drawn) — the one thing besides
 * `compileValuer` that knows a hand has two windows, and the only one that
 * reads the drawn side as a SET rather than as a single card.
 *
 * It exists for DRAW CARDS (PRD §5.7), where the drawn side is the card drawn
 * for turn plus everything the draw cards fetched, so `acceptsOf`'s trick of
 * precomputing which classes a lone card satisfies does not apply: the drawn
 * part is an ordinary criterion judged over an ordinary composition.
 *
 * A criterion that names no drawn set and no whole hand is judged over the two
 * windows TOGETHER, which is the whole hand — they are disjoint and between them
 * hold all of it. So is a `finally` part, which is a question about exactly that
 * sum (PRD §5.5): with draw cards the whole hand is every card you still hold
 * when you stop drawing, resolved draw cards excluded, and the two windows
 * between them are precisely that. Heaviest first, so the first criterion met is
 * the best one and the loop stops there, exactly as `compileWeigher` does.
 */
export function compileSplitWeigher(problem: Problem, opts: MatcherOptions = {}): SplitWeigher {
  validateProblem(problem);
  const classCount = problem.classes.length;
  const ordered = [...chosen(problem, opts)].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
  const weights = ordered.map(({ weight }) => weight ?? 1);
  /** A split criterion's own `slots`, `limits` and `reqs` ARE its opening part. */
  const opening = ordered.map(compileCriterion);
  const drawnPart = ordered.map(({ sixth }) =>
    sixth === undefined ? null : compileCriterion(sixth),
  );
  /** The `finally` part, judged over the two windows summed. */
  const wholePart = ordered.map(({ whole }) =>
    whole === undefined ? null : compileCriterion(whole),
  );
  const split = ordered.map(isSplit);
  /**
   * The two windows together, filled at most once per call and only if something
   * needs it: an unsplit criterion, or a `finally` part.
   */
  const summed = new Int32Array(classCount);
  return (opened, openedSize, drawn, drawnSize) => {
    let joined = false;
    const wholeSize = openedSize + drawnSize;
    const join = () => {
      if (joined) return;
      for (let cls = 0; cls < classCount; cls++) summed[cls] = opened[cls]! + drawn[cls]!;
      joined = true;
    };
    for (let at = 0; at < ordered.length; at++) {
      const criterion = opening[at]!;
      if (!split[at]!) {
        join();
        if (meets(criterion, summed, wholeSize) && withinCeilings(criterion, summed))
          return weights[at]!;
        continue;
      }
      if (!(meets(criterion, opened, openedSize) && withinCeilings(criterion, opened))) continue;
      const part = drawnPart[at]!;
      if (part !== null && !(meets(part, drawn, drawnSize) && withinCeilings(part, drawn)))
        continue;
      const all = wholePart[at]!;
      if (all !== null) {
        join();
        if (!(meets(all, summed, wholeSize) && withinCeilings(all, summed))) continue;
      }
      return weights[at]!;
    }
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
 * five-card part over `h − e_c`, its sixth-card part over `c` alone, and its
 * `finally` part over `h`.
 *
 * ---------------------------------------------------------------------------
 * WHY A THIRD WINDOW COSTS NOTHING (PRD §5.5, TDD §10.6). A `finally` part is a
 * predicate on `h` ITSELF, and `h` is fixed in the outer sum — so it enters
 * `best(h − e_c, c)` as a conjunct that does not depend on `c`, and the identity
 * above is untouched. Nothing about the sample space changes: an outcome is
 * still the pair (the opening five, the card drawn), a set of `H` cards is still
 * `H` of them, the denominator is still `H · C(N, H)`, and
 * `n · C(n−1, h−1) = h · C(n, h)` is still what makes the factor of `h_c`
 * right. The walk over compositions is the same walk.
 *
 * So a `finally` part is evaluated ONCE per composition rather than once per
 * outcome, above the per-class loop and under the same early break — which is
 * also the whole of the implementation.
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
  // `unsplit` rather than `whole`: `whole` is now a WINDOW of a split criterion
  // (what `finally` writes), and one name for two things here is how the diff
  // stops being readable.
  const unsplit = [...picked].filter((criterion) => !isSplit(criterion)).sort(byWeight);
  const split = [...picked].filter(isSplit).sort(byWeight);
  const unsplitWeights = unsplit.map(({ weight }) => weight ?? 1);
  const unsplitHall = unsplit.map(compileCriterion);
  const splitWeights = split.map(({ weight }) => weight ?? 1);
  /** A split criterion's own `slots`, `limits` and `reqs` ARE its five-card part. */
  const fiveHall = split.map(compileCriterion);
  /**
   * The classes a lone drawn card may be of. A criterion with no `then` part
   * accepts ANY of them: `finally` says nothing about which card was drawn, only
   * about the hand it completes.
   */
  // `MAX_CLASSES` is 30, so the shift never reaches the sign bit.
  const everyClass = (1 << classCount) - 1;
  const accepts = split.map(({ sixth }) =>
    sixth === undefined ? everyClass : acceptsOf(sixth, classCount),
  );
  /** The `finally` part of each split criterion, and `null` where there is none. */
  const wholeHall = split.map(({ whole }) =>
    whole === undefined ? null : compileCriterion(whole),
  );
  const anyWhole = wholeHall.some((part) => part !== null);
  /**
   * Whether each split criterion's `finally` part holds of the hand being valued
   * — 1 for "holds or has none", 0 for "fails". Filled once per composition, for
   * the reason `base` is: a `finally` part is a predicate on `h` ITSELF and does
   * not depend on which card was drawn, so evaluating it inside the per-class
   * loop would repeat it up to `H` times for one answer.
   *
   * Left untouched, and never read, where no criterion has one.
   */
  const wholeHolds = new Uint8Array(split.length);

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
        const weight = bestOf(unsplitHall, unsplitWeights, h, H, 0);
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
      const base = bestOf(unsplitHall, unsplitWeights, h, H, 0);
      // THE `finally` PARTS, once per composition and NOT once per outcome.
      // The early break is kept: sorted heaviest first, a criterion that cannot
      // beat `base` for any outcome is never reached by the loop below, so its
      // part is never evaluated either — `0` there is never read.
      if (anyWhole)
        for (let at = 0; at < splitWeights.length; at++) {
          if (splitWeights[at]! <= base) {
            wholeHolds[at] = 0;
            continue;
          }
          const all = wholeHall[at]!;
          wholeHolds[at] = all === null || (meets(all, h, H) && withinCeilings(all, h)) ? 1 : 0;
        }
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
          if (anyWhole && wholeHolds[at] === 0) continue;
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
