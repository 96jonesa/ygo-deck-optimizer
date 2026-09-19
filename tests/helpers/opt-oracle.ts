import type { CompileInput, CompileResult } from '../../src/core/model/compile';
import type { HandSize } from '../../src/core/model/problem';
import { createScorer } from '../../src/core/prob/scorer';
import type { RangedProblem } from './gen-ranged-problem';
import { rawRatiosOf } from './gen-ranged-problem';
import type { Rng } from './prng';
import { problemFromMatrix } from './problem-from-matrix';

// ---------------------------------------------------------------------------
// The optimizer's oracles (TDD §15.1): every class vector by plain nested
// listing, and every RAW RATIO of a small template scored one by one against
// the UNMERGED problem, ranked and compared as BigInt rationals. Nothing here
// knows about pruning, shards, heaps, side buffers or sweep tables.
// ---------------------------------------------------------------------------

export interface Range {
  min: number;
  max: number;
}

/**
 * Every vector with a total inside each range that fills the deck, blank
 * (index 0) included, in lexicographic order of the WHOLE vector. The only
 * bound it knows is that a deck cannot be overfilled.
 */
export function bruteVectors(classes: readonly Range[], deckSize: number): number[][] {
  const out: number[][] = [];
  const extend = (totals: number[], used: number): void => {
    if (totals.length === classes.length) {
      if (used === deckSize) out.push(totals);
      return;
    }
    const { min, max } = classes[totals.length]!;
    for (let t = min; t <= Math.min(max, deckSize - used); t++) extend([...totals, t], used + t);
  };
  extend([], 0);
  return out;
}

/** Range lists with the shapes the walk must survive: empty blank, maxima above the deck, no vector at all. */
export function genClassRanges(rng: Rng): { classes: Range[]; deckSize: number } {
  const deckSize = rng.int(0, 16);
  const classes = Array.from({ length: rng.int(1, 6) }, (_, cls) => {
    // An empty blank class, `[0, 0]`, as when the remainder fills a requirement.
    if (cls === 0 && rng.chance(0.3)) return { min: 0, max: 0 };
    const min = rng.pick([0, 0, 0, 1, 2, 4]);
    const max = rng.chance(0.3) ? deckSize + rng.int(0, 30) : min + rng.int(0, 6);
    // Now and then an empty range: nothing fills the deck.
    return rng.chance(0.03) ? { min: max + 1, max } : { min, max: Math.max(min, max) };
  });
  return { classes, deckSize };
}

/** An exact rational; `den > 0`. */
export interface Big {
  num: bigint;
  den: bigint;
}

export const compareBig = (a: Big, b: Big): number => {
  const lead = a.num * b.den - b.num * a.den;
  return lead > 0n ? 1 : lead < 0n ? -1 : 0;
};

export const subtractBig = (a: Big, b: Big): Big => ({
  num: a.num * b.den - b.num * a.den,
  den: a.den * b.den,
});

/** `Σ weight · num / den / Σ weight` over plain denominators' product — no gcd, no lcm. */
export function blendBig(parts: readonly { weight: number; num: number; den: number }[]): Big {
  const den = parts.reduce((product, part) => product * BigInt(part.den), 1n);
  const weight = parts.reduce((sum, part) => sum + BigInt(part.weight), 0n);
  const num = parts.reduce(
    (sum, part) => sum + BigInt(part.weight) * BigInt(part.num) * (den / BigInt(part.den)),
    0n,
  );
  return { num, den: den * weight };
}

export interface NaiveRatio {
  /** A count per line, the remainder's last. */
  counts: number[];
  /** The class vector `compileProblem`'s `classOfLine` maps it to, blank first. */
  classTotals: number[];
  score: Big;
  parts: { H: number; weight: number; num: number; den: number }[];
}

type Compiled = Extract<CompileResult, { ok: true }>;

/**
 * Every valid raw ratio of a ranged problem, scored by the UNMERGED problem —
 * each line its own class (`problem-from-matrix`) — at every hand size.
 */
export function naiveRatios(
  ranged: Pick<RangedProblem, 'generated' | 'ranges' | 'remainder'>,
  input: CompileInput,
  compiled: Compiled,
  handSizes: readonly HandSize[],
): NaiveRatio[] {
  const reference = problemFromMatrix(
    ranged.generated.problem,
    handSizes.map(({ H }) => H),
  );
  const scorers = handSizes.map(({ H }) => createScorer(reference.problem, H));
  return rawRatiosOf(ranged.ranges, ranged.remainder, input.deckSize).map((lineCounts) => {
    const left = input.deckSize - lineCounts.reduce((sum, n) => sum + n, 0);
    const counts = [...lineCounts, left];
    const classTotals = new Array<number>(compiled.classes.length).fill(0);
    counts.forEach((count, line) => {
      classTotals[compiled.classOfLine[line]!]! += count;
    });
    const totals = reference.totals(lineCounts);
    const parts = scorers.map((scorer, at) => ({
      H: scorer.H,
      weight: handSizes[at]!.weight,
      ...scorer.score(totals),
    }));
    return { counts, classTotals, score: blendBig(parts), parts };
  });
}

/** Lexicographic on the whole vector, blank first: the documented tie order. */
export function compareVectors(a: readonly number[], b: readonly number[]): number {
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return a[at]! - b[at]!;
  return 0;
}

export interface NaiveGroup {
  classTotals: number[];
  score: Big;
  parts: NaiveRatio['parts'];
  ratios: NaiveRatio[];
}

/** The naive ratios grouped by class vector and ranked: best score first, ties by `compareVectors`. */
export function naiveRanking(ratios: readonly NaiveRatio[]): NaiveGroup[] {
  const groups = new Map<string, NaiveGroup>();
  for (const ratio of ratios) {
    const key = ratio.classTotals.join(',');
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { ...ratio, ratios: [ratio] });
    else {
      // Merging must never change a score: every raw ratio behind a vector ties exactly.
      if (compareBig(group.score, ratio.score) !== 0)
        throw new Error(`raw ratios behind ${key} do not tie`);
      group.ratios.push(ratio);
    }
  }
  return [...groups.values()].sort(
    (a, b) => compareBig(b.score, a.score) || compareVectors(a.classTotals, b.classTotals),
  );
}

/** Every way to split `total` among lines within their ranges, by nested listing. */
export function splitsOf(lines: readonly Range[], total: number): number[][] {
  const out: number[][] = [];
  const extend = (counts: number[], used: number): void => {
    if (counts.length === lines.length) {
      if (used === total) out.push(counts);
      return;
    }
    const { min, max } = lines[counts.length]!;
    for (let n = min; n <= Math.min(max, total - used); n++) extend([...counts, n], used + n);
  };
  extend([], 0);
  return out;
}

/** The raw ratios — a count per line of `input`, the remainder's last — behind a class vector, as `a,b,c` keys. */
export function ratiosBehind(compiled: Compiled, classTotals: readonly number[]): Set<string> {
  let partial: number[][] = [new Array<number>(compiled.classOfLine.length).fill(0)];
  compiled.classes.forEach(({ lines }, cls) => {
    if (lines.length === 0) {
      if (classTotals[cls] !== 0) partial = [];
      return;
    }
    const splits = splitsOf(lines, classTotals[cls]!);
    partial = partial.flatMap((counts) =>
      splits.map((split) => {
        const next = [...counts];
        lines.forEach(({ line }, at) => {
          next[line] = split[at]!;
        });
        return next;
      }),
    );
  });
  return new Set(partial.map((counts) => counts.join(',')));
}
