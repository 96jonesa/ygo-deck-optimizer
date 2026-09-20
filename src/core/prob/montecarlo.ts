import { createPrng, type Prng } from '../util/prng';
import { createProgressReporter, type OnProgress } from '../util/progress';

/**
 * The Monte Carlo oracle (TDD §10.4). It draws CONCRETE cards, each tagged
 * with the LINE it came from, and decides success by brute-force assignment
 * of drawn cards to requirements, reading the match matrix rows of lines. It
 * deliberately shares nothing with the exact engine — no classes, no masks,
 * no Hall's condition, no Hoffman conditions, no success set, no binomials —
 * so that the two can be held against each other.
 */

/** `n×` the description in column `desc` of the match matrix. */
export interface MatchCounted {
  n: number;
  desc: number;
}

/** A requirement: `n` cards at least, and — written `a-b×` — `max` at most. */
export interface MatchRange extends MatchCounted {
  max?: number;
}

/** What the oracle needs of a resolved template; `ResolvedTemplate` satisfies it. */
export interface MatchProblem {
  deckSize: number;
  /** `matrix[line][description]`: whether a card of the line matches. The LAST row is the remainder. */
  matrix: readonly (readonly boolean[])[];
  /** A hand succeeds if it meets ANY of these. */
  flat: readonly MatchFlat[];
}

/** One flat alternative, with the sixth card's own part when it is split. */
export interface MatchFlat {
  reqs: readonly MatchRange[];
  limits: readonly MatchCounted[];
  /**
   * The SIXTH CARD's part (PRD §5.6). Present: `reqs` and `limits` above are
   * about the cards you OPENED on — every position but the last — and this is
   * about the last one, which is the card `drawHand` drew last.
   */
  sixth?: { reqs: readonly MatchRange[]; limits: readonly MatchCounted[] };
}

export interface EstimateOptions {
  handSize: number;
  samples: number;
  /** Same seed, same hands, same `hits`. */
  seed: number;
  /** Called at most every 500 ms, and once more at the end with `done === total`. */
  onProgress?: OnProgress;
  /** The clock behind `onProgress`, in milliseconds; injected by tests. */
  now?: () => number;
}

export interface Estimate {
  hits: number;
  samples: number;
  /** `hits / samples`. */
  p: number;
  /** The binomial standard error of `p`, `sqrt(p (1 - p) / samples)`. */
  stderr: number;
  /** The 95% WILSON score interval — unlike the normal one it stays inside [0, 1] and is not empty at `p = 0`. */
  ci95: [number, number];
}

/** Samples between two looks at the clock. */
const CHUNK = 8192;

/** The two-sided 95% point of the standard normal distribution. */
const Z95 = 1.959963984540054;

/** The 95% Wilson score interval for `hits` successes in `samples` trials. */
export function wilson95(hits: number, samples: number): [number, number] {
  const p = hits / samples;
  const z2n = (Z95 * Z95) / samples;
  const centre = (p + z2n / 2) / (1 + z2n);
  const half = (Z95 * Math.sqrt((p * (1 - p)) / samples + z2n / (4 * samples))) / (1 + z2n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * The concrete deck: one entry per physical card, holding the index of its
 * line. `counts` has one entry per line EXCEPT the remainder, which gets
 * whatever is left of `deckSize` and is tagged with the last row's index.
 */
export function buildDeck(problem: MatchProblem, counts: readonly number[]): number[] {
  const remainderLine = problem.matrix.length - 1;
  if (counts.length !== remainderLine)
    throw new RangeError(
      `expected ${remainderLine} line counts (the remainder is computed), got ${counts.length}`,
    );
  const deck: number[] = [];
  counts.forEach((count, line) => {
    if (!Number.isInteger(count) || count < 0)
      throw new RangeError(`line ${line}: a count is a whole number of cards, not ${count}`);
    for (let copy = 0; copy < count; copy++) deck.push(line);
  });
  if (deck.length > problem.deckSize)
    throw new RangeError(
      `the lines hold ${deck.length} cards, more than the deck size of ${problem.deckSize}`,
    );
  while (deck.length < problem.deckSize) deck.push(remainderLine);
  return deck;
}

/**
 * Partial Fisher–Yates: permutes `cards` in place so that its first
 * `handSize` entries are a uniform sample WITHOUT replacement — position `i`
 * receives a uniform pick from positions `i` and later, itself included.
 */
export function drawHand(cards: Int32Array | number[], handSize: number, rng: Prng): void {
  for (let i = 0; i < handSize; i++) {
    const j = i + rng.nextInt(cards.length - i);
    const picked = cards[j]!;
    cards[j] = cards[i]!;
    cards[i] = picked;
  }
}

/** A criterion as the judge holds it: requirements with both bounds, and its limits. */
interface JudgedCriterion {
  reqs: { min: number; max: number; desc: number }[];
  /** `sum of the lower bounds`: fewer cards than this can never meet it. */
  needed: number;
  /** The descriptions of the requirements that HAVE a ceiling: a card matching one cannot be left over. */
  capped: number[];
  limits: readonly MatchCounted[];
}

/**
 * The hand judge for `problem`: whether the first `size` cards of `hand`
 * (line indices) meet ANY flat criterion, by the rules of `FlatCriterion` —
 * every limit holds over the WHOLE hand, and the drawn cards can be given to
 * the requirements so that each takes a count within its range and no card
 * matching a CAPPED requirement is left over.
 *
 * A SPLIT criterion reads the very same rules over two WINDOWS instead of one:
 * its own `reqs` and `limits` over positions `0 … size - 2`, the cards you
 * opened on, and its `sixth` part over position `size - 1` alone, the card
 * drawn. `drawHand` fills position `i` at step `i`, so the last position IS the
 * last card drawn, and conditional on the others it is uniform over what is
 * left — the oracle needs no new sampling, only a second window to judge.
 *
 * The assignment is searched exhaustively over concrete cards, one card at a
 * time: each is offered to every requirement that matches it and still has
 * room, and then to no requirement at all — which is only allowed when no
 * capped requirement would have had to count it. With at most six cards that
 * is instant, and it shares nothing with the exact matcher, which decides the
 * same question by counting classes against precomputed subset conditions.
 */
export function createJudge(
  problem: MatchProblem,
): (hand: ArrayLike<number>, size?: number) => boolean {
  const columns = problem.matrix[0]?.length ?? 0;
  /** `matches[description][line]`, so a requirement reads one row. */
  const matches = Array.from({ length: columns }, (_, desc) =>
    problem.matrix.map((row) => row[desc] === true),
  );
  const judged = ({ reqs, limits }: Omit<MatchFlat, 'sixth'>): JudgedCriterion => {
    const bounded = reqs.map(({ n, max, desc }) => ({
      min: n,
      max: max ?? Number.POSITIVE_INFINITY,
      desc,
    }));
    return {
      reqs: bounded,
      needed: bounded.reduce((sum, { min }) => sum + min, 0),
      capped: reqs.flatMap(({ max, desc }) => (max === undefined ? [] : [desc])),
      limits,
    };
  };
  const criteria = problem.flat.map((alternative) => ({
    /** The whole hand, or — when it is split — the cards opened on. */
    opening: judged(alternative),
    sixth: alternative.sixth === undefined ? null : judged(alternative.sixth),
  }));

  let hand: ArrayLike<number> = [];
  let size = 0;

  /** A census over the window `[from, to)` of the hand. */
  const withinLimits = (limits: readonly MatchCounted[], from: number, to: number): boolean => {
    for (const { n, desc } of limits) {
      const counted = matches[desc]!;
      let count = 0;
      for (let position = from; position < to; position++) if (counted[hand[position]!]) count++;
      if (count > n) return false;
    }
    return true;
  };

  const assigns = ({ reqs, capped }: JudgedCriterion, from: number, to: number): boolean => {
    const taken = reqs.map(() => 0);
    /** What the requirements still owe: the search gives up once the cards left cannot pay it. */
    let owed = reqs.reduce((sum, { min }) => sum + min, 0);
    const place = (position: number): boolean => {
      if (owed > to - position) return false;
      if (position === to) return true;
      const line = hand[position]!;
      for (let at = 0; at < reqs.length; at++) {
        const req = reqs[at]!;
        if (taken[at]! >= req.max || !matches[req.desc]![line]) continue;
        if (taken[at]! < req.min) owed--;
        taken[at]!++;
        const done = place(position + 1);
        taken[at]!--;
        if (taken[at]! < req.min) owed++;
        if (done) return true;
      }
      // Left over, which only a card no ceiling would have counted may be.
      return capped.every((desc) => !matches[desc]![line]) && place(position + 1);
    };
    return place(from);
  };

  /** Whether `criterion` holds over the window `[from, to)` of the hand. */
  const holds = (criterion: JudgedCriterion, from: number, to: number): boolean =>
    criterion.needed <= to - from &&
    withinLimits(criterion.limits, from, to) &&
    assigns(criterion, from, to);

  return (cards, cardCount = cards.length) => {
    hand = cards;
    size = cardCount;
    for (const { opening, sixth } of criteria) {
      if (sixth === null) {
        if (holds(opening, 0, size)) return true;
        continue;
      }
      // The card drawn is the last position; the cards opened on are the rest.
      if (size < 1) continue;
      if (holds(sixth, size - 1, size) && holds(opening, 0, size - 1)) return true;
    }
    return false;
  };
}

/**
 * Estimate the probability that an opening hand succeeds, by drawing
 * `samples` hands from the concrete deck `buildDeck(problem, counts)`. Every
 * hand is drawn from the deck in its built order, so the result is a function
 * of the arguments alone.
 */
export function estimate(
  problem: MatchProblem,
  counts: readonly number[],
  opts: EstimateOptions,
): Estimate {
  const { handSize, samples } = opts;
  if (!Number.isInteger(samples) || samples < 1)
    throw new RangeError(`samples must be a positive whole number, not ${samples}`);
  if (!Number.isInteger(handSize) || handSize < 1 || handSize > problem.deckSize)
    throw new RangeError(`hand size must be 1 to ${problem.deckSize}, not ${handSize}`);

  const deck = Int32Array.from(buildDeck(problem, counts));
  const cards = new Int32Array(deck.length);
  const judge = createJudge(problem);
  const rng = createPrng(opts.seed);
  const progress = createProgressReporter(
    samples,
    opts.onProgress,
    opts.now ? { now: opts.now } : {},
  );

  let hits = 0;
  for (let done = 0; done < samples; ) {
    const end = Math.min(samples, done + CHUNK);
    for (; done < end; done++) {
      cards.set(deck);
      drawHand(cards, handSize, rng);
      if (judge(cards, handSize)) hits++;
    }
    if (done < samples) progress.tick(done);
  }
  progress.finish();

  const p = hits / samples;
  return {
    hits,
    samples,
    p,
    stderr: Math.sqrt((p * (1 - p)) / samples),
    ci95: wilson95(hits, samples),
  };
}
