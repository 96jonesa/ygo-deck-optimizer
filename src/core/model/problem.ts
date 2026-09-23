/**
 * What the exact engine scores (TDD §8): a template with everything symbolic
 * resolved into CLASSES of interchangeable cards and bitmasks over them, so
 * that scoring never touches a description again. `compile` produces it;
 * `src/core/prob` consumes it.
 */

import { MAX_RANGES } from '../criteria/ast';
import { choose } from '../prob/binomial';

/** Classes, the blank class included: a class mask is a non-negative 32-bit integer. */
export const MAX_CLASSES = 30;

/**
 * The largest deck and OPENING hand the engine scores. Exactness rests on them
 * (TDD §10.3): every numerator is at most C(60, 6) = 50,063,860, far below
 * 2^53. With DRAW CARDS the hand grows past `MAX_HAND_SIZE` — `MAX_PREFIX` and
 * `MAX_HAND` below are the bounds that then apply.
 */
export const MAX_DECK_SIZE = 60;
export const MAX_HAND_SIZE = 6;

/**
 * The longest PREFIX of the deck a hand may reach through draw cards
 * (`longestPrefix`), in the `MAX_CLASSES` style: past it the template is an
 * error rather than a slow run.
 *
 * The justification is BUILD TIME alone. `analyze` rebuilds the success set on
 * every keystroke, and the enumeration grows with the prefix: at ten classes a
 * prefix of 16 stays under ~50 ms, where 23 costs 254 ms and 29 costs 705 ms.
 * It is NOT an exactness frontier — C(60, 16) = 149,608,375,854,525 is a long
 * way below 2^53, and `createScorer` checks the exactness of what it actually
 * builds rather than trusting a length.
 */
export const MAX_PREFIX = 16;

/**
 * The largest HAND the engine judges: the prefix less the copies that resolved
 * and left it (`largestHand`). It bounds the requirement slots a criterion may
 * ask for, and so the `2^slots` subset tables the matcher builds — 4,096
 * entries per alternative at this size. Three copies of a card that draws three
 * reach 11 from a hand of five and 12 from a hand of six, so it is the largest
 * hand any ordinary draw card builds; a card that drew ten at once would be
 * refused here rather than allocate for it.
 */
export const MAX_HAND = 12;

/**
 * The compositions `drawSet` will visit before the engine refuses to build at
 * all (`drawWork`), at roughly 200–400 ms a million: about five seconds.
 *
 * It is a SECOND bound and not a restatement of `MAX_PREFIX`, which is the
 * mistake this constant exists to correct. The prefix bounds how DEEP the
 * enumeration reads; the cost is that depth spread over the CLASSES, and over
 * the OPENINGS as well wherever the opening must be read apart from the rest of
 * the prefix. Three copies of Pot of Greed at fifteen classes reach a prefix of
 * 11 — comfortably inside `MAX_PREFIX` — and cost 16 million visits that way at
 * a hand of five, where eighteen classes cost 88 million and three draw-3 lines
 * cost 2.6 BILLION. A cap on the prefix alone lets every one of those through.
 *
 * TWO THINGS ask for the openings, and they cost the same: a `stop` criterion,
 * which decides on the opening whether anything is drawn; and a hand dealt in
 * two pieces (`HandSize.drawn`), which is what `then` needs. Measured equal
 * visit for visit over a sweep — it is one recursion — so the figures above are
 * the figures for `then` too, at the hand size they were taken at. Going second
 * is a hand of six rather than five, and that alone is 4× the walk: three Pots
 * at fifteen classes is 67 million at H = 6 and so refused, where at H = 5 it
 * is 16 million and allowed.
 *
 * A run pays this once and then scores millions of decks against it, so five
 * seconds is affordable there. What is NOT affordable is paying it on a
 * keystroke: `analyze` has its own, far lower bound (`ANALYZE_DRAW_WORK`) past
 * which it declines to build rather than freeze the editor.
 */
export const MAX_DRAW_WORK = 25_000_000;

/** Bit 0: the blank class, which fills no requirement and counts against no limit. */
export const BLANK_BIT = 1;

/**
 * A class whose cards DRAW (PRD §5.7): a copy that RESOLVES leaves the hand and
 * is replaced by `n` cards off the top of the deck. Cards so drawn draw in
 * turn, so the hand is a PREFIX of a shuffled deck whose length is the least
 * fixed point of `ℓ = H + draws(first ℓ)` — not a fixed number of cards. A draw
 * card ALWAYS resolves once the player commits; whether an opening hand that
 * already works commits at all is the criteria's own `stop`.
 */
export interface DrawSpec {
  /**
   * How many cards one resolved copy draws: a positive whole number.
   *
   * A DELIBERATE SIMPLIFICATION, and the one most likely to be mistaken for a
   * bug: there is ONE decision point, before any card is drawn. Either no draws
   * at all, or every draw card in the prefix resolves — bounded only by
   * `oncePerTurn`. A player holding two Pots could activate the first, see the
   * hand is now fine and keep the second; the model resolves both. So for a
   * template that draws, **the number is a LOWER bound on careful play**, and
   * marking a criterion `stop` is the only escape hatch the model offers.
   * Anything finer would be a decision tree, where this is a single fraction.
   */
  n: number;
  /**
   * Only the FIRST copy resolves; further copies sit in the hand unactivated,
   * and are judged like any other card. It is a property of the CARD and not of
   * the class, which is why two once-per-turn lines never share a class
   * (`compileProblem`): each names its own card and each gets its own once.
   */
  oncePerTurn?: true;
}

export interface ClassInfo {
  /** The template lines merged into this class; the blank class may have none. */
  lineIds: string[];
  /** The range of the class TOTAL: the sum of its lines' ranges. */
  min: number;
  max: number;
  /** Set when the class's cards DRAW (PRD §5.7); absent is every class the engine had before. */
  draw?: DrawSpec;
}

/** One draw class with what bounds its copies: all the prefix arithmetic reads. */
export interface DrawClass extends DrawSpec {
  cls: number;
  /** The class's `max`: the most copies any deck of the template can hold. */
  max: number;
}

/** The draw classes of a problem, ascending; empty for every problem without them. */
export function drawClassesOf(classes: readonly ClassInfo[]): DrawClass[] {
  return classes.flatMap(({ draw, max }, cls) =>
    draw === undefined ? [] : [{ cls, max, ...draw }],
  );
}

/**
 * Copies of one draw class that RESOLVE when a prefix holds `held` of them:
 * all of them, or one when the card is once-per-turn.
 */
export function copiesUsed(held: number, { oncePerTurn }: DrawSpec): number {
  return oncePerTurn === true ? Math.min(held, 1) : held;
}

/** The cards the draw cards of a prefix ask for: `Σ n_c · used_c`. */
export function drawsOf(held: ArrayLike<number>, draws: readonly DrawClass[]): number {
  let sum = 0;
  for (const spec of draws) sum += spec.n * copiesUsed(held[spec.cls] ?? 0, spec);
  return sum;
}

/**
 * THE LONGEST PREFIX: `H + Σ n_c · (oncePerTurn ? 1 : max_c)`. It drives
 * `C(N, ℓ)`, the enumeration and the cost — and it is NOT the largest hand.
 * Three copies of Pot of Greed reach a prefix of 11 from a hand of five, and a
 * hand of 8; three Upstart Goblins reach a prefix of 8 and a hand of 5.
 */
export function longestPrefix(H: number, draws: readonly DrawClass[]): number {
  let out = H;
  for (const spec of draws) out += spec.n * (spec.oncePerTurn === true ? 1 : spec.max);
  return out;
}

/**
 * THE LARGEST HAND: the prefix less the copies that resolved and left it,
 * `H + Σ (n_c − 1) · (oncePerTurn ? 1 : max_c)`. It drives the requirement
 * slots, `MAX_HAND` and `expand`'s `maxHandSize` — everything about what a
 * criterion may ASK, where `longestPrefix` drives what a score COSTS.
 */
export function largestHand(H: number, draws: readonly DrawClass[]): number {
  let out = H;
  for (const spec of draws) out += (spec.n - 1) * (spec.oncePerTurn === true ? 1 : spec.max);
  return out;
}

/**
 * THE LARGEST DRAWN SET: the most cards `then` can ever be asked about (PRD
 * §5.6, §5.7). Going second the hand is dealt in two pieces, and with draw
 * cards the second piece is no longer one card: it is everything from position
 * `H − 1` on — the card drawn for turn, and whatever the draw cards fetched.
 *
 * Two bounds, and it is the smaller:
 *
 * - the POSITIONS there are, `ℓ − (H − 1)`, which is `1 + Σ n_c · k_c` — one
 *   for the card drawn for turn, and one for each card fetched;
 * - the whole HAND, `largestHand`, since the drawn set is part of it.
 *
 * Neither dominates. Three copies of Pot of Greed give 7 positions against a
 * hand of 9, so the positions bind; six Upstart Goblins give 7 positions
 * against a hand of 6, and the hand binds — the opening five cannot hold all
 * six copies, so at least one resolves out of the drawn set itself.
 *
 * The minimum is REACHED, not merely an upper bound: of the `R` copies that
 * resolve, at most `H − 1` can be dealt into the cards opened on, so the drawn
 * set loses exactly `max(0, R − (H − 1))` of them, and placing the rest in the
 * opening is always possible. With no draw card it is 1, the card drawn for
 * turn, which is what `then` has always meant.
 */
export function largestDrawnSet(H: number, draws: readonly DrawClass[]): number {
  return Math.min(longestPrefix(H, draws) - (H - 1), largestHand(H, draws));
}

/**
 * THE COMPOSITIONS `drawSet` WOULD VISIT, counted without visiting them — the
 * cost of a BUILD, known before paying it.
 *
 * It exists because `MAX_PREFIX` does not bound the build. The prefix bounds
 * how DEEP the enumeration reads; the cost is that depth spread over the
 * CLASSES, and with a stop criterion over the openings as well. Three copies of
 * Pot of Greed at fifteen classes reach a prefix of 11 — comfortably inside
 * `MAX_PREFIX` — and with a stop criterion take 6.5 seconds to build. `analyze`
 * runs on every edit, in the main process, synchronously: that is not a slow
 * editor but a frozen application, so it is refused rather than attempted.
 *
 * Counted EXACTLY, by the recursion `drawSet` itself walks with the inner
 * composition replaced by a count of it: a few thousand operations, whatever
 * the answer, so asking is always cheap even when the answer is "far too much".
 *
 * It lives HERE rather than beside the recursion it mirrors, so that
 * `problem.ts` and `draw-set.ts` do not import each other — and because two
 * copies of one recursion is how they drift, a test counts the visits of the
 * real enumeration and holds this equal to them.
 */
/**
 * Whether the hand of `H` is dealt in two pieces — the cards opened on, and
 * then the card drawn for turn with whatever follows it (`HandSize.drawn`).
 *
 * Read off the problem's own declaration of the hand, exactly as `successSet`
 * reads it, so that the enumeration, its cost and the denominator all answer
 * the same question. A problem that never declares this `H` is not one, which
 * is what a bare `createScorers(problem, H)` for another hand asks for.
 */
export function opensApart(problem: Pick<Problem, 'handSizes'>, H: number): boolean {
  return problem.handSizes.find((hand) => hand.H === H)?.drawn === true;
}

export function drawWork(problem: Problem, H: number): number {
  const draws = drawClassesOf(problem.classes);
  if (draws.length === 0) return 0;
  const classCount = problem.classes.length;
  const longest = longestPrefix(H, draws);
  const rest: number[] = [];
  for (let cls = 0; cls < classCount; cls++)
    if (draws.every((spec) => spec.cls !== cls)) rest.push(cls);
  const capOf = rest.map((cls) => Math.min(problem.classes[cls]!.max, longest));
  // The (prefix, opening) walk is what a STOP decision needs, and equally what
  // a hand whose last card is drawn separately needs: both read the opening `H`
  // apart from the rest of the prefix. Either one, and the count is over PAIRS.
  const stopping = problem.criteria.some(({ stop }) => stop === true) || opensApart(problem, H);

  /** The ways to give `total` cards to the non-draw classes within their maxima. */
  const spread = new Map<number, number>();
  const spreadOf = (total: number): number => {
    const known = spread.get(total);
    if (known !== undefined) return known;
    let ways = new Float64Array(total + 1);
    ways[0] = 1;
    for (const cap of capOf) {
      const next = new Float64Array(total + 1);
      for (let had = 0; had <= total; had++) {
        const from = ways[had]!;
        if (from === 0) continue;
        for (let take = 0; take <= cap && had + take <= total; take++) next[had + take]! += from;
      }
      ways = next;
    }
    const out = ways[total]!;
    spread.set(total, out);
    return out;
  };

  /** The (prefix, opening) PAIRS: the same spread, split into what was opened on. */
  const pairs = new Map<string, number>();
  const pairsOf = (opened: number, after: number): number => {
    const key = `${opened},${after}`;
    const known = pairs.get(key);
    if (known !== undefined) return known;
    const width = after + 1;
    let ways = new Float64Array((opened + 1) * width);
    ways[0] = 1;
    for (const cap of capOf) {
      const next = new Float64Array((opened + 1) * width);
      for (let u = 0; u <= opened; u++)
        for (let w = 0; w <= after; w++) {
          const from = ways[u * width + w]!;
          if (from === 0) continue;
          for (let take = 0; take <= cap; take++)
            for (let mine = 0; mine <= take; mine++) {
              const toU = u + mine;
              const toW = w + take - mine;
              if (toU <= opened && toW <= after) next[toU * width + toW]! += from;
            }
        }
      ways = next;
    }
    const out = ways[opened * width + after]!;
    pairs.set(key, out);
    return out;
  };

  let work = 0;
  if (!stopping) {
    const held = draws.map(() => 0);
    const walk = (at: number, prefix: number): void => {
      if (at === draws.length) {
        const fillers = prefix - held.reduce((sum, count) => sum + count, 0);
        if (fillers >= 0) work += spreadOf(fillers);
        return;
      }
      const spec = draws[at]!;
      for (let copies = 0; copies <= Math.min(spec.max, longest); copies++) {
        held[at] = copies;
        walk(at + 1, prefix + spec.n * copiesUsed(copies, spec));
      }
      held[at] = 0;
    };
    walk(0, H);
    return work;
  }

  /**
   * Whether the process can reach an extension at all — `splitFactor` would
   * answer 0 otherwise, and `drawSet` skips such a split without composing
   * anything, so counting it would over-state the build by a third.
   *
   * Decided GREEDILY rather than by the DP the factor uses: place the copies
   * that add most to the budget first, since that maximises every prefix of the
   * path at once, and a valid arrangement exists exactly when that one is valid.
   */
  const reachable = (
    opened: readonly number[],
    later: readonly number[],
    fillersAfter: number,
  ): boolean => {
    const placed = later.map(() => 0);
    let budget = H;
    for (let i = 0; i < draws.length; i++)
      budget += draws[i]!.n * copiesUsed(opened[i]!, draws[i]!);
    const extension = fillersAfter + later.reduce((sum, count) => sum + count, 0);
    for (let step = 0; step < extension; step++) {
      if (budget <= H + step) return false;
      // The next copy that adds most; a filler adds nothing and goes last.
      let best = -1;
      let gain = 0;
      for (let i = 0; i < later.length; i++) {
        if (placed[i]! >= later[i]!) continue;
        const spec = draws[i]!;
        const held = opened[i]! + placed[i]!;
        const adds = spec.n * (copiesUsed(held + 1, spec) - copiesUsed(held, spec));
        if (adds > gain || best < 0) {
          best = i;
          gain = adds;
        }
      }
      if (best < 0) continue;
      placed[best]!++;
      budget += gain;
    }
    return true;
  };

  const a = draws.map(() => 0);
  const b = draws.map(() => 0);
  const walk = (at: number, prefix: number, inOpening: number): void => {
    if (at === draws.length) {
      if (inOpening > H) return;
      const later = b.reduce((sum, count) => sum + count, 0);
      const fillersAfter = prefix - H - later;
      const fillersOpen = H - inOpening;
      if (fillersAfter < 0 || fillersOpen < 0) return;
      if (reachable(a, b, fillersAfter)) work += pairsOf(fillersOpen, fillersAfter);
      return;
    }
    const spec = draws[at]!;
    const cap = Math.min(spec.max, longest);
    for (let opened = 0; opened <= cap; opened++)
      for (let later = 0; later + opened <= cap; later++) {
        a[at] = opened;
        b[at] = later;
        walk(at + 1, prefix + spec.n * copiesUsed(opened + later, spec), inOpening + opened);
      }
    a[at] = 0;
    b[at] = 0;
  };
  walk(0, H, 0);
  return work;
}

export interface CompiledLimit {
  /** The classes whose cards count against the limit. */
  mask: number;
  n: number;
}

/** One requirement: between `min` and `max` of the hand's cards of `mask` are assigned to it. */
export interface CompiledRequirement {
  /** The classes that fill it. */
  mask: number;
  min: number;
  /** `null` is no ceiling, which is what a plain `n×` means. */
  max: number | null;
}

/**
 * A `unique` requirement (`3x unique {Starter}`): `n` cards of the classes in
 * `mask`, no two of them of the same class.
 *
 * That is "no two the same CARD" because `compileProblem` gives every card a
 * `unique` requirement can take a class of its own — the identity columns of
 * TDD §8 — so a class in this mask is one card, however many copies of it the
 * deck holds. The engine cannot check that and does not try: a `Problem` has no
 * cards in it, only classes, and a hand-built one that merged two cards into a
 * class would simply be asking "no two of the same class".
 *
 * It is NOT in `slots`, whose Hall condition would let one class fill all `n`;
 * the matcher reads it beside them (`src/core/prob/matcher.ts`).
 */
export interface CompiledUnique {
  mask: number;
  n: number;
  /**
   * At most this many DIFFERENT cards (`exactly 2x unique`, `2-3x unique`), and
   * absent for no ceiling — every `unique` requirement written before it, byte
   * for byte. A card of its mask left to nothing must be of a class it took:
   * another copy of a card it counts is no new different card (TDD §10.1).
   */
  max?: number;
}

/**
 * THE DRAWN SET's part of a split criterion: the same three fields, judged
 * against what the player DREW (PRD §5.6, §5.7).
 *
 * Without draw cards that is the one card drawn for turn, `slots` holds at most
 * one mask, and a limit there is a census over that card alone — `no trap` says
 * the card drawn is not a trap. WITH draw cards it is the card drawn for turn
 * and everything the draw cards fetched, up to `largestDrawnSet`, so `then 2x
 * monster` becomes a question something can answer and a limit of 1 can bind.
 * The field is still called `sixth` because that is what it is whenever nothing
 * draws, which is every template written before draw cards existed.
 */
export interface SixthCard {
  slots: number[];
  limits: CompiledLimit[];
  reqs?: CompiledRequirement[];
  uniques?: CompiledUnique[];
}

export interface CompiledCriterion {
  /**
   * One class bitmask per requirement slot: the classes that can fill it.
   * A requirement contributes its LOWER bound in slots — `n×` is `n` slots,
   * and `0-2×` is none. This is all a criterion without ceilings needs.
   */
  slots: number[];
  limits: CompiledLimit[];
  /**
   * Every requirement of the criterion, whole — present only when one of them
   * has a ceiling that can bind, so that a criterion in the language as it was
   * is byte for byte what it always was. `slots` is exactly these expanded by
   * their lower bounds, and `validateProblem` holds the two to that.
   *
   * A ceiling cannot be read off `slots`, and neither can it be kept apart
   * from its own lower bound: `1-2×` takes two cards in total, not one for its
   * slot and two more under its ceiling.
   */
  reqs?: CompiledRequirement[];
  /**
   * The `unique` requirements (`CompiledUnique`), present only when there is
   * one, so that every criterion without them is byte for byte what it was.
   * They are NOT in `slots` or `reqs`: those are the plain requirements, and
   * the matcher judges these beside them, a card given to one being given to
   * nothing else.
   */
  uniques?: CompiledUnique[];
  /**
   * What a hand meeting it is WORTH (PRD §5.6, weighted criteria). A positive
   * whole number; absent is 1, which is every criterion of an unweighted run
   * and is why such a run is byte for byte what it always was.
   *
   * A hand meeting several criteria is worth the HIGHEST of their weights, not
   * their sum — it is one hand, and the best thing it can do is the best thing
   * it can do. Whole numbers, because the score is `Σ w · ways` and exactness
   * (TDD §10.3) rests on that sum being an integer; `validateProblem` holds the
   * largest weight to what `C(N, H)` leaves below 2^53.
   */
  weight?: number;
  /**
   * THE DRAWN SET's own part (PRD §5.6). Present: `slots`, `limits` and `reqs`
   * above are about the cards OPENED ON — the first `H − 1` dealt — and this is
   * about everything from there on. Absent: the criterion is judged over the
   * whole hand, which is every criterion the language had before this and is
   * why such a run is byte for byte what it always was.
   *
   * WITH DRAW CARDS the drawn set GENERALISES rather than changes: it is
   * positions `H − 1 … ℓ − 1`, the card drawn for turn and whatever the draw
   * cards fetched, less any copy that resolved out of it. With no draw card
   * ℓ = H and it is the one card at position `H − 1`, bit for bit the answer
   * this always gave.
   *
   * It may only be judged by a hand size marked `drawn`, and `validateProblem`
   * holds it to that: the split is a statement about a hand you draw in two
   * pieces, and going first nothing is drawn to speak of.
   */
  sixth?: SixthCard;
  /**
   * THE WHOLE HAND's own part — what `finally` writes (PRD §5.5). Present:
   * `slots`, `limits` and `reqs` above are about the cards OPENED ON, exactly as
   * they are when `sixth` is present, and this is judged over the whole hand —
   * the union of the two dealt windows. Absent: nothing is asked of the whole
   * hand as such, which is every criterion the engine had before this.
   *
   * SO "IS THIS CRITERION SPLIT?" IS `sixth !== undefined || whole !== undefined`
   * and not either one alone. A criterion with a `finally` part and no `then`
   * still reads its first window as the cards opened on, and anything testing
   * only `sixth` would judge that window over the whole hand — which is the one
   * reading `finally` exists to deny.
   *
   * It costs the enumeration nothing. A `finally` part is a predicate on the
   * hand composition itself, which is fixed in `compileValuer`'s outer sum, so it
   * composes with `value(h) = Σ_c h_c · best(h − e_c, c)` untouched: no new
   * sample space, no new walk, and the `H · C(N, H)` denominator unchanged
   * (TDD §10.6).
   *
   * Like `sixth` it may only be judged by a hand size marked `drawn`, and
   * `validateProblem` holds it to that: the split is a statement about a hand
   * dealt in two pieces, and going first nothing is drawn.
   */
  whole?: SixthCard;
  /**
   * A criterion the player would STOP for (PRD §5.7): if the OPENING hand
   * already meets it, no draw card is activated at all. Absent is the default,
   * and every criterion the engine had before draw cards.
   *
   * **It governs the stop DECISION and nothing else.** Whichever window that
   * decision lands on, EVERY criterion of the problem is then judged in it — a
   * criterion marked `stop` is not "a criterion that may only be read
   * pre-draw", and one left alone is not barred from the opening. Read the two
   * states as: unchecked (`stop`) is *"I would stop for this"*, and checked is
   * *"I am willing to lose this by drawing"*.
   *
   * ONE DECISION POINT, taken before any card is drawn (`compileValuer`'s
   * counterpart for prefixes, `drawSet`):
   *
   *     look at the opening H cards
   *       any `stop` criterion met?
   *         yes -> STOP. worth the best weight among ALL criteria the OPENING meets
   *         no  -> DRAW every draw card. worth the best weight among ALL criteria
   *                the POST-DRAW hand meets — 0 if drawing broke them, with no
   *                falling back on what the opening would have been worth
   *
   * There is deliberately no MAXIMUM over the two windows and no per-card
   * choice: the draw decision is *determined* by the opening, so exactly one
   * window is ever in play. A criterion worth 5 that draws into a 2 scores 2. A
   * hand that draws out of everything scores 0 even though its opening would
   * have scored. That is what makes the value strategy-achievable rather than an
   * upper bound with hindsight — and it is why the ordering factor exists at
   * all, since the continuation is fixed once the player commits.
   *
   * Without draw cards the two windows are the same hand, so this changes
   * nothing whichever way it is set — a fact a test pins.
   */
  stop?: true;
}

export interface HandSize {
  H: number;
  /**
   * The hand size's share of a first/second blend, as a RATIO of positive
   * whole numbers — `1 : 1` for a coin flip, `3 : 2` for going first 60% of
   * the time — never a fraction of 1: blends are ranked in exact integers.
   */
  weight: number;
  /**
   * Which of `Problem.criteria` this hand is judged against — indices, not
   * criteria — when the two hands are judged against different ones (PRD
   * §5.5: going first over the criteria for going first). Absent: all of them,
   * which is every problem that has one hand size and every blend of criteria
   * that apply either way.
   *
   * INDICES, and not a criteria list of its own, because the two hands must
   * score the SAME deck: a class vector means what `classes` says it means,
   * and a criterion compiled against other classes would read the same vector
   * as a different deck. Sharing one `criteria` list makes that unsayable
   * rather than merely untrue — and `partProblem` is the only way a part's
   * criteria are ever taken out of it.
   */
  criteria?: number[];
  /**
   * Whether this hand's LAST card is DRAWN: going second you see five cards
   * and then draw one (PRD §5.5), and a criterion may then speak of that card
   * on its own (`CompiledCriterion.sixth`).
   *
   * It changes the SAMPLE SPACE, and that is the whole of what it does. A hand
   * stops being a set of `H` cards and becomes the ordered pair (the opening
   * `H - 1`, the card drawn), of which there are `H` per set — so every count
   * is `H` times what it was, `outcomesOf` is that `H`, and a run in which
   * nothing is split scores exactly what it always scored with both sides of
   * the fraction multiplied by it (a fact pinned by a test).
   *
   * WITH DRAW CARDS it says the same thing about the same position: the prefix
   * is read as (the first `H − 1` cards, everything from `H − 1` on), and the
   * first `H` positions being unconstrained is exactly why the card at `H − 1`
   * is still one of `H` equally likely ones given the prefix (`drawSet`).
   *
   * It is a property of the HAND and not of the criteria, so that every score
   * of one run — the headline and each criterion's own row — is a fraction over
   * one denominator. `compileProblem` sets it wherever a criterion the hand
   * judges is split, and honours it wherever a caller asks for it.
   */
  drawn?: boolean;
}

/**
 * The outcomes one hand of `hand.H` cards holds: `H` when its last card is
 * drawn separately — a set of `H` cards is `H` different (opening, drawn)
 * pairs — and 1 otherwise, which is every hand the engine had before.
 */
export function outcomesOf(hand: Pick<HandSize, 'H' | 'drawn'>): number {
  return hand.drawn === true ? hand.H : 1;
}

export interface Problem {
  /** N. */
  deckSize: number;
  /** `[{ H: 5, weight: 1 }]`, or a first/second blend. */
  handSizes: HandSize[];
  /** Index 0 is ALWAYS the blank class, even when it holds no card. */
  classes: ClassInfo[];
  /** Flat: a hand succeeds if it meets ANY of these. */
  criteria: CompiledCriterion[];
}

const isCount = (value: number) => Number.isInteger(value) && value >= 0;

/**
 * Whether a criterion reads the hand as MORE THAN ONE WINDOW — a `then` part, a
 * `finally` part, or both. It is the one question everything that scores a hand
 * asks of a criterion, so it is asked in one place: a second copy of
 * `sixth !== undefined` that forgot `whole` would judge a `finally` criterion's
 * opening part over all six cards and answer a different question in silence.
 *
 * Structural on purpose — the presence of the keys and nothing about their
 * contents — so that the compiled criterion, the resolved alternative
 * (`FlatAlternative`) and the flat one (`FlatCriterion`) are all asked in the
 * same words, which is the whole point of having it in one place.
 */
export function isSplit(criterion: { sixth?: unknown; whole?: unknown }): boolean {
  return criterion.sixth !== undefined || criterion.whole !== undefined;
}

function checkMask(mask: number, classCount: number, where: string, role: string): void {
  if (!isCount(mask))
    throw new RangeError(`${where}: a class mask is a non-negative whole number, not ${mask}`);
  if (mask >= 2 ** classCount)
    throw new RangeError(
      `${where}: the mask ${mask.toString(2)} names a class the problem does not have — it has only ${classCount} classes`,
    );
  if (mask % 2 === BLANK_BIT)
    throw new RangeError(`${where}: the blank class (bit 0) cannot ${role}`);
}

/**
 * The largest weight any criterion of `problem` carries, and never below 1: a
 * problem with no criteria, and one whose criteria are all unweighted, both
 * answer 1, which is what makes the weighted score of an unweighted problem
 * the probability it always was.
 */
export function maxCriterionWeight(problem: Pick<Problem, 'criteria'>): number {
  let most = 1;
  for (const { weight } of problem.criteria)
    if (weight !== undefined && weight > most) most = weight;
  return most;
}

/** Throws unless `H` is a hand the engine can score from a deck of `deckSize`. */
export function checkHandSize(H: number, deckSize: number): void {
  if (!Number.isInteger(H) || H < 1 || H > MAX_HAND_SIZE || H > deckSize)
    throw new RangeError(
      `a hand size is a whole number from 1 to ${Math.min(MAX_HAND_SIZE, deckSize)}, not ${H}`,
    );
}

/**
 * Throws a `RangeError` naming the first thing wrong with `problem`. The
 * engine's entry points call it, so a malformed problem is an error where it
 * enters and never a silently wrong probability.
 */
export function validateProblem(problem: Problem): void {
  const { deckSize, handSizes, classes, criteria } = problem;
  if (!Number.isInteger(deckSize) || deckSize < 1 || deckSize > MAX_DECK_SIZE)
    throw new RangeError(
      `the deck size is a whole number from 1 to ${MAX_DECK_SIZE}, not ${deckSize}`,
    );

  if (handSizes.length === 0) throw new RangeError('a problem needs at least one hand size');
  const seen = new Set<number>();
  for (const hand of handSizes) {
    const { H, weight, criteria: own, drawn } = hand;
    checkHandSize(H, deckSize);
    if (seen.has(H)) throw new RangeError(`hand size ${H} appears twice`);
    seen.add(H);
    if (!Number.isInteger(weight) || weight < 1)
      throw new RangeError(
        `hand size ${H}: a weight is a positive whole number — a blend is a ratio such as 1 : 1 — not ${weight}`,
      );
    // One card drawn leaves none to open on, and the split says something
    // about both halves of the hand.
    if (drawn === true && H < 2)
      throw new RangeError(
        `hand size ${H}: a hand whose last card is drawn separately holds at least 2 cards — one to open on, and the one drawn`,
      );
    const taken = new Set<number>();
    for (const at of own ?? criteria.map((_, index) => index)) {
      if (!Number.isInteger(at) || at < 0 || at >= criteria.length)
        throw new RangeError(
          `hand size ${H}: \`criteria\` holds ${at}, which is not one of the problem's ${criteria.length} criteria`,
        );
      if (taken.has(at)) throw new RangeError(`hand size ${H}: criterion ${at} appears twice`);
      taken.add(at);
      // A split criterion is a statement about a hand drawn in two pieces, so
      // the hand judging it has to be one — going first there is no sixth card,
      // and so no "the first five" for a `finally` part to stand apart from.
      if (isSplit(criteria[at]!) && drawn !== true)
        throw new RangeError(
          `hand size ${H}: criterion ${at} is about the card you draw, but this hand does not draw one — a split criterion is judged only by a hand marked \`drawn\``,
        );
    }
  }

  if (classes.length === 0)
    throw new RangeError('a problem has at least the blank class, at index 0');
  if (classes.length > MAX_CLASSES)
    throw new RangeError(
      `a problem has at most ${MAX_CLASSES} classes, the blank class included, not ${classes.length}`,
    );
  classes.forEach(({ min, max, draw }, cls) => {
    if (!isCount(min) || !isCount(max) || min > max)
      throw new RangeError(
        `class ${cls}: a range is 0 <= min <= max in whole cards, not ${min} to ${max}`,
      );
    if (draw === undefined) return;
    if (!Number.isInteger(draw.n) || draw.n < 1)
      throw new RangeError(
        `class ${cls}: a draw card draws a positive whole number of cards, not ${draw.n} — a card that draws nothing is not a draw card`,
      );
    // The blank class is the cards no criterion can see. A card that DRAWS is
    // seen by every criterion at once, through the hand it builds.
    if (cls === 0)
      throw new RangeError('the blank class cannot draw: its cards are the ones nothing can see');
  });

  const draws = drawClassesOf(classes);
  // What `then` may ask for: one card without draw cards, and the whole drawn
  // set with them. Over every declared hand, since a criterion belongs to the
  // problem rather than to one of them — and a hand that draws none refuses a
  // split criterion outright above, so the widest hand is never too generous.
  const drawnRoom = Math.max(...handSizes.map(({ H }) => largestDrawnSet(H, draws)));
  criteria.forEach(({ weight, sixth, whole, ...part }, criterion) => {
    if (weight !== undefined && (!Number.isSafeInteger(weight) || weight < 1))
      throw new RangeError(
        `criterion ${criterion}: a weight is a positive whole number — the score is a sum of weights, and exactness rests on that — not ${weight}`,
      );
    checkPart(part, classes.length, `criterion ${criterion}`);
    // The WHOLE HAND's part carries no slot bound of its own, for the reason the
    // criterion's own part carries none: it is judged over the whole hand, and a
    // part asking more cards than a hand holds is never met — `meets` refuses it
    // — rather than malformed. Only `then` is bounded, because what the drawn set
    // can hold is a fact about the TEMPLATE's draw cards and not about the hand.
    if (whole !== undefined)
      checkPart(whole, classes.length, `criterion ${criterion}, the whole hand`);
    if (sixth === undefined) return;
    const asked = slotCount(sixth);
    if (asked > drawnRoom)
      throw new RangeError(
        drawnRoom === 1
          ? `criterion ${criterion}: the card you draw is one card, and its part asks for ${asked}`
          : `criterion ${criterion}: the cards you draw are at most ${drawnRoom}, and this part asks for ${asked}`,
      );
    checkPart(sixth, classes.length, `criterion ${criterion}, the cards you draw`);
  });

  const most = maxCriterionWeight(problem);
  if (draws.length === 0) {
    for (const hand of problem.handSizes)
      checkWeightBound(deckSize, hand.H, most, outcomesOf(hand));
    return;
  }
  for (const hand of problem.handSizes) checkDraws(problem, hand, draws, most);
}

/**
 * A count as the reader needs it, in full. Rounding to millions here once said
 * "25 million compositions to build, and the engine builds at most 25 million"
 * — the same number twice, reading as a contradiction, and telling someone who
 * must drop copies nothing about how many.
 */
const exactly = (value: number) => value.toLocaleString('en-US');

/** `1.06×` just over a bound, `32×` well past it: both say how far, neither rounds to `1×`. */
export function overBy(value: number, bound: number): string {
  const times = value / bound;
  return times >= 10 ? `${Math.round(times)}×` : `${times.toFixed(2)}×`;
}

/**
 * What draw cards make of one hand size — the whole of the engine's refusal
 * list for them, in the `MAX_CLASSES` style: an error where it enters, never a
 * silently wrong probability.
 */
function checkDraws(
  problem: Problem,
  hand: HandSize,
  draws: readonly DrawClass[],
  maxWeight: number,
): void {
  const { deckSize } = problem;
  const { H } = hand;
  const where = `a hand of ${H}`;

  const prefix = longestPrefix(H, draws);
  // DECK-OUT, refused rather than modelled: the model would drop that mass
  // rather than mis-count it, and refusing is what buys the standing invariant
  // that the reachable prefixes carry probability exactly 1.
  if (prefix > deckSize)
    throw new RangeError(
      `${where}: these draw cards can ask for ${prefix} cards from a deck of ${deckSize} — the deck would run out; hold fewer copies, or draw fewer cards`,
    );
  if (prefix > MAX_PREFIX)
    throw new RangeError(
      `${where}: these draw cards reach ${prefix} cards deep, and the engine scores at most ${MAX_PREFIX} — hold fewer copies of a draw card, or draw fewer cards`,
    );
  const work = drawWork(problem, H);
  if (work > MAX_DRAW_WORK)
    throw new RangeError(
      `${where}: these draw cards would take ${exactly(work)} compositions to build, ${overBy(work, MAX_DRAW_WORK)} the ${exactly(MAX_DRAW_WORK)} the engine allows — ${remedies(problem).join(', ')}`,
    );
  const largest = largestHand(H, draws);
  if (largest > MAX_HAND)
    throw new RangeError(
      `${where}: these draw cards build a hand of up to ${largest} cards, and the engine judges at most ${MAX_HAND}`,
    );
  // The prefix, not the hand: a score sums over the ℓ-card prefixes, so
  // `C(N, ℓ)` is what a numerator is bounded by — times `H` where the hand is
  // dealt in two pieces, for the reason `outcomesOf` gives. It is an EARLY
  // check and not the whole one: the ordering factors put a further lcm under
  // the fraction, which only `drawSet` knows, and which it checks itself.
  checkWeightBound(deckSize, prefix, maxWeight, outcomesOf(hand), 'prefix');
}

/**
 * What to do about a build that is too large, naming only what this template
 * actually has.
 *
 * The cost is the prefix spread over the CLASSES, and doubled again over the
 * OPENINGS wherever the opening must be read apart from the rest of the prefix
 * — which a "stop here" asks for, and which `then` asks for too. Both are worth
 * naming, and neither is worth naming when it is not there: a refusal is code
 * that runs only when someone is already stuck, so advice to drop a "stop here"
 * the template does not have is worse than no advice at all.
 */
function remedies({ criteria }: Problem): string[] {
  const out = ['hold fewer copies of a draw card', 'merge lines the criteria cannot tell apart'];
  if (criteria.some(({ stop }) => stop === true)) out.push('drop a "stop here"');
  if (criteria.some(isSplit))
    out.push(
      "or empty a criterion's opening-5 and drawn-cards fields (either reads the cards you opened on apart from the cards you drew)",
    );
  return out;
}

/** The cards one window's requirements ask for: its slots, and every `unique` requirement's `n`. */
export function slotCount({ slots, uniques }: Pick<SixthCard, 'slots' | 'uniques'>): number {
  return slots.length + (uniques ?? []).reduce((sum, { n }) => sum + n, 0);
}

/** The slots, limits and ranges of one window: a whole hand, or the card drawn. */
function checkPart(
  { slots, limits, reqs, uniques }: SixthCard,
  classCount: number,
  where: string,
): void {
  slots.forEach((mask, slot) => {
    checkMask(mask, classCount, `${where}, slot ${slot}`, 'fill a requirement');
  });
  limits.forEach(({ mask, n }, limit) => {
    const at = `${where}, limit ${limit}`;
    checkMask(mask, classCount, at, 'count against a limit');
    if (!isCount(n)) throw new RangeError(`${at}: a limit's count is a whole number, not ${n}`);
  });
  if (reqs !== undefined) checkRequirements(reqs, slots, classCount, where);
  if (uniques === undefined) return;
  // Absent rather than empty, for the reason `reqs` is: a criterion without one
  // is the criterion it always was.
  if (uniques.length === 0)
    throw new RangeError(`${where}: with no \`unique\` requirement, \`uniques\` is left out`);
  uniques.forEach(({ mask, n, max }, at) => {
    const unique = `${where}, unique requirement ${at}`;
    checkMask(mask, classCount, unique, 'fill a requirement');
    if (max === undefined) {
      if (!Number.isInteger(n) || n < 1)
        throw new RangeError(`${unique}: it asks for a positive whole number of cards, not ${n}`);
      return;
    }
    if (!isCount(n) || !isCount(max) || max < n)
      throw new RangeError(
        `${unique}: a range is 0 <= n <= max in whole cards, not ${n} to ${max}`,
      );
    if (mask === 0)
      throw new RangeError(`${unique}: a ceiling no class can reach binds nothing and is dropped`);
  });
  const ceilings =
    (reqs ?? []).filter(({ max }) => max !== null).length +
    uniques.filter(({ max }) => max !== undefined).length;
  if (ceilings > MAX_RANGES)
    throw new RangeError(
      `${where}: the engine judges at most ${MAX_RANGES} range requirements, not ${ceilings}`,
    );
}

/**
 * THE EXACTNESS BOUND for weighted criteria (TDD §10.3). A weighted numerator
 * is `Σ_h w(h) · Π_c C(n_c, h_c)`, and every hand is counted once by exactly
 * one composition, so the whole sum is at most `max(w) · C(N, H)` — with
 * `C(60, 6) = 50,063,860` that leaves room for weights up to 179,914,198, and
 * far more for a smaller deck. Past it the sum would be ROUNDED and two decks
 * could then tie, or fail to, by accident. So this throws rather than answer
 * inexactly, which is the choice `compareScores` and `rankKey` already make
 * about a blend.
 *
 * Checked per HAND SIZE, since `C(N, 6) > C(N, 5)`: a weight a going-first run
 * can score exactly is not necessarily one an average can.
 *
 * `outcomes` is `outcomesOf` the hand — 6 where the sixth card is drawn
 * separately, since every hand is then six (opening, drawn) pairs and every
 * count is six times what it was. It multiplies the headroom away exactly as a
 * weight does, so it is part of the SAME bound and not a second one:
 * `6 × C(60, 6) = 300,383,160` leaves room for weights up to 29,985,699, and
 * far more for a smaller deck. The editor's cap of 1,000 is nowhere near it —
 * which is the point of having the number rather than trusting it.
 */
export function checkWeightBound(
  deckSize: number,
  H: number,
  maxWeight: number,
  outcomes = 1,
  /** What `H` counts: the cards of a hand, or — with draw cards — of a prefix. */
  what: 'hand' | 'prefix' = 'hand',
): void {
  const den = choose(deckSize, H) * outcomes;
  if (Number.isSafeInteger(maxWeight * den)) return;
  const drawn = outcomes === 1 ? '' : `${outcomes} × `;
  throw new RangeError(
    `a weight of ${maxWeight} cannot be scored exactly at a ${what} of ${H}: the score would reach ${maxWeight} × ${drawn}C(${deckSize}, ${H}) = ${maxWeight} × ${den}, past 2^53 — the largest weight this deck and ${what} allow is ${Math.floor(Number.MAX_SAFE_INTEGER / den)}`,
  );
}

/**
 * ONE part of a blend as a problem in its own right: the same deck, **the same
 * classes**, and only the criteria that part is judged against (TDD §10.3).
 *
 * The classes are the same object, not a copy of one: that is what makes the
 * two parts of an average score the same deck. A class vector is meaningless
 * on its own — it is `classes` that says which cards a total counts — so two
 * parts built from two class lists would be averaging two different decks, and
 * nothing downstream could tell. Here, `n` is handed to both scorers unchanged
 * and both read it against the list it came from.
 *
 * What differs is the SUCCESS SET, and only that: each part keeps its own
 * criteria, so a hand of five is judged by the criteria for going first and a
 * hand of six by those for going second.
 */
export function partProblem(problem: Problem, hand: HandSize): Problem {
  return {
    deckSize: problem.deckSize,
    // `drawn` travels with the part: it says what a HAND is, and a part that
    // forgot it would answer over a sample space its siblings do not share.
    handSizes: [
      hand.drawn === true ? { H: hand.H, weight: 1, drawn: true } : { H: hand.H, weight: 1 },
    ],
    classes: problem.classes,
    criteria:
      hand.criteria === undefined
        ? problem.criteria
        : hand.criteria.map((at) => {
            const criterion = problem.criteria[at];
            if (criterion === undefined)
              throw new RangeError(
                `hand size ${hand.H}: there is no criterion ${at} — the problem has ${problem.criteria.length}`,
              );
            return criterion;
          }),
  };
}

/** The multiset of slot masks, as a string that two equal multisets share. */
const slotKey = (masks: readonly number[]) => [...masks].sort((a, b) => a - b).join(',');

/**
 * `reqs` is only there for the ceilings, and it may not quietly say something
 * else than `slots` does: the two are one requirement list, read two ways.
 */
function checkRequirements(
  reqs: readonly CompiledRequirement[],
  slots: readonly number[],
  classCount: number,
  owner: string,
): void {
  const ceilings = reqs.filter(({ max }) => max !== null).length;
  if (ceilings === 0)
    throw new RangeError(
      `${owner}: with no ceiling to keep, \`reqs\` is left out and \`slots\` says it all`,
    );
  if (ceilings > MAX_RANGES)
    throw new RangeError(
      `${owner}: the engine judges at most ${MAX_RANGES} range requirements, not ${ceilings}`,
    );
  reqs.forEach(({ mask, min, max }, at) => {
    const where = `${owner}, requirement ${at}`;
    checkMask(mask, classCount, where, 'fill a requirement');
    if (!isCount(min))
      throw new RangeError(`${where}: a lower bound is a whole number, not ${min}`);
    if (max === null) return;
    if (!isCount(max) || max < min)
      throw new RangeError(
        `${where}: a range is 0 <= min <= max in whole cards, not ${min} to ${max}`,
      );
    if (mask === 0)
      throw new RangeError(`${where}: a ceiling no class can reach binds nothing and is dropped`);
  });
  const expanded = reqs.flatMap(({ mask, min }) => new Array<number>(min).fill(mask));
  if (slotKey(expanded) !== slotKey(slots))
    throw new RangeError(
      `${owner}: \`slots\` must be the requirements' lower bounds expanded — ${expanded.length} slot(s) expected, ${slots.length} given`,
    );
}
