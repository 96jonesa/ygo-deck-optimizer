import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Temporary directories for a test file, removed when the file is done. Call
 * once at file scope: `const temp = tempDirs('ygo-probe-')`.
 */
export function tempDirs(prefix: string) {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh, empty directory. */
  function dir(): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  /** An EDOPro-shaped directory holding `files` (relative path → contents). */
  function workdir(files: Record<string, string | Uint8Array>): string {
    const root = dir();
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
    return root;
  }

  return { dir, workdir };
}
