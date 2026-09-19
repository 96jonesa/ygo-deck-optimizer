import { parentPort } from 'node:worker_threads';
import { calibrateCost } from '../core/opt/calibrate';
import { WorkerSession } from './session';

// The optimizer worker's entry (TDD §3): a `worker_threads` thread that binds
// its port to a `WorkerSession`. Everything it does is in `session.ts`, which
// is tested without a thread; this file is the thread. Bundled by
// electron-vite through main's `?nodeWorker` import (see `main/worker-spawn.ts`).

if (parentPort === null) throw new Error('optimizer.worker.ts runs as a worker thread only');
const port = parentPort;

const session = new WorkerSession((message) => port.postMessage(message), {
  // `Date.now` ticks in whole milliseconds; a worker has the finer clock.
  calibrate: () => calibrateCost({ now: () => performance.now() }).cost,
});
// Calibrate first — synchronously, some 40 ms. A run posted meanwhile waits in the port.
session.start();
port.on('message', (message: unknown) => session.handle(message));
