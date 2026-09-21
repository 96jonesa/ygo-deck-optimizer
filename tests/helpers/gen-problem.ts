import type { Expr, FlatCriterion } from '../../src/core/criteria/ast';
import { expandAll } from '../../src/core/criteria/expand';
import type { Description } from '../../src/core/desc/ast';
import type { MatchFlat, MatchProblem } from '../../src/core/prob/montecarlo';
import type { Fills } from './criteria-oracle';
import { genExpr } from './gen-criteria';
import { type Rng, seededRng } from './prng';

// ---------------------------------------------------------------------------
// Generated match problems, shared by the Monte Carlo oracle's tests and the
// exact engine's: the matrix is random, descriptions are opaque (`#i` is
// column `i`), and criteria come from the criterion generator.
// ---------------------------------------------------------------------------

export function column(i: number): Description {
  return { anyOf: [{ t: 'card', passcode: i }] };
}

export function columnOf(desc: Description): number {
  const [alt] = desc.anyOf;
  if (desc.anyOf.length !== 1 || alt?.t !== 'card') throw new Error('not a generated description');
  return alt.passcode;
}

export interface Generated {
  problem: MatchProblem;
  /** Copies of each line; the remainder is whatever is left of the deck. */
  counts: number[];
  handSize: number;
  /** The criteria as written, and as `expandAll` flattened them: two routes to the same meaning. */
  exprs: Expr[];
  flat: FlatCriterion[];
}

/** Inclusive ranges. The defaults are small enough that every hand of the deck can be listed. */
export interface GenProblemOptions {
  lines: readonly [number, number];
  columns: readonly [number, number];
  deckSize: readonly [number, number];
  handSize: readonly [number, number];
  copies: readonly [number, number];
  /** How often a line fills a column. */
  fill: number;
  /** How often a requirement is a range, `a-b×`; 0 leaves the criteria as they were. */
  rangeChance?: number;
  /** How often a criterion is SPLIT across the cards opened on and the one drawn. */
  splitChance?: number;
  /** How often a criterion gets a `finally` part, over the WHOLE hand (PRD §5.5). */
  wholeChance?: number;
}

export const SMALL_PROBLEMS: GenProblemOptions = {
  lines: [3, 5],
  columns: [3, 5],
  deckSize: [10, 14],
  handSize: [3, 4],
  copies: [1, 3],
  fill: 0.4,
};

/** `SMALL_PROBLEMS`, with a range requirement in roughly half the leaves. */
export const RANGED_PROBLEMS: GenProblemOptions = { ...SMALL_PROBLEMS, rangeChance: 0.5 };

/**
 * `SMALL_PROBLEMS` where half the criteria name the card drawn. The hand runs
 * from 3 to 4 as it always did, so the five-card part is judged over 2 or 3
 * cards — small enough that every (opening, drawn) outcome of the deck can be
 * listed, which is what the split is checked against.
 */
export const SPLIT_PROBLEMS: GenProblemOptions = { ...SMALL_PROBLEMS, splitChance: 0.5 };

/**
 * `SPLIT_PROBLEMS` with `finally` parts throughout: half the criteria split at
 * `then` and half of ALL of them ask something of the whole hand as well. It is
 * the family that reaches every shape the grammar allows — `five then sixth
 * finally whole`, `five finally whole`, `then sixth finally whole` and `finally
 * whole` — which is exactly the set a `sixth !== undefined` test somewhere
 * downstream would get wrong.
 */
export const FINALLY_PROBLEMS: GenProblemOptions = {
  ...SMALL_PROBLEMS,
  splitChance: 0.5,
  wholeChance: 0.5,
};

export function genProblem(rng: Rng, options: GenProblemOptions = SMALL_PROBLEMS): Generated {
  for (;;) {
    const lineCount = rng.int(...options.lines);
    const columns = rng.int(...options.columns);
    const deckSize = rng.int(...options.deckSize);
    const handSize = rng.int(...options.handSize);
    const counts = Array.from({ length: lineCount }, () => rng.int(...options.copies));
    if (counts.reduce((sum, n) => sum + n, 0) > deckSize) continue;

    const matrix = counts.map(() =>
      Array.from({ length: columns }, () => rng.chance(options.fill)),
    );
    // The remainder fills nothing — except, in some problems, a column that
    // everything fills, as `1x card` would be.
    const remainder = new Array<boolean>(columns).fill(false);
    if (rng.chance(0.25)) {
      const universe = rng.int(0, columns - 1);
      for (const row of matrix) row[universe] = true;
      remainder[universe] = true;
    }
    matrix.push(remainder);

    const exprs = Array.from({ length: rng.int(1, 2) }, () =>
      genExpr(rng, {
        desc: (r) => column(r.int(0, columns - 1)),
        maxDepth: 2,
        maxArgs: 3,
        limitChance: 0.25,
        ...(options.rangeChance === undefined ? {} : { rangeChance: options.rangeChance }),
        ...(options.splitChance === undefined ? {} : { splitChance: options.splitChance }),
        ...(options.wholeChance === undefined ? {} : { wholeChance: options.wholeChance }),
      }),
    );
    const expanded = expandAll(exprs, { maxHandSize: handSize });
    if (!expanded.ok) continue;
    const side = ({ reqs, limits }: Pick<FlatCriterion, 'reqs' | 'limits'>) => ({
      reqs: reqs.map(({ n, max, desc }) => {
        const at = columnOf(desc);
        return max === undefined ? { n, desc: at } : { n, max, desc: at };
      }),
      limits: limits.map(({ n, desc }) => ({ n, desc: columnOf(desc) })),
    });
    const flat = expanded.flat.map((alternative) => {
      const out: MatchFlat = side(alternative);
      if (alternative.sixth !== undefined) out.sixth = side(alternative.sixth);
      if (alternative.whole !== undefined) out.whole = side(alternative.whole);
      return out;
    });
    return {
      problem: { deckSize, matrix, flat },
      counts,
      handSize,
      exprs,
      flat: expanded.flat,
    };
  }
}

/** The relation the oracles judge by: the match matrix row of the card's line. */
export function fillsOf(problem: MatchProblem): Fills<number> {
  return (line, desc) => problem.matrix[line]![columnOf(desc)] === true;
}

/**
 * The concrete deck, one line index per physical card, the remainder last —
 * built here rather than by the Monte Carlo module's `buildDeck`, so that an
 * enumeration oracle owes nothing to either engine.
 */
export function deckOf(problem: MatchProblem, counts: readonly number[]): number[] {
  const remainderLine = problem.matrix.length - 1;
  const deck = counts.flatMap((count, line) => new Array<number>(count).fill(line));
  if (deck.length > problem.deckSize) throw new Error('the lines overfill the deck');
  while (deck.length < problem.deckSize) deck.push(remainderLine);
  return deck;
}

/**
 * The small problems the exact engine's oracles share (S2, S3, S5): the scorer
 * is held against every hand of their decks, and the matcher against every
 * composition of their classes.
 */
export const SMALL_PROBLEM_COUNT = 240;

export function smallProblems(): Generated[] {
  return Array.from({ length: SMALL_PROBLEM_COUNT }, (_, i) => genProblem(seededRng(31_000 + i)));
}

/**
 * The same, with RANGE requirements throughout: a second family for the same
 * oracles, so that the rule ranges add is held to the same standard. A
 * different seed base, so the two families are not the same problems twice.
 */
export function smallRangedProblems(): Generated[] {
  return Array.from({ length: SMALL_PROBLEM_COUNT }, (_, i) =>
    genProblem(seededRng(57_000 + i), RANGED_PROBLEMS),
  );
}

/** Whether any alternative of `generated` holds a requirement with a ceiling. */
export function hasRange({ flat }: Generated): boolean {
  return flat.some(({ reqs }) => reqs.some(({ max }) => max !== undefined));
}

/**
 * Whether any alternative of `generated` reads the hand in more than one
 * WINDOW — naming the card drawn, or the whole hand beside the first five. It is
 * what decides whether the hand is dealt in two pieces, and so whether an
 * enumeration of outcomes and the scorer's own denominator agree without a
 * factor of `H` between them.
 */
export function hasSplit({ flat }: Generated): boolean {
  return flat.some(({ sixth, whole }) => sixth !== undefined || whole !== undefined);
}

/** Whether any alternative of `generated` asks something of the whole hand (`finally`). */
export function hasFinally({ flat }: Generated): boolean {
  return flat.some(({ whole }) => whole !== undefined);
}

/**
 * A third family for the same oracles, where half the criteria name the card
 * drawn: `drawn` hands, ordered outcomes, and — deliberately — unsplit criteria
 * beside split ones in the same problem, since a run that mixes them is the one
 * a sum of separate probabilities would get wrong.
 */
export function smallSplitProblems(): Generated[] {
  return Array.from({ length: SMALL_PROBLEM_COUNT }, (_, i) =>
    genProblem(seededRng(83_000 + i), SPLIT_PROBLEMS),
  );
}

/**
 * A fourth family, where half the criteria also ask something of the WHOLE HAND
 * (`finally`, PRD §5.5). The same oracles judge it: a hand of 3 or 4 is small
 * enough that every (opening, drawn) outcome of the deck can be listed, and the
 * three windows are then read straight off the positions.
 */
export function smallFinallyProblems(): Generated[] {
  return Array.from({ length: SMALL_PROBLEM_COUNT }, (_, i) =>
    genProblem(seededRng(109_000 + i), FINALLY_PROBLEMS),
  );
}
