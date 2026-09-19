import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WorkerMessage } from '../../src/worker/protocol';

export const OPTIMIZER_WORKER = path.resolve(
  import.meta.dirname,
  '../../src/worker/optimizer.worker.ts',
);

const BOOT = path.resolve(import.meta.dirname, 'ts-worker-boot.mjs');

/**
 * The REAL worker file on a real thread, outside Electron: a bootstrap
 * registers tsx's loader inside the thread and imports the TypeScript source
 * (see `ts-worker-boot.mjs` for why not `execArgv`). What the app runs
 * instead is the same source bundled by electron-vite; the thread, the port
 * and the shared memory are the same `worker_threads`.
 */
export class TsWorker {
  readonly worker: Worker;
  readonly messages: WorkerMessage[] = [];
  private readonly waiting: (() => void)[] = [];
  exitCode: number | null = null;

  constructor(file: string = OPTIMIZER_WORKER) {
    this.worker = new Worker(BOOT, { workerData: { file: pathToFileURL(file).href } });
    this.worker.on('message', (message: WorkerMessage) => {
      this.messages.push(message);
      this.wake();
    });
    this.worker.on('exit', (code) => {
      this.exitCode = code;
      this.wake();
    });
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  /** Resolves with the first message `pick` accepts, already received or yet to come; rejects if the thread exits first. */
  async until<T extends WorkerMessage>(pick: (message: WorkerMessage) => message is T): Promise<T> {
    for (;;) {
      const found = this.messages.find(pick);
      if (found !== undefined) return found;
      if (this.exitCode !== null) throw new Error(`the worker exited with code ${this.exitCode}`);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  /** Resolves when `count` messages of the type have arrived. */
  async untilCount(type: WorkerMessage['type'], count: number): Promise<void> {
    while (this.messages.filter((message) => message.type === type).length < count) {
      if (this.exitCode !== null) throw new Error(`the worker exited with code ${this.exitCode}`);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }
}
