import type { FileDialogs, FilePickOptions } from '../../src/main/services/files';

/**
 * The two system file dialogs, played by the test. Answers are queued and
 * handed out in order; an empty queue is a cancel, which is what a dialog
 * nobody told the test about should look like.
 */
export class FakeDialogs implements FileDialogs {
  /** Every dialog that was shown, so a test can check what it was asked. */
  readonly opened: FilePickOptions[] = [];
  readonly saved: FilePickOptions[] = [];
  readonly openAnswers: (string | null)[] = [];
  readonly saveAnswers: (string | null)[] = [];

  /** The next `openFile` answers with `path`; several calls queue up. */
  willOpen(...paths: (string | null)[]): this {
    this.openAnswers.push(...paths);
    return this;
  }

  willSave(...paths: (string | null)[]): this {
    this.saveAnswers.push(...paths);
    return this;
  }

  openFile = async (options: FilePickOptions): Promise<string | null> => {
    this.opened.push(options);
    return this.openAnswers.length === 0 ? null : (this.openAnswers.shift() ?? null);
  };

  saveFile = async (options: FilePickOptions): Promise<string | null> => {
    this.saved.push(options);
    return this.saveAnswers.length === 0 ? null : (this.saveAnswers.shift() ?? null);
  };
}
