import type { CostModel } from '../core/model/analyze';
import type { ExpandedClass } from '../core/model/compile';
import type {
  BreakdownCriterion,
  Compiled,
  CriterionScore,
  OptimizeOptions,
  OptimizeProgress,
  OptimizeResult,
} from '../core/opt/optimizer';

// What main and the optimizer worker say to each other (TDD §3). Types only:
// main imports this file for its types and nothing of it reaches a bundle.
// Every message is plain data — the one exception being the cancel flag, a
// `SharedArrayBuffer`, which is shared rather than copied, and is the point.

/** The options of `optimize` that are plain data; the callbacks and the cost are the worker's own. */
export type WorkerRunOptions = Pick<
  OptimizeOptions,
  | 'topK'
  | 'plateauDelta'
  | 'plateauCap'
  | 'force'
  | 'confirmThresholdMs'
  | 'progressIntervalMs'
  | 'checkEvery'
>;

/**
 * One search. A run that came back `needs-confirmation` is confirmed by
 * sending it again with `options.force`: the worker keeps nothing between
 * messages but its calibrated cost.
 */
export interface RunRequest {
  type: 'run';
  runId: number;
  /** `compileProblem`'s output: plain numbers, no card data. */
  compiled: Compiled;
  /** The template's criteria, for the per-criterion breakdown of the best ratio. */
  criteria: BreakdownCriterion[];
  options: WorkerRunOptions;
  /**
   * Four bytes read as one `Int32`: main stores 1 to stop the run gracefully.
   * `optimize` is synchronous and cannot receive a message mid-run, so this is
   * the only way in (TDD §3).
   */
  cancelFlag: SharedArrayBuffer;
}

export type WorkerRequest = RunRequest;

/** A line of the template as the search saw it: template order, the remainder last. */
export interface RunLine {
  id: string;
  /** Its class: the index into a vector's `classTotals`. Class 0 is the blank class. */
  cls: number;
  min: number;
  max: number;
}

/** A class vector in LINES: the renderer has no core code to expand one with. */
export interface LineRatio {
  /** ONE concrete deck behind the vector (`exampleRatio`): a count per entry of `RunExtras.lines`. */
  example: number[];
  /** Class by class (`expandClassVector`): each member line's interval, and the sentence that says it. */
  classes: ExpandedClass[];
}

/** What the worker adds to a search that scored something, for display. */
export interface RunExtras {
  lines: RunLine[];
  /** The best vector, criterion by criterion (`breakdown`). */
  breakdown: CriterionScore[];
  bestRatio: LineRatio;
  /** Parallel to `ranked`. */
  rankedRatios: LineRatio[];
}

type Scored = Extract<OptimizeResult, { status: 'done' | 'cancelled' }>;

export type WorkerResult =
  | (Scored & RunExtras)
  | Exclude<OptimizeResult, { status: 'done' | 'cancelled' }>;

export type WorkerMessage =
  /** Once, at startup, when the scorer has been calibrated (TDD §11.3). */
  | { type: 'ready'; cost: CostModel }
  | { type: 'progress'; runId: number; progress: OptimizeProgress }
  | { type: 'result'; runId: number; result: WorkerResult }
  /** What went wrong outside `optimize`, which itself never throws; -1 when the message named no run. */
  | { type: 'error'; runId: number; message: string };
