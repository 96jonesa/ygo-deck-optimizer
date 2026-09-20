import {
  type CompiledCriterion,
  copiesUsed,
  type DrawClass,
  type DrawSpec,
  drawClassesOf,
  longestPrefix,
  maxCriterionWeight,
  type Problem,
  validateProblem,
} from '../model/problem';
import { choose } from './binomial';
import { lcmBig, prefixFactor, type Rational, rationalKey, reduced, splitFactor } from './draw';
import { compileWeigher, type MatcherOptions, type Weigher } from './matcher';

/**
 * The success set for a problem with DRAW CARDS (PRD §5.7). A hand is then a
 * PREFIX of the shuffled deck rather than a fixed number of cards, so where
 * `successSet` walks the compositions of `H`, this walks the compositions of
 * every prefix length the draw cards can reach, and each one's score is a
 * fraction of its own:
 *
 * ```math
 * P = Σ_ℓ Σ_{v consistent, v succeeds} φ(v) · Π_c C(n_c, v_c) / C(N, ℓ)
 * ```
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS DECIDE THE SHAPE OF THIS FILE.
 *
 * 1. THE DRAW CLASSES GO IN THE OUTER LOOP. Their counts determine `draws(v)`,
 *    hence ℓ, hence the total the remaining classes must sum to — so every
 *    composition visited is CONSISTENT by construction and none is tested and
 *    thrown away. Measured at 4–88× fewer visits than walking every composition
 *    of every reachable length, and the gap grows with the prefix.
 *
 * 2. THE ORDERING FACTOR STAYS OUTSIDE THE FLOAT64 SUM. It is constant across a
 *    group of rows, so each group is summed as a PLAIN INTEGER bounded by
 *    `C(N, ℓ)` and the handful of rationals is combined afterwards. Scaling the
 *    factor into each stored row instead — the natural way to keep the hot loop
 *    to one multiply-accumulate — breaks: under once-per-turn the per-length
 *    lcm explodes, and five once-per-turn draw-2 lines put it 127× past 2^53,
 *    silently rounding the score of a template anyone could write.
 *
 *    Rows are grouped by the ordering factor's VALUE rather than by the draw
 *    vector that produced it, which is what keeps "the handful" a handful: five
 *    once-per-turn draw-2 lines have 1,023 draw vectors and 56 distinct factors.
 *
 * 3. THE COMBINATION IS CHECKED AT BUILD TIME, so that the per-deck work is
 *    float64 throughout. A part's denominator — the lcm of its groups' factors
 *    times `C(N, ℓ)` — depends on the PROBLEM and not on the deck, so both it
 *    and the largest numerator it can carry are known before any deck is
 *    scored. Where they do not fit, this refuses rather than round.
 *
 * ---------------------------------------------------------------------------
 * THE STOP DECISION (PRD §5.7). There is ONE decision point, taken before any
 * card is drawn:
 *
 *     look at the opening H cards
 *       any `stop` criterion met?
 *         yes -> STOP. worth the best weight among ALL criteria the OPENING meets
 *         no  -> DRAW. worth the best weight among ALL criteria the POST-DRAW
 *                hand meets — 0 if drawing broke them
 *
 * Two things about it are easy to get backwards, and both are here rather than
 * only in `CompiledCriterion.stop` because this is where they are computed.
 *
 * `stop` decides the WINDOW and not the ELIGIBILITY. Whichever branch is taken,
 * every criterion of the problem is judged in it: a criterion the player would
 * stop for is still judged after the draws when nothing stopped them, and one
 * they would not is still worth something in a hand that stopped. So a template
 * whose every criterion is marked `stop` is not the no-draw problem — it still
 * draws whenever the opening meets nothing.
 *
 * And there is NO MAXIMUM over the two windows. The draw decision is determined
 * by the opening, so exactly one window is ever in play: a criterion worth 5
 * that draws into a 2 scores 2, and a hand that draws out of everything scores 0
 * though its opening would have scored. That is what makes the value
 * strategy-achievable rather than an upper bound taken with hindsight.
 *
 * A stop decision needs the JOINT distribution of the opening and the whole
 * prefix, and it factorises:
 *
 * ```math
 * P(u, w) = ψ(a, b) · \frac{Π_c C(v_c, u_c)}{C(ℓ, H)} · \frac{Π_c C(n_c, v_c)}{C(N, ℓ)}
 * ```
 *
 * because `Π C(n_c,u_c)·C(n_c−u_c,w_c) = Π C(n_c,v_c) · Π C(v_c,u_c)` and
 * `C(N,H)·C(N−H,ℓ−H) = C(N,ℓ)·C(ℓ,H)`. The DECK enters only through
 * `Π C(n_c, v_c)`, exactly as it does when nothing stops — so the split factor
 * is a build-time constant and the hot loop is untouched. Only the build pays,
 * and it pays a lot: measured 3–63× the rows of the route with no stop.
 */

export interface DrawGroup {
  /** The ordering factor every row of the group carries, in lowest terms. */
  factor: Rational;
  /** `count` compositions of `width` entries: classes 1…k−1, the blank count being the rest. */
  compositions: Uint8Array;
  count: number;
  /** What each composition is worth; every entry is a positive whole number. */
  values: Float64Array;
  /** Parallel: what it contributes to the PLAIN success count. */
  plains: Float64Array;
}

/** One prefix length, and everything a score of it needs. */
export interface DrawPart {
  /** ℓ: the cards seen off the top of the deck. */
  prefix: number;
  groups: DrawGroup[];
  /**
   * What this part's numerator is over: the lcm of its groups' factor
   * denominators times `C(N, ℓ)`. A whole number, and the same for every deck.
   */
  den: number;
  /** Per group, `factor.num · (lcm / factor.den)`: the factor, outside the sums. */
  multipliers: Float64Array;
  /** Rows stored here: what one score of this part costs. */
  terms: number;
}

export interface DrawSet {
  H: number;
  classCount: number;
  /** Entries per stored composition: `classCount - 1`. */
  width: number;
  /** One per STRUCTURALLY reachable prefix length, ascending; a part may hold no row. */
  parts: DrawPart[];
  /** The largest weight any criterion of the problem carries; 1 when none is weighted. */
  maxWeight: number;
  /** Rows stored over every part. */
  terms: number;
  /** Rational groups over every part: the per-deck cost a term count does not show. */
  groups: number;
}

/** The prefix lengths the draw classes can reach, ascending — `num` may be 0 at any of them. */
export function reachablePrefixes(H: number, draws: readonly DrawClass[]): number[] {
  const lengths = new Set<number>();
  const held = draws.map(() => 0);
  const walk = (at: number, prefix: number): void => {
    if (at === draws.length) {
      // A prefix cannot hold more draw cards than it holds cards.
      if (held.reduce((sum, count) => sum + count, 0) <= prefix) lengths.add(prefix);
      return;
    }
    const spec = draws[at]!;
    for (let copies = 0; copies <= spec.max; copies++) {
      held[at] = copies;
      walk(at + 1, prefix + spec.n * copiesUsed(copies, spec));
    }
    held[at] = 0;
  };
  walk(0, H);
  return [...lengths].sort((a, b) => a - b);
}

/**
 * Whether a problem is one this file scores: a hand of it is a PREFIX of the
 * deck rather than a fixed number of cards. Every problem with a draw class is,
 * whatever its criteria say about stopping — a template whose every criterion
 * would stop still DRAWS when the opening meets none of them.
 */
export function hasDrawCards(problem: Problem): boolean {
  return drawClassesOf(problem.classes).length > 0;
}

/**
 * A weigher over `chosen` alone, as a problem in its own right — the same deck
 * and classes. Two are built: one over EVERY criterion, which values whichever
 * window the stop decision lands on, and one over the `stop` criteria, whose
 * only job is to decide it.
 */
function weigherOver(problem: Problem, H: number, chosen: CompiledCriterion[]): Weigher {
  if (chosen.length === 0) return () => 0;
  return compileWeigher({
    deckSize: problem.deckSize,
    handSizes: [{ H, weight: 1 }],
    classes: problem.classes,
    criteria: chosen,
  });
}

/** A group being filled: rows keyed by composition, so that two splits of one `v` are one row. */
interface Draft {
  factor: Rational;
  rows: Map<string, { v: number[]; value: number; plain: number }>;
}

export function drawSet(problem: Problem, H: number, opts: MatcherOptions = {}): DrawSet {
  validateProblem(problem);
  const draws = drawClassesOf(problem.classes);
  if (draws.length === 0)
    throw new RangeError('this problem holds no draw card: score it through `successSet`');
  const { deckSize, classes } = problem;
  const classCount = classes.length;
  const width = classCount - 1;
  const specs: DrawSpec[] = draws.map(({ n, oncePerTurn }) =>
    oncePerTurn === true ? { n, oncePerTurn } : { n },
  );
  const longest = longestPrefix(H, draws);
  const maxWeight = maxCriterionWeight(problem);

  const judged =
    opts.criterion === undefined
      ? problem.criteria
      : [
          problem.criteria[opts.criterion] ??
            (() => {
              throw new RangeError(
                `there is no criterion ${opts.criterion}: the problem has ${problem.criteria.length}`,
              );
            })(),
        ];
  const stopping = judged.filter(({ stop }) => stop === true);
  /** Values whichever window the stop decision lands on: EVERY criterion counts in it. */
  const weigh = weigherOver(problem, H, [...judged]);
  /** Decides the window, and does nothing else: the `stop` criteria on the opening. */
  const stops = weigherOver(problem, H, stopping);

  /** The classes the outer loop does not choose: the blank class and every non-draw class. */
  const rest: number[] = [];
  for (let cls = 0; cls < classCount; cls++)
    if (draws.every((spec) => spec.cls !== cls)) rest.push(cls);
  const capOf = classes.map(({ max }) => Math.min(max, longest));

  /** By prefix length, then by the ordering factor's value. */
  const drafts = new Map<number, Map<string, Draft>>();
  const add = (
    prefix: number,
    factor: Rational,
    v: readonly number[],
    worth: number,
    ways: number,
  ) => {
    let atLength = drafts.get(prefix);
    if (atLength === undefined) {
      atLength = new Map();
      drafts.set(prefix, atLength);
    }
    const key = rationalKey(factor);
    let group = atLength.get(key);
    if (group === undefined) {
      group = { factor, rows: new Map() };
      atLength.set(key, group);
    }
    const rowKey = v.join(',');
    const row = group.rows.get(rowKey) ?? { v: [...v], value: 0, plain: 0 };
    row.value += worth * ways;
    row.plain += ways;
    group.rows.set(rowKey, row);
  };

  // Nothing to stop for means the draw branch is always taken, and then the
  // score depends on the whole prefix alone — no opening to enumerate.
  if (stopping.length === 0) enumerateDrawn();
  else enumerateStopping();

  /**
   * Nothing would stop the draws, so every hand takes the draw branch: the
   * draw-class counts alone fix the prefix, and one composition of what is left
   * is one row.
   */
  function enumerateDrawn(): void {
    const held = draws.map(() => 0);
    const v = new Array<number>(classCount).fill(0);
    const hand = new Array<number>(classCount).fill(0);
    const outer = (at: number, prefix: number): void => {
      if (at === draws.length) {
        const drawn = held.reduce((sum, count) => sum + count, 0);
        const fillers = prefix - drawn;
        if (fillers < 0) return;
        const factor = prefixFactor(H, specs, held, fillers);
        if (factor.num === 0n) return;
        v.fill(0);
        draws.forEach((spec, i) => {
          v[spec.cls] = held[i]!;
        });
        compose(rest, 0, fillers, v, capOf, () => {
          // The hand is the prefix less the copies that resolved and left it.
          let size = prefix;
          for (let cls = 0; cls < classCount; cls++) hand[cls] = v[cls]!;
          draws.forEach((spec, i) => {
            const used = copiesUsed(held[i]!, spec);
            hand[spec.cls]! -= used;
            size -= used;
          });
          const worth = weigh(hand, size);
          if (worth > 0) add(prefix, factor, v, worth, 1);
        });
        return;
      }
      const spec = draws[at]!;
      for (let copies = 0; copies <= capOf[spec.cls]!; copies++) {
        held[at] = copies;
        outer(at + 1, prefix + spec.n * copiesUsed(copies, spec));
      }
      held[at] = 0;
    };
    outer(0, H);
  }

  /**
   * Something would stop the draws, so the OPENING decides which window is
   * scored: a row is one (opening, prefix) pair, and the outer loop chooses
   * where each draw card fell — `a` copies among the first `H` cards, `b` after
   * them.
   */
  function enumerateStopping(): void {
    const a = draws.map(() => 0);
    const b = draws.map(() => 0);
    const v = new Array<number>(classCount).fill(0);
    const u = new Array<number>(classCount).fill(0);
    const hand = new Array<number>(classCount).fill(0);
    const outer = (at: number, prefix: number, inOpening: number): void => {
      if (at === draws.length) {
        if (inOpening > H) return;
        const later = b.reduce((sum, count) => sum + count, 0);
        const extension = prefix - H;
        const fillersAfter = extension - later;
        const fillersOpen = H - inOpening;
        if (fillersAfter < 0 || fillersOpen < 0) return;
        const psi = splitFactor(H, specs, a, b, fillersAfter);
        if (psi.num === 0n) return;
        // `C(ℓ, H)` belongs to the factor, not to the rows: it is the
        // denominator of the split the rows' `Π C(v_c, u_c)` counts.
        const factor = reduced(psi.num, psi.den * BigInt(choose(prefix, H)));
        v.fill(0);
        u.fill(0);
        draws.forEach((spec, i) => {
          v[spec.cls] = a[i]! + b[i]!;
          u[spec.cls] = a[i]!;
        });
        // The whole prefix first, then which of it was the opening: a `v` the
        // classes cannot hold is never built, and its splits are never walked.
        compose(rest, 0, fillersOpen + fillersAfter, v, capOf, () => {
          let size = prefix;
          for (let cls = 0; cls < classCount; cls++) hand[cls] = v[cls]!;
          draws.forEach((spec) => {
            const used = copiesUsed(v[spec.cls]!, spec);
            hand[spec.cls]! -= used;
            size -= used;
          });
          // The draw branch's value depends on the whole prefix alone, so it is
          // decided once per `v` rather than once per opening.
          const drawn = weigh(hand, size);
          compose(rest, 0, fillersOpen, u, v, () => {
            // ONE window, decided before anything is drawn — never the better of
            // the two. A `stop` criterion met by the opening stops the draws and
            // the opening is what is valued; otherwise every draw card resolves
            // and the hand that is left is what is valued, however much the
            // opening was worth.
            const worth = stops(u, H) > 0 ? weigh(u, H) : drawn;
            if (worth === 0) return;
            let ways = 1;
            for (let cls = 0; cls < classCount; cls++) ways *= choose(v[cls]!, u[cls]!);
            add(prefix, factor, v, worth, ways);
          });
        });
        return;
      }
      const spec = draws[at]!;
      const cap = capOf[spec.cls]!;
      for (let opened = 0; opened <= cap; opened++)
        for (let later = 0; later + opened <= cap; later++) {
          a[at] = opened;
          b[at] = later;
          const copies = opened + later;
          outer(at + 1, prefix + spec.n * copiesUsed(copies, spec), inOpening + opened);
        }
      a[at] = 0;
      b[at] = 0;
    };
    outer(0, H, 0);
  }

  // A part for every STRUCTURALLY reachable length, holding no row where no
  // hand of that length succeeds: the shape of a score is then a property of
  // the problem and not of the ratio, which is what lets `compareScores` refuse
  // two scores of different shapes instead of comparing them position by
  // position and answering nonsense.
  for (const prefix of reachablePrefixes(H, draws))
    if (!drafts.has(prefix)) drafts.set(prefix, new Map());
  return assemble({ drafts, deckSize, H, classCount, width, maxWeight });
}

/**
 * Every way to give `total` cards to `where`, no class taking more than its
 * `cap` allows, writing into `into` and calling `done` at each. `cap` is either
 * the class maxima (choosing the prefix) or another vector (choosing which of
 * it was the opening).
 */
function compose(
  where: readonly number[],
  at: number,
  total: number,
  into: number[],
  cap: readonly number[],
  done: () => void,
): void {
  if (at === where.length) {
    if (total === 0) done();
    return;
  }
  const cls = where[at]!;
  const most = Math.min(total, cap[cls]!);
  for (let take = 0; take <= most; take++) {
    into[cls] = take;
    compose(where, at + 1, total - take, into, cap, done);
  }
  into[cls] = 0;
}

interface Assembly {
  drafts: Map<number, Map<string, Draft>>;
  deckSize: number;
  H: number;
  classCount: number;
  width: number;
  maxWeight: number;
}

/**
 * The drafts as typed arrays, with the per-part denominator and multipliers
 * worked out once — and the two exactness checks that let every per-deck sum be
 * a float64.
 */
function assemble({ drafts, deckSize, H, classCount, width, maxWeight }: Assembly): DrawSet {
  const parts: DrawPart[] = [];
  let terms = 0;
  let groups = 0;
  for (const prefix of [...drafts.keys()].sort((a, b) => a - b)) {
    const drafted = [...drafts.get(prefix)!.values()];
    const subsets = choose(deckSize, prefix);
    let lcm = 1n;
    for (const { factor } of drafted) lcm = lcmBig(lcm, factor.den);
    // What the part's numerator is over, and the largest it can be: a part's
    // value is at most the largest weight a hand can be worth, so this bounds
    // every intermediate of the combination too.
    const den = Number(lcm) * subsets;
    if (!Number.isSafeInteger(den) || !Number.isSafeInteger(maxWeight * den))
      throw new RangeError(
        `these draw cards cannot be scored exactly: at a prefix of ${prefix} the score is a fraction over ${lcm} × C(${deckSize}, ${prefix}), and ${maxWeight} × that is past 2^53 — mark fewer lines once-per-turn, or hold fewer copies of them`,
      );
    const multipliers = new Float64Array(drafted.length);
    const built: DrawGroup[] = drafted.map(({ factor, rows }, at) => {
      multipliers[at] = Number(factor.num * (lcm / factor.den));
      const count = rows.size;
      const compositions = new Uint8Array(count * width);
      const values = new Float64Array(count);
      const plains = new Float64Array(count);
      let row = 0;
      let most = 0;
      for (const { v, value, plain } of rows.values()) {
        for (let cls = 1; cls < classCount; cls++) compositions[row * width + cls - 1] = v[cls]!;
        values[row] = value;
        plains[row] = plain;
        if (value > most) most = value;
        row++;
      }
      // The group's own sum is `Σ value · Π C(n_c, v_c)`, and the rows'
      // compositions are distinct, so the products partition the ℓ-subsets of
      // the deck: the sum is at most the largest value times `C(N, ℓ)`.
      if (!Number.isSafeInteger(most * subsets))
        throw new RangeError(
          `these draw cards cannot be scored exactly: at a prefix of ${prefix} a term reaches ${most} × C(${deckSize}, ${prefix}), past 2^53`,
        );
      terms += count;
      return { factor, compositions, count, values, plains };
    });
    groups += built.length;
    parts.push({
      prefix,
      groups: built,
      den,
      multipliers,
      terms: built.reduce((sum, group) => sum + group.count, 0),
    });
  }
  return { H, classCount, width, parts, maxWeight, terms, groups };
}
