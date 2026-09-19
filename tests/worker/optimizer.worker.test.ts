import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerMessage } from '../../src/worker/protocol';
import { TsWorker } from '../helpers/ts-worker';
import { cancelFlag, runRequest, wideProblem } from '../helpers/wide-compiled';

// The protocol against the REAL worker file on a real thread (what it does
// per message is tested, without a thread, in session.test.ts). This is the
// part no double can stand in for: that the port queues a run posted during
// calibration, that a flag set on THIS thread stops a synchronous search on
// THAT one, and that `terminate()` abandons a search that never yields.

type Of<T extends WorkerMessage['type']> = Extract<WorkerMessage, { type: T }>;
const isReady = (message: WorkerMessage): message is Of<'ready'> => message.type === 'ready';
const isResult = (message: WorkerMessage): message is Of<'result'> => message.type === 'result';

/** Millions of class vectors: many seconds of search, unless it is stopped. */
const WIDE = wideProblem({ lines: 8, max: 6 });

const spawned: TsWorker[] = [];
function spawn(): TsWorker {
  const worker = new TsWorker();
  spawned.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(spawned.splice(0).map(({ worker }) => worker.terminate()));
});

describe('optimizer.worker', () => {
  it('calibrates at startup, says `ready`, and then runs what was posted meanwhile', async () => {
    const thread = spawn();
    // Posted before the thread has even loaded: the port keeps it.
    thread.worker.postMessage(runRequest(1, wideProblem({ lines: 3, max: 3 })));
    const { result } = await thread.until(isResult);
    expect(result).toMatchObject({ status: 'done', done: 64, total: 64 });

    expect(thread.messages[0]?.type).toBe('ready');
    const { cost } = await thread.until(isReady);
    expect(cost.perTermNs).toBeGreaterThan(0);
    // The search was estimated at the cost this thread calibrated.
    expect(result.status === 'done' && result.cost).toEqual(cost);
    expect(thread.messages.at(-2)).toMatchObject({ type: 'progress', runId: 1 });
  });

  it('stops a long search early when the flag is set from this thread, keeping the partial result', async () => {
    const thread = spawn();
    const flag = cancelFlag();
    thread.worker.postMessage(runRequest(5, WIDE, { force: true, progressIntervalMs: 50 }, flag));
    await thread.untilCount('progress', 2);
    Atomics.store(new Int32Array(flag), 0, 1);

    const { runId, result } = await thread.until(isResult);
    expect(runId).toBe(5);
    if (result.status !== 'cancelled') throw new Error(`expected cancelled, got ${result.status}`);
    expect(result.partial).toBe(true);
    expect(result.done).toBeGreaterThan(0);
    expect(result.done).toBeLessThan(Number(result.total));
    // What it had is all there: a best ratio, in lines.
    expect(result.bestRatio.example.reduce((sum, count) => sum + count, 0)).toBe(40);
    expect(result.rankedRatios).toHaveLength(result.ranked.length);
  });

  it('runs again after a graceful stop: the thread is still warm, and did not calibrate twice', async () => {
    const thread = spawn();
    const flag = cancelFlag();
    thread.worker.postMessage(runRequest(1, WIDE, { force: true, progressIntervalMs: 50 }, flag));
    await thread.untilCount('progress', 1);
    Atomics.store(new Int32Array(flag), 0, 1);
    await thread.untilCount('result', 1);

    thread.worker.postMessage(runRequest(2, wideProblem({ lines: 3, max: 3 })));
    await thread.untilCount('result', 2);
    expect(thread.messages.at(-1)).toMatchObject({ runId: 2, result: { status: 'done' } });
    expect(thread.messages.filter(isReady)).toHaveLength(1);
  });

  it('asks for confirmation over the threshold, and runs once the request comes back with force', async () => {
    const thread = spawn();
    const request = runRequest(3, wideProblem({ lines: 3, max: 3 }), { confirmThresholdMs: 0 });
    thread.worker.postMessage(request);
    const asked = await thread.until(isResult);
    expect(asked.result).toMatchObject({ status: 'needs-confirmation', reason: 'estimate' });

    thread.worker.postMessage({ ...request, options: { ...request.options, force: true } });
    await thread.untilCount('result', 2);
    expect(thread.messages.at(-1)).toMatchObject({ runId: 3, result: { status: 'done' } });
  });

  it('is abandoned by terminate() in the middle of a search that never yields', async () => {
    const thread = spawn();
    thread.worker.postMessage(runRequest(1, WIDE, { force: true, progressIntervalMs: 50 }));
    await thread.untilCount('progress', 1);
    await thread.worker.terminate();
    expect(thread.exitCode).not.toBeNull();
    expect(thread.messages.filter(isResult)).toEqual([]);
  });
});
