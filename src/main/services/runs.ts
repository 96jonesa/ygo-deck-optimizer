import type { CostModel } from '../../core/model/analyze';
import type { Rational } from '../../core/opt/optimizer';
import {
  type InvalidRequest,
  RUN_PLATEAU_CAP_DEFAULT,
  RUN_PLATEAU_CAP_MAX,
  RUN_TOP_K_DEFAULT,
  RUN_TOP_K_MAX,
  type RunControlResult,
  type RunEvent,
  type RunResult,
  type RunStartResult,
} from '../../shared/types';
import type {
  RunRequest,
  WorkerMessage,
  WorkerRequest,
  WorkerResult,
  WorkerRunOptions,
} from '../../worker/protocol';

/** A search that scored something: the only worker results that carry lines. */
type Scored = Extract<WorkerResult, { status: 'done' | 'cancelled' }>;

import type { CompileTemplateResult } from './templates';

// The optimizer worker's host (TDD §3): one run at a time, on one warm
// thread. Node-free and Electron-free — the thread comes in as `spawn`, the
// way out as `emit` — so every race below is staged in a test with a worker
// the test plays.

/** The slice of a `worker_threads` `Worker` used here; a `Worker` satisfies it. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  on(event: 'message', listener: (message: WorkerMessage) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): unknown;
}

export interface RunServiceDeps {
  /** `TemplateService` satisfies it: everything that needs the card index happens behind this. */
  templates: { compileTemplate(template: unknown): CompileTemplateResult };
  /** A new optimizer thread. Called lazily: on the first run, and on the first run after a terminate. */
  spawn(): WorkerLike;
  /** Where the `RunEvent`s go: to every window. */
  emit(event: RunEvent): void;
  /** The `plateauDelta` setting, a probability: the plateau's width for a run that names none. */
  plateauDelta?(): number;
}

/** How long a graceful stop may take before the run is abandoned instead: the flag is read every ~100 ms. */
export const GRACEFUL_TIMEOUT_MS = 5000;

interface ActiveRun {
  runId: number;
  /** What the worker was sent — and is sent again, with `force`, on confirmation. */
  request: RunRequest;
  /** What each line of THIS run is called, by id: the template it was compiled from (`lineLabels`). */
  labels: Record<string, string>;
  /** What the run's criteria limited, and what the engine dropped: PRD §6.3's footnote, pinned to this run. */
  criterionLimits: RunResult['criterionLimits'];
  droppedLimits: RunResult['droppedLimits'];
  /** `waiting`: the worker answered `needs-confirmation` and is idle. */
  phase: 'running' | 'waiting';
  limits: RunResult['limits'];
  /** Settles when the run has ended, however it ended. */
  ended: Promise<void>;
  end(): void;
  deadline?: ReturnType<typeof setTimeout>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * The worker's result as the renderer receives it: the caps it ran under, and
 * the NAME of every line put back on. The worker is given no card data (TDD
 * §3), so it can only echo the ids; main compiled the template and kept what
 * each line is called, and a result therefore carries the names it was
 * produced with rather than whatever the editor says by the time it is read.
 * A line main has no label for keeps its id, so a label is never blank.
 *
 * The same goes for what the criteria LIMITED: PRD §6.3's footnote qualifies
 * a number, so it travels with that number instead of being looked up against
 * whatever is in the editor when someone reads it.
 */
function decorate(result: Scored, run: ActiveRun): RunResult {
  return {
    ...result,
    limits: run.limits,
    criterionLimits: run.criterionLimits,
    droppedLimits: run.droppedLimits,
    lines: result.lines.map((line) => ({ ...line, label: run.labels[line.id] ?? line.id })),
  };
}

/** A probability as an exact fraction, to six decimals: `0.005` is 1/200. */
function rationalOf(probability: number): Rational {
  const den = 1_000_000;
  const num = Math.round(Math.min(Math.max(probability, 0), 1) * den);
  const shared = gcd(num, den);
  return { num: num / shared, den: den / shared };
}

/**
 * The renderer's options, checked — they cross IPC, so they are anything —
 * and cut down to what it may set: every key is read by name, and the caps
 * are clamped to what a result can carry back over IPC.
 */
function readOptions(
  value: unknown,
  plateauDelta: Rational | undefined,
): { ok: true; options: WorkerRunOptions } | InvalidRequest {
  if (value !== undefined && !isObject(value))
    return {
      ok: false,
      reason: 'invalid',
      message: 'the run options are malformed',
      errors: ['`options` must be an object'],
    };
  const given = value ?? {};
  const errors: string[] = [];
  const whole = (name: 'topK' | 'plateauCap', fallback: number, most: number): number => {
    const n = given[name];
    if (n === undefined) return fallback;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      errors.push(`\`${name}\` must be a positive whole number`);
      return fallback;
    }
    return Math.min(n, most);
  };
  const options: WorkerRunOptions = {
    topK: whole('topK', RUN_TOP_K_DEFAULT, RUN_TOP_K_MAX),
    plateauCap: whole('plateauCap', RUN_PLATEAU_CAP_DEFAULT, RUN_PLATEAU_CAP_MAX),
  };

  const delta = given.plateauDelta;
  if (delta === undefined) {
    if (plateauDelta !== undefined) options.plateauDelta = plateauDelta;
  } else if (
    isObject(delta) &&
    Number.isSafeInteger(delta.num) &&
    Number.isSafeInteger(delta.den) &&
    (delta.num as number) >= 0 &&
    (delta.den as number) >= 1
  ) {
    options.plateauDelta = { num: delta.num as number, den: delta.den as number };
  } else errors.push('`plateauDelta` must be { num, den }: whole numbers, num >= 0 and den >= 1');

  for (const name of ['confirmThresholdMs', 'progressIntervalMs'] as const) {
    const ms = given[name];
    if (ms === undefined) continue;
    if (typeof ms === 'number' && ms >= 0) options[name] = ms;
    else errors.push(`\`${name}\` must be a time in milliseconds`);
  }
  if (given.force !== undefined) {
    if (typeof given.force === 'boolean') options.force = given.force;
    else errors.push('`force` must be true or false');
  }
  if (errors.length > 0)
    return { ok: false, reason: 'invalid', message: 'the run options are malformed', errors };
  return { ok: true, options };
}

/**
 * Runs the optimizer, ONE run at a time, and says what happens as `RunEvent`s.
 *
 * A RUN is `started`, reports `progress`, may stop once at
 * `needs-confirmation` (the wall, TDD §11.3) until `confirm`, and ends in
 * exactly one of `result`, `cancelled` or `error`. Starting a run cancels the
 * one before it. Every event carries its `runId`, and an event of any run but
 * the active one — a superseded run's last words, a terminated thread's
 * backlog — is dropped, never forwarded.
 *
 * The WORKER is kept warm across runs, so the scorer is calibrated once, not
 * per run: it is spawned lazily by the first run and replaced only after it
 * was terminated or died. Abandoning a run costs the thread — `optimize` is
 * synchronous and hears nothing mid-run — while a GRACEFUL stop does not: it
 * raises the run's cancel flag, shared memory the search reads at the
 * progress cadence, and the search returns what it has.
 *
 * A CARD RELOAD mid-run does not disturb the run: everything that needs the
 * card index happens in `start`, synchronously, and what the worker holds is
 * the compiled problem — plain numbers. Only the next `start` sees new cards.
 */
export class RunService {
  private worker: WorkerLike | null = null;
  private active: ActiveRun | null = null;
  private calibrated: CostModel | undefined;
  private lastRunId = 0;

  constructor(private readonly deps: RunServiceDeps) {}

  /**
   * What a score costs on this machine, once a worker has calibrated (TDD
   * §11.3) — `undefined` until the first run has spawned one. It outlives
   * the worker: the machine has not changed.
   */
  cost(): CostModel | undefined {
    return this.calibrated;
  }

  /**
   * Validate, analyze and compile `template` — here in main, where the cards
   * are — and start searching it, cancelling any run before it. Nothing is
   * started, and the run before is left alone, unless this comes back `ok`.
   */
  start(template: unknown, options?: unknown): RunStartResult {
    const compiled = this.deps.templates.compileTemplate(template);
    if (!compiled.ok) return compiled;
    const delta = this.deps.plateauDelta?.();
    const read = readOptions(options, delta === undefined ? undefined : rationalOf(delta));
    if (!read.ok) return read;

    if (this.active !== null) this.abandon(this.active);

    const runId = ++this.lastRunId;
    const request: RunRequest = {
      type: 'run',
      runId,
      compiled: compiled.compiled,
      criteria: compiled.criteria,
      options: read.options,
      // A flag of its own for every run: a stop of the last run cannot stop this one.
      cancelFlag: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    };
    let end = () => {};
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    this.active = {
      runId,
      request,
      phase: 'running',
      labels: compiled.labels,
      criterionLimits: compiled.criterionLimits,
      droppedLimits: compiled.droppedLimits,
      limits: {
        topK: read.options.topK ?? RUN_TOP_K_DEFAULT,
        plateauCap: read.options.plateauCap ?? RUN_PLATEAU_CAP_DEFAULT,
      },
      ended,
      end,
    };
    const { classVectors, estimatedMs } = compiled.analysis.work;
    this.deps.emit({ runId, type: 'started', total: classVectors, estimatedMs });
    // A thread that is still calibrating keeps the request in its port.
    this.ensureWorker().postMessage(request);
    return { ok: true, runId };
  }

  /**
   * Stop the run. GRACEFUL: raise its flag and wait — the search stops at its
   * next progress report, and what it had scored arrives as the `cancelled`
   * event's `result` (or as a plain `result`, if it finished first); a worker
   * that has not stopped by `GRACEFUL_TIMEOUT_MS` is abandoned after all.
   * Otherwise ABANDON it: terminate the thread and say `cancelled` here.
   * Settles when the run has ended.
   */
  async cancel(runId: unknown, opts: { graceful?: boolean } = {}): Promise<RunControlResult> {
    if (typeof runId !== 'number') return { ok: false, reason: 'invalid' };
    const run = this.active;
    if (run === null || run.runId !== runId) return { ok: false, reason: 'not-active' };
    if (opts.graceful !== true || run.phase === 'waiting') {
      this.abandon(run);
      return { ok: true };
    }
    Atomics.store(new Int32Array(run.request.cancelFlag), 0, 1);
    // `finish` clears it, so it fires only on a run that is still active.
    run.deadline ??= setTimeout(() => this.abandon(run), GRACEFUL_TIMEOUT_MS);
    await run.ended;
    return { ok: true };
  }

  /** The user's yes to a `needs-confirmation`: the same run, sent again with `force`. */
  confirm(runId: unknown): RunControlResult {
    if (typeof runId !== 'number') return { ok: false, reason: 'invalid' };
    const run = this.active;
    if (run === null || run.runId !== runId || run.phase !== 'waiting')
      return { ok: false, reason: 'not-active' };
    run.phase = 'running';
    run.request = { ...run.request, options: { ...run.request.options, force: true } };
    this.ensureWorker().postMessage(run.request);
    return { ok: true };
  }

  private ensureWorker(): WorkerLike {
    if (this.worker !== null) return this.worker;
    // NOTE for packaging (M4): the real `spawn` is electron-vite's `?nodeWorker` wrapper —
    // see `main/worker-spawn.ts` for where the thread's file lives and why no `asarUnpack` is needed.
    const worker = this.deps.spawn();
    this.worker = worker;
    // Listeners outlive the thread's usefulness: each checks that it is still THE worker.
    worker.on('message', (message) => {
      if (this.worker === worker) this.receive(message);
    });
    worker.on('error', (error) => {
      if (this.worker === worker)
        this.workerLost(error instanceof Error ? error.message : String(error));
    });
    worker.on('exit', (code) => {
      if (this.worker === worker)
        this.workerLost(`the optimizer worker exited unexpectedly (code ${code})`);
    });
    return worker;
  }

  private receive(message: WorkerMessage): void {
    if (message.type === 'ready') {
      this.calibrated = message.cost;
      return;
    }
    const run = this.active;
    // Not the active run's: a superseded run's, or a malformed request's -1. Dropped.
    if (run === null || message.runId !== run.runId) return;
    const { runId } = run;

    if (message.type === 'progress') {
      this.deps.emit({ runId, type: 'progress', progress: message.progress });
      return;
    }
    if (message.type === 'error') {
      this.finish(run, { runId, type: 'error', message: message.message });
      return;
    }
    const result: WorkerResult = message.result;
    switch (result.status) {
      case 'needs-confirmation': {
        // A question, not an ending: the run stays active, the worker idle.
        run.phase = 'waiting';
        const { status: _status, ...confirmation } = result;
        this.deps.emit({ runId, type: 'needs-confirmation', confirmation });
        return;
      }
      case 'done':
        this.finish(run, { runId, type: 'result', result: decorate(result, run) });
        return;
      case 'cancelled':
        this.finish(run, { runId, type: 'cancelled', result: decorate(result, run) });
        return;
      default:
        // `infeasible` or `error`: the analysis should have stopped either in `start`.
        this.finish(run, { runId, type: 'error', message: result.message });
    }
  }

  /** The thread is gone and nobody asked it to go: fail the run, if there is one; the next run spawns anew. */
  private workerLost(message: string): void {
    this.worker = null;
    if (this.active !== null)
      this.finish(this.active, { runId: this.active.runId, type: 'error', message });
  }

  /** End the run without its result. A search under way never yields, so that costs the thread; a waiting run costs nothing. */
  private abandon(run: ActiveRun): void {
    if (run.phase === 'running' && this.worker !== null) {
      const worker = this.worker;
      // Let go of it FIRST: its backlog and its `exit` then find nobody listening.
      this.worker = null;
      void worker.terminate();
    }
    this.finish(run, { runId: run.runId, type: 'cancelled', result: null });
  }

  /** The one way a run ends: exactly one terminal event, and the run is no longer active. */
  private finish(run: ActiveRun, event: RunEvent): void {
    if (this.active !== run) return;
    this.active = null;
    if (run.deadline !== undefined) clearTimeout(run.deadline);
    this.deps.emit(event);
    run.end();
  }
}
