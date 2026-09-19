/**
 * How long an edit is held before the analysis is asked for (TDD §12). The
 * analysis itself is 0.55–54 ms, so this is not about the cost of computing it
 * but about not sending one IPC round trip per keystroke.
 */
export const ANALYZE_DEBOUNCE_MS = 150;

/**
 * Holds a task back until the edits stop. Each `schedule` replaces whatever
 * was waiting — a burst of keystrokes runs the LAST task once, never one per
 * keystroke — and `cancel` drops it, which is what unmounting needs.
 */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private task: (() => void) | null = null;

  constructor(private readonly delayMs: number) {}

  schedule(task: () => void): void {
    this.cancel();
    this.task = task;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.delayMs);
  }

  /** Run what is waiting now, if anything is. */
  run(): void {
    const { task } = this;
    this.cancel();
    task?.();
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.task = null;
  }
}
