import type { CompiledCriterion, DrawSpec, Problem } from '../../src/core/model/problem';

/**
 * Small draw-card problems, written by hand: `compileProblem` is tested on
 * templates, and these are for the engine underneath it, where saying which
 * class draws what is shorter than writing a template that makes it so.
 */
export interface DrawProblemSpec {
  /** One entry per class, class 0 the blank class: the copies the deck holds. */
  n: readonly number[];
  H: number;
  /** By class index. */
  draw?: Readonly<Record<number, DrawSpec>>;
  criteria: readonly CompiledCriterion[];
  /** Each class's `max`; the default is the deck's own counts, which is the tightest true one. */
  max?: readonly number[];
  /** The deck size; the default is what `n` holds. */
  deckSize?: number;
  /**
   * Whether the hand is dealt in two pieces — the cards opened on, then the
   * card drawn for turn and whatever follows it (`HandSize.drawn`). A criterion
   * with a `sixth` part needs it; `compileProblem` sets it for itself, and here
   * it is said outright.
   */
  drawn?: true;
}

/** The class bit of class `cls`, for writing masks. */
export const bit = (cls: number) => 1 << cls;

export function drawProblem({
  n,
  H,
  draw = {},
  criteria,
  max,
  deckSize,
  drawn,
}: DrawProblemSpec): Problem {
  return {
    deckSize: deckSize ?? n.reduce((sum, count) => sum + count, 0),
    handSizes: [drawn === true ? { H, weight: 1, drawn: true } : { H, weight: 1 }],
    classes: n.map((count, cls) => ({
      lineIds: [`c${cls}`],
      min: 0,
      max: max?.[cls] ?? count,
      ...(draw[cls] === undefined ? {} : { draw: draw[cls]! }),
    })),
    criteria: [...criteria],
  };
}

/** The same problem with its draw cards INERT: the number the tool reported before. */
export function withoutDraws(problem: Problem): Problem {
  return {
    ...problem,
    classes: problem.classes.map(({ draw: _drawn, ...rest }) => rest),
  };
}
