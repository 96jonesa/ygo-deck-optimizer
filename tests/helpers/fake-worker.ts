import type { CostModel } from '../../src/core/model/analyze';
import type { WorkerLike } from '../../src/main/services/runs';
import type { WorkerMessage, WorkerRequest, WorkerResult } from '../../src/worker/protocol';
import { WorkerSession } from '../../src/worker/session';

export const FAKE_COST: CostModel = { perVectorUs: 0.5, perTermNs: 9 };

type Listeners = {
  message: ((message: WorkerMessage) => void)[];
  error: ((error: unknown) => void)[];
  exit: ((code: number) => void)[];
};

/**
 * The optimizer worker as `RunService` sees it, with the thread replaced by
 * the test: nothing is answered until the test says so, in the order it says
 * so — which is what it takes to stage a race. `terminate()` only records;
 * the `exit` a real thread then emits is the test's to send, or not.
 */
export class FakeWorker implements WorkerLike {
  readonly posted: WorkerRequest[] = [];
  terminated = false;
  private readonly listeners: Listeners = { message: [], error: [], exit: [] };

  postMessage(message: WorkerRequest): void {
    if (this.terminated) throw new Error('posted to a terminated worker');
    this.posted.push(message);
  }

  on(event: 'message', listener: (message: WorkerMessage) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: keyof Listeners, listener: (arg: never) => void): void {
    (this.listeners[event] as ((arg: never) => void)[]).push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The `n`th request posted, from zero. */
  request(n: number): WorkerRequest {
    const request = this.posted[n];
    if (request === undefined) throw new Error(`request ${n} was never posted`);
    return request;
  }

  /** The cancel flag of the `n`th request, as the worker would read it. */
  flag(n: number): number {
    return Atomics.load(new Int32Array(this.request(n).cancelFlag), 0);
  }

  // --- what the thread would do, when the test says so ---------------------------------------

  send(message: WorkerMessage): void {
    for (const listener of this.listeners.message) listener(message);
  }

  ready(cost: CostModel = FAKE_COST): void {
    this.send({ type: 'ready', cost });
  }

  progress(runId: number, done: number, total = 128): void {
    this.send({ type: 'progress', runId, progress: { done, total, elapsedMs: done, etaMs: 1 } });
  }

  result(runId: number, result: WorkerResult): void {
    this.send({ type: 'result', runId, result });
  }

  /**
   * Answer the `n`th request as the real worker would: every message a
   * calibrated `WorkerSession` posts for it (its `ready` aside — that is `ready()`).
   */
  answer(n: number): void {
    sessionOver((message) => this.send(message)).handle(this.request(n));
  }

  crash(error: unknown): void {
    for (const listener of this.listeners.error) listener(error);
  }

  exit(code: number): void {
    for (const listener of this.listeners.exit) listener(code);
  }
}

/** `spawn` for a `RunService`, keeping every worker it handed out. */
export class FakeWorkers {
  readonly spawned: FakeWorker[] = [];

  readonly spawn = (): FakeWorker => {
    const worker = new FakeWorker();
    this.spawned.push(worker);
    return worker;
  };

  /** The `n`th worker spawned, from zero. */
  worker(n: number): FakeWorker {
    const worker = this.spawned[n];
    if (worker === undefined) throw new Error(`worker ${n} was never spawned`);
    return worker;
  }
}

/**
 * A started session whose `ready` is left out. Calibrated by injection, so
 * that no search calibrates for itself — a loop on the clock, which never
 * ends under fake timers.
 */
function sessionOver(post: (message: WorkerMessage) => void): WorkerSession {
  const session = new WorkerSession(
    (message) => {
      if (message.type !== 'ready') post(message);
    },
    { calibrate: () => FAKE_COST },
  );
  session.start();
  return session;
}

/** What the real worker answers a request with, computed on the spot. */
export function realResult(request: WorkerRequest): WorkerResult {
  let found: WorkerResult | undefined;
  sessionOver((message) => {
    if (message.type === 'result') found = message.result;
  }).handle(request);
  if (found === undefined) throw new Error('the session posted no result');
  return found;
}
