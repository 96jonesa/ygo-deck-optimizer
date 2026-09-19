import type { CompiledCriterion, CompiledRequirement, Problem } from '../../src/core/model/problem';
import type { MatchProblem } from '../../src/core/prob/montecarlo';

/**
 * A `MatchProblem` as the exact engine's `Problem`, WITHOUT class merging —
 * that is M1b's `compile`. It exists so the exact engine can be held against
 * the enumeration and Monte Carlo oracles before `compile` does.
 *
 * Every line is its own class, in order, from bit 1 up — a line whose row is
 * all-false included: it is NOT the blank class here, its bit simply appears
 * in no mask. Class 0, the blank class, is the remainder and nothing else.
 *
 * Except when the remainder fills a column (as it fills `1x card`): the blank
 * class may appear in no mask, so the remainder then becomes an ordinary class
 * of its own, the LAST one, and the blank class is left empty — no line, no
 * cards.
 */
export interface ClassProblem {
  problem: Problem;
  /** The matrix row whose cards make up each class; `null` for an empty blank class. */
  lineOfClass: (number | null)[];
  /** Class totals for these line counts, blank first, summing to the deck size. */
  totals(counts: readonly number[]): number[];
}

export function problemFromMatrix(match: MatchProblem, handSizes: readonly number[]): ClassProblem {
  const remainderLine = match.matrix.length - 1;
  const remainderIsBlank = match.matrix[remainderLine]!.every((fills) => !fills);

  const lineOfClass: (number | null)[] = [remainderIsBlank ? remainderLine : null];
  for (let line = 0; line < remainderLine; line++) lineOfClass.push(line);
  if (!remainderIsBlank) lineOfClass.push(remainderLine);

  const maskOf = (desc: number): number => {
    let mask = 0;
    lineOfClass.forEach((line, cls) => {
      if (line !== null && match.matrix[line]![desc] === true) mask |= 1 << cls;
    });
    return mask >>> 0;
  };

  const problem: Problem = {
    deckSize: match.deckSize,
    handSizes: handSizes.map((H) => ({ H, weight: 1 })),
    classes: lineOfClass.map((line) => ({
      lineIds: line === null ? [] : [line === remainderLine ? 'remainder' : `line${line}`],
      min: 0,
      max: line === null ? 0 : match.deckSize,
    })),
    criteria: match.flat.map(({ reqs, limits }): CompiledCriterion => {
      // Built here rather than by `compileCriterion`, so that a differential
      // test owes nothing to the code it is checking: a ceiling is kept exactly
      // as written, with none of compile's dropping.
      const compiled = reqs.map(
        ({ n, max, desc }): CompiledRequirement => ({
          mask: maskOf(desc),
          min: n,
          max: max ?? null,
        }),
      );
      const criterion: CompiledCriterion = {
        slots: compiled.flatMap(({ mask, min }) => new Array<number>(min).fill(mask)),
        limits: limits.map(({ n, desc }) => ({ mask: maskOf(desc), n })),
      };
      // `validateProblem` refuses a ceiling no class can reach, and a hand
      // never holds a card of such a class anyway: an unreachable ceiling is
      // the same as none.
      if (compiled.some(({ mask, max }) => max !== null && mask !== 0))
        criterion.reqs = compiled.map((req) => (req.mask === 0 ? { ...req, max: null } : req));
      return criterion;
    }),
  };

  const totals = (counts: readonly number[]): number[] => {
    if (counts.length !== remainderLine)
      throw new Error(`expected ${remainderLine} line counts, got ${counts.length}`);
    const remainder = match.deckSize - counts.reduce((sum, n) => sum + n, 0);
    if (remainder < 0) throw new Error('the lines overfill the deck');
    return lineOfClass.map((line) =>
      line === null ? 0 : line === remainderLine ? remainder : counts[line]!,
    );
  };

  return { problem, lineOfClass, totals };
}

/** A concrete hand, as matrix rows, holding `h[c]` cards of each class `c`; `null` when none exists. */
export function handOfComposition(
  { lineOfClass }: ClassProblem,
  h: ArrayLike<number>,
): number[] | null {
  const hand: number[] = [];
  for (let cls = 0; cls < lineOfClass.length; cls++) {
    const line = lineOfClass[cls]!;
    if (line === null && h[cls]! > 0) return null;
    for (let copy = 0; copy < h[cls]!; copy++) hand.push(line!);
  }
  return hand;
}
