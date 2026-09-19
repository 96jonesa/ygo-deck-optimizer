import type { IpcMainLike } from '../../src/main/ipc';

type Listener = Parameters<IpcMainLike['handle']>[1];

/**
 * Electron's `ipcMain`, as far as `handle` goes — including the part that
 * matters: registering a second handler for a channel THROWS, which is what a
 * per-window `registerIpc` runs into on its second window (TDD §3).
 */
export class FakeIpcMain implements IpcMainLike {
  private readonly handlers = new Map<string, Listener>();
  /** Every `handle` call, in order. */
  readonly registered: string[] = [];

  handle(channel: string, listener: Listener): void {
    if (this.handlers.has(channel))
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, listener);
    this.registered.push(channel);
  }

  /** What `ipcRenderer.invoke(channel, ...args)` does: a promise, rejected if the handler throws. */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`No handler registered for '${channel}'`);
    // Arguments and results cross processes by structured clone.
    return structuredClone(await handler({}, ...structuredClone(args)));
  }
}
