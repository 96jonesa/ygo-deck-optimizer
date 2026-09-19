import type { CostModel } from '../core/model/analyze';
import { expandClassVector } from '../core/model/compile';
import { calibrateCost } from '../core/opt/calibrate';
import { breakdown, type Compiled, exampleRatio, optimize } from '../core/opt/optimizer';
import type {
  LineRatio,
  RunExtras,
  RunLine,
  RunRequest,
  WorkerMessage,
  WorkerResult,
} from './protocol';

// The optimizer worker minus the thread (TDD §3): what a message does, over
// an injected `post`, so the whole protocol runs under vitest on the calling
// thread. Imports `core/` only — no Node, no sql.js, no card data: a run
// arrives compiled, as plain numbers.

export interface WorkerSessionOptions {
  /** What a score costs on this machine; injected by tests. Default: `calibrateCost`, some 40 ms. */
  calibrate?: () => CostModel;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunRequest(message: unknown): message is RunRequest {
  return (
    isObject(message) &&
    message.type === 'run' &&
    typeof message.runId === 'number' &&
    isObject(message.compiled) &&
    Array.isArray(message.criteria) &&
    isObject(message.options) &&
    message.cancelFlag instanceof SharedArrayBuffer &&
    message.cancelFlag.byteLength >= Int32Array.BYTES_PER_ELEMENT
  );
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The lines by line index: template order, the remainder last. `label` starts
 * as the id — the worker has no card data to name a line with, and main
 * replaces it on the way out — so it is the fallback rather than a blank.
 */
function linesOf({ classes, classOfLine }: Compiled): RunLine[] {
  const lines = new Array<RunLine>(classOfLine.length);
  classes.forEach((info, cls) => {
    for (const { id, line, min, max } of info.lines) lines[line] = { id, label: id, cls, min, max };
  });
  return lines;
}

export class WorkerSession {
  private cost: CostModel | undefined;

  constructor(
    private readonly post: (message: WorkerMessage) => void,
    private readonly opts: WorkerSessionOptions = {},
  ) {}

  /**
   * Call once, when the thread starts: time the scorer (TDD §11.3) and say
   * so. Every run of this session is then estimated at that cost — a warm
   * worker calibrates once, not per run.
   */
  start(): void {
    const calibrate = this.opts.calibrate ?? (() => calibrateCost().cost);
    this.cost = calibrate();
    this.post({ type: 'ready', cost: this.cost });
  }

  /**
   * One message from main. Never throws: `optimize` reports its own failures
   * as a result, and whatever else goes wrong is posted as an `error` under
   * the run's id.
   *
   * Synchronous, like `optimize`: no message is received while a search
   * runs, so a graceful stop comes in through the run's cancel flag, read at
   * the progress cadence. A `needs-confirmation` result is simply posted; the
   * session then waits like any idle worker, and the run goes ahead when main
   * sends it again with `force`.
   */
  handle(message: unknown): void {
    if (!isRunRequest(message)) {
      const runId = isObject(message) && typeof message.runId === 'number' ? message.runId : -1;
      this.post({ type: 'error', runId, message: 'not a run request' });
      return;
    }
    const { runId, compiled, criteria, options } = message;
    try {
      const flag = new Int32Array(message.cancelFlag);
      const result = optimize(compiled, {
        ...options,
        ...(this.cost === undefined ? {} : { cost: this.cost }),
        onProgress: (progress) => this.post({ type: 'progress', runId, progress }),
        shouldCancel: () => Atomics.load(flag, 0) === 1,
      });
      const shown: WorkerResult =
        result.status === 'done' || result.status === 'cancelled'
          ? { ...result, ...extrasOf(compiled, criteria, result) }
          : result;
      this.post({ type: 'result', runId, result: shown });
    } catch (failure) {
      this.post({ type: 'error', runId, message: messageOf(failure) });
    }
  }
}

/** What the renderer cannot work out for itself, having no core code: the vectors in lines, the best by criterion. */
function extrasOf(
  compiled: Compiled,
  criteria: RunRequest['criteria'],
  result: { best: { classTotals: number[] }; ranked: { classTotals: number[] }[] },
): RunExtras {
  const inLines = ({ classTotals }: { classTotals: number[] }): LineRatio => ({
    example: exampleRatio(compiled, classTotals),
    classes: expandClassVector(compiled.classes, classTotals),
  });
  return {
    lines: linesOf(compiled),
    breakdown: breakdown(compiled, criteria, result.best.classTotals),
    bestRatio: inLines(result.best),
    rankedRatios: result.ranked.map(inLines),
  };
}
