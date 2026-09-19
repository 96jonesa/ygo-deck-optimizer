import type { CompileInput } from '../../src/core/model/compile';
import { type Generated, type GenProblemOptions, genProblem, SMALL_PROBLEMS } from './gen-problem';
import type { Rng } from './prng';

// ---------------------------------------------------------------------------
// A generated match problem (gen-problem) with a copy RANGE on every line and
// on the remainder: a template as `compileProblem` sees it, small enough that
// every raw ratio can be listed.
// ---------------------------------------------------------------------------

export interface Range {
  min: number;
  max: number;
}

export interface RangedProblem {
  generated: Generated;
  /** What `compileProblem` is given: the lines in order, then the remainder. */
  input: CompileInput;
  /** The lines' ranges, in order; the remainder is not among them. */
  ranges: Range[];
  remainder: { min: number; max: number | null };
  /** What the generator made sure of, so a test can count its coverage. */
  features: {
    identicalRows: boolean;
    allFalseRow: boolean;
    remainderFills: boolean;
    emptyBlank: boolean;
  };
}

export const lineIdOf = (line: number): string => `line${line}`;

export function genRangedProblem(
  rng: Rng,
  options: GenProblemOptions = SMALL_PROBLEMS,
): RangedProblem {
  for (;;) {
    const generated = genProblem(rng, options);
    const { matrix, deckSize } = generated.problem;
    const rows = matrix as boolean[][];
    const lineCount = rows.length - 1;

    // Make the shapes that merging turns on common, not left to chance.
    if (lineCount >= 2 && rng.chance(0.4)) {
      const from = rng.int(0, lineCount - 1);
      const to = rng.int(0, lineCount - 1);
      if (from !== to) rows[to] = [...rows[from]!];
    }
    if (rng.chance(0.3)) rows[rng.int(0, lineCount - 1)]!.fill(false);

    const ranges = Array.from({ length: lineCount }, () => {
      const min = rng.int(0, 2);
      return { min, max: min + rng.int(0, 2) };
    });
    const remainderMin = rng.pick([0, 0, 0, 1, 3]);
    const remainder = {
      min: remainderMin,
      max: rng.chance(0.5) ? null : remainderMin + rng.int(2, deckSize),
    };
    // At least one valid raw ratio, or there is nothing to hold the engine against.
    const least = ranges.reduce((sum, { min }) => sum + min, 0) + remainder.min;
    const most =
      ranges.reduce((sum, { max }) => sum + max, 0) +
      (remainder.max === null ? deckSize : remainder.max);
    if (least > deckSize || most < deckSize) continue;

    const key = (row: readonly boolean[]) => row.map((fills) => (fills ? '1' : '0')).join('');
    const lineKeys = rows.slice(0, lineCount).map(key);
    const remainderFills = rows[lineCount]!.some((fills) => fills);
    const allFalseRow = lineKeys.some((k) => !k.includes('1'));
    const input: CompileInput = {
      deckSize,
      handSize: generated.handSize,
      lines: [
        ...ranges.map(({ min, max }, line) => ({
          id: lineIdOf(line),
          isRemainder: false,
          min,
          max,
        })),
        { id: 'remainder', isRemainder: true, ...remainder },
      ],
      matrix: rows,
      flat: generated.problem.flat,
    };
    return {
      generated,
      input,
      ranges,
      remainder,
      features: {
        identicalRows: new Set([...lineKeys, key(rows[lineCount]!)]).size < lineCount + 1,
        allFalseRow,
        remainderFills,
        emptyBlank: remainderFills && !allFalseRow,
      },
    };
  }
}

/**
 * Every valid raw ratio — a count for each line within its range, leaving a
 * remainder within its own — by plain nested listing. The remainder is not in
 * the returned counts: it is whatever is left of the deck.
 */
export function rawRatiosOf(
  ranges: readonly Range[],
  remainder: { min: number; max: number | null },
  deckSize: number,
): number[][] {
  const out: number[][] = [];
  const extend = (counts: number[], used: number): void => {
    if (counts.length === ranges.length) {
      const left = deckSize - used;
      if (left >= remainder.min && (remainder.max === null || left <= remainder.max))
        out.push(counts);
      return;
    }
    const { min, max } = ranges[counts.length]!;
    for (let n = min; n <= max; n++) extend([...counts, n], used + n);
  };
  extend([], 0);
  return out;
}
