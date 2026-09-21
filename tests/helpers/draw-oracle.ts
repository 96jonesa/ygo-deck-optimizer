import type { CompiledCriterion, DrawSpec, Problem } from '../../src/core/model/problem';
import { createPrng } from '../../src/core/util/prng';

/**
 * THE ORACLE for draw cards (TDD §10.4), and it deliberately shares NOTHING
 * with the exact route: no classes-as-compositions, no binomials, no masks as
 * precomputed subset conditions, no fixed point solved for, no cycle lemma and
 * no ordering factor. It shuffles CONCRETE cards, draws them one at a time,
 * resolves draw cards by walking the hand, and judges by exhaustive assignment.
 *
 * Two routes, and the difference matters:
 *
 * - `exhaustive` is CERTAIN. It walks every distinct class ORDER of the whole
 *   deck, each of which stands for the same number of physical shuffles, so
 *   plain counting is already uniform and the answer is the definition of the
 *   process summed. Only small decks, and no sampling error at all.
 * - `estimate` is Monte Carlo, for decks too large to walk. It draws from the
 *   engine's own `createPrng`, whose `nextInt` REJECTION-SAMPLES: a `random() %
 *   bound` is biased — 6% at `bound = 7` — and an oracle built on one disagrees
 *   with a correct engine at tens of sigma, looking exactly like a broken
 *   engine.
 */

/** A criterion as the oracle reads it: the compiled one, judged by hand. */
type OracleCriterion = Pick<
  CompiledCriterion,
  'limits' | 'reqs' | 'slots' | 'weight' | 'stop' | 'sixth' | 'whole'
>;

/** One window of a criterion: the whole hand, the cards opened on, or the drawn set. */
type Window = Pick<CompiledCriterion, 'limits' | 'reqs' | 'slots'>;

/**
 * What a criterion is read against. A plain list is ONE window — the hand — and
 * a criterion naming the drawn set cannot be read against it. The pair is the
 * hand split where the player stopped looking and started drawing: `opened` is
 * the cards dealt before that point and `drawn` is everything after it, the
 * card drawn for turn and whatever the draw cards fetched (PRD §5.6, §5.7).
 */
export type Windows = readonly number[] | { opened: readonly number[]; drawn: readonly number[] };

/** The requirements of a criterion with both bounds, as the assignment search wants them. */
interface Bounded {
  mask: number;
  min: number;
  max: number;
}

/**
 * Every requirement of a criterion, `slots` expanded back when it has no
 * `reqs` of its own — `slots` is the lower bounds repeated, and `reqs` is the
 * whole list, which is the one place the two readings meet.
 */
function requirementsOf({ slots, reqs }: Window): Bounded[] {
  if (reqs !== undefined)
    return reqs.map(({ mask, min, max }) => ({
      mask,
      min,
      max: max ?? Number.POSITIVE_INFINITY,
    }));
  const counts = new Map<number, number>();
  for (const mask of slots) counts.set(mask, (counts.get(mask) ?? 0) + 1);
  return [...counts].map(([mask, min]) => ({ mask, min, max: Number.POSITIVE_INFINITY }));
}

const accepts = (mask: number, cls: number) => ((mask >>> cls) & 1) === 1;

/**
 * Whether ONE window of concrete cards — a list of CLASSES — meets one window
 * of a criterion.
 *
 * Every card is offered to each requirement that accepts it and still has room,
 * and then to none at all — which only a card no CEILING would have counted may
 * be, since a ceiling is a census and cannot look away from a card it matches.
 * Limits are a census over the window.
 */
function meetsWindow(window: Window, hand: readonly number[]): boolean {
  for (const { mask, n } of window.limits) {
    let count = 0;
    for (const cls of hand) if (accepts(mask, cls)) count++;
    if (count > n) return false;
  }
  const reqs = requirementsOf(window);
  const capped = reqs.filter(({ max }) => max !== Number.POSITIVE_INFINITY);
  const taken = reqs.map(() => 0);
  const place = (at: number): boolean => {
    if (at === hand.length) return reqs.every((req, i) => taken[i]! >= req.min);
    const cls = hand[at]!;
    for (let i = 0; i < reqs.length; i++) {
      const req = reqs[i]!;
      if (taken[i]! >= req.max || !accepts(req.mask, cls)) continue;
      taken[i]!++;
      const done = place(at + 1);
      taken[i]!--;
      if (done) return true;
    }
    return capped.every((req) => !accepts(req.mask, cls)) && place(at + 1);
  };
  return place(0);
}

/**
 * What a hand is worth: the highest weight among the criteria it meets, and 0
 * when it meets none.
 *
 * A criterion naming the DRAWN SET (`sixth`) or the WHOLE HAND (`whole`, what
 * `finally` writes) is read over one window at a time — its own slots and limits
 * over what was opened on, its `sixth` over what was drawn, its `whole` over the
 * two together — and every other criterion over the two together. The windows
 * are disjoint, so "the two together" is simply their concatenation, which is
 * why one `whole` serves both readings.
 */
export function judge(criteria: readonly OracleCriterion[], hand: Windows): number {
  const split = Array.isArray(hand) ? null : (hand as { opened: number[]; drawn: number[] });
  const everything =
    split === null ? (hand as readonly number[]) : [...split.opened, ...split.drawn];
  let best = 0;
  for (const criterion of criteria) {
    const weight = criterion.weight ?? 1;
    if (weight <= best) continue;
    if (criterion.sixth === undefined && criterion.whole === undefined) {
      if (meetsWindow(criterion, everything)) best = weight;
      continue;
    }
    if (split === null)
      throw new RangeError(
        'this criterion reads the hand in windows, and it was given as one: pass `{ opened, drawn }`',
      );
    if (criterion.sixth !== undefined && !meetsWindow(criterion.sixth, split.drawn)) continue;
    if (criterion.whole !== undefined && !meetsWindow(criterion.whole, everything)) continue;
    if (meetsWindow(criterion, split.opened)) best = weight;
  }
  return best;
}

/** One deck as physical cards, each tagged with its class. */
export function buildDeck(n: readonly number[]): number[] {
  const deck: number[] = [];
  n.forEach((count, cls) => {
    for (let copy = 0; copy < count; copy++) deck.push(cls);
  });
  return deck;
}

/** One card still in hand: its class, and the position off the top it came from. */
export interface HeldCard {
  cls: number;
  /** Its index in the shuffled deck, which is what says which window it is in. */
  at: number;
}

export interface PlayedOut {
  /** The hand the player is left holding; `null` when the deck ran out. */
  hand: HeldCard[] | null;
  /** How many cards were seen: the prefix length. */
  prefix: number;
}

/**
 * Play out one shuffled deck: draw `H`, then keep resolving draw cards until
 * none is left that may be used. A resolved copy LEAVES the hand and is
 * replaced by `n` fresh cards off the top. This is the Kleene iteration itself
 * — nothing solves for a fixed point, so a multiset with two of them cannot
 * pick the wrong one.
 */
export function playOut(
  order: readonly number[],
  H: number,
  draw: readonly (DrawSpec | undefined)[],
): PlayedOut {
  const hand: HeldCard[] = [];
  let top = 0;
  const takeOne = (): boolean => {
    if (top >= order.length) return false;
    hand.push({ cls: order[top]!, at: top });
    top++;
    return true;
  };
  for (let i = 0; i < H; i++) if (!takeOne()) return { hand: null, prefix: top };
  const usedOnce = new Set<number>();
  for (;;) {
    const at = hand.findIndex(({ cls }) => {
      const spec = draw[cls];
      return spec !== undefined && !(spec.oncePerTurn === true && usedOnce.has(cls));
    });
    if (at < 0) break;
    const { cls } = hand[at]!;
    const spec = draw[cls]!;
    if (spec.oncePerTurn === true) usedOnce.add(cls);
    hand.splice(at, 1);
    for (let i = 0; i < spec.n; i++) if (!takeOne()) return { hand: null, prefix: top };
  }
  return { hand, prefix: top };
}

/**
 * What one deck ORDER is worth, played as a person would play it (PRD §5.7).
 * ONE decision point, taken before any card is drawn:
 *
 *     look at the opening H cards
 *       any `stop` criterion met?
 *         yes -> STOP. worth the best weight among ALL criteria the OPENING meets
 *         no  -> DRAW every draw card. worth the best weight among ALL criteria
 *                the POST-DRAW hand meets — 0 if drawing broke them
 *
 * Exactly one window is ever in play: no maximum over the two, and no falling
 * back on what the opening would have been worth. And the `stop` flag decides
 * the WINDOW only — every criterion is valued in whichever window is chosen.
 *
 * THE SPLIT (`then`) is read off POSITIONS, which is the whole of what makes
 * this an oracle for it: `opened` is what is left of positions 0…H−2 and
 * `drawn` is what is left of positions H−1…ℓ−1 — the card drawn for turn and
 * everything the draw cards fetched. "What is left" because a resolved copy
 * LEAVES the hand, out of whichever window it was dealt into. With no draw card
 * ℓ = H and the drawn set is the one card at position H−1, which is what `then`
 * meant before any of this.
 */
function worthOf(problem: Problem, H: number, order: readonly number[]): number {
  const draw = problem.classes.map(({ draw: spec }) => spec);
  const stopping = problem.criteria.filter(({ stop }) => stop === true);
  /** The opening, split where it always is: the cards opened on, then the card drawn for turn. */
  const opening = { opened: order.slice(0, H - 1), drawn: [order[H - 1]!] };
  if (stopping.length > 0 && judge(stopping, opening) > 0) return judge(problem.criteria, opening);
  const { hand } = playOut(order, H, draw);
  // A deck-out is a hand the model refuses to have: the engine rules the
  // template out before scoring it, and the oracle counts it as no success so
  // that a template which CAN deck out shows up as a disagreement.
  if (hand === null) return 0;
  return judge(problem.criteria, {
    opened: hand.filter(({ at }) => at < H - 1).map(({ cls }) => cls),
    drawn: hand.filter(({ at }) => at >= H - 1).map(({ cls }) => cls),
  });
}

export interface OracleResult {
  /** The expected weight per hand: the probability when nothing is weighted. */
  weight: number;
  /** P(at least one criterion). */
  p: number;
  /** Prefix length to its probability; the lengths the process actually reaches. */
  lengths: Map<number, number>;
  /** Orders in which the deck ran out. */
  deckOuts: number;
}

/**
 * CERTAIN: every distinct class order of the whole deck. Each stands for
 * `Π n_c!` physical shuffles — the SAME number for every one of them — so
 * counting orders is already counting shuffles uniformly.
 */
export function exhaustive(problem: Problem, n: readonly number[], H: number): OracleResult {
  const draw = problem.classes.map(({ draw: spec }) => spec);
  const size = n.reduce((sum, count) => sum + count, 0);
  const left = [...n];
  const order = new Array<number>(size);
  const lengths = new Map<number, number>();
  let total = 0;
  let hits = 0;
  let weighted = 0;
  let deckOuts = 0;
  const walk = (at: number): void => {
    if (at === size) {
      total++;
      const worth = worthOf(problem, H, order);
      if (worth > 0) hits++;
      weighted += worth;
      const { hand, prefix } = playOut(order, H, draw);
      if (hand === null) deckOuts++;
      else lengths.set(prefix, (lengths.get(prefix) ?? 0) + 1);
      return;
    }
    for (let cls = 0; cls < left.length; cls++) {
      if (left[cls]! === 0) continue;
      left[cls]!--;
      order[at] = cls;
      walk(at + 1);
      left[cls]!++;
    }
  };
  walk(0);
  return {
    weight: weighted / total,
    p: hits / total,
    lengths: new Map([...lengths].map(([at, count]) => [at, count / total])),
    deckOuts: deckOuts / total,
  };
}

export interface EstimateOptions {
  samples: number;
  seed?: number;
}

/** Monte Carlo, with the standard error of `p` beside it. */
export function estimate(
  problem: Problem,
  n: readonly number[],
  H: number,
  { samples, seed = 1 }: EstimateOptions,
): OracleResult & { stderr: number; samples: number } {
  const draw = problem.classes.map(({ draw: spec }) => spec);
  const deck = buildDeck(n);
  const order = [...deck];
  const rng = createPrng(seed);
  const lengths = new Map<number, number>();
  let hits = 0;
  let weighted = 0;
  let deckOuts = 0;
  for (let sample = 0; sample < samples; sample++) {
    for (let i = 0; i < deck.length; i++) order[i] = deck[i]!;
    for (let i = 0; i < order.length - 1; i++) {
      const j = i + rng.nextInt(order.length - i);
      const held = order[j]!;
      order[j] = order[i]!;
      order[i] = held;
    }
    const worth = worthOf(problem, H, order);
    if (worth > 0) hits++;
    weighted += worth;
    const { hand, prefix } = playOut(order, H, draw);
    if (hand === null) deckOuts++;
    else lengths.set(prefix, (lengths.get(prefix) ?? 0) + 1);
  }
  const p = hits / samples;
  return {
    weight: weighted / samples,
    p,
    lengths: new Map([...lengths].map(([at, count]) => [at, count / samples])),
    deckOuts: deckOuts / samples,
    stderr: Math.sqrt((p * (1 - p)) / samples),
    samples,
  };
}
