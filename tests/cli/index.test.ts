import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** `npm run cli -- ...`, as the script in package.json spells it, in a real process. */
function cli(...argv: string[]) {
  const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return spawnSync(process.execPath, [tsx, 'src/cli/index.ts', ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, EDOPRO_WORKDIR: '' },
  });
}

// The one test that starts a process: it proves the wrapper wires argv, the
// streams and the exit code through. Everything else runs `runCli` in-process.
describe('the cli process', () => {
  it('turns the exit code of runCli into the exit status, and writes to the real streams', () => {
    const bare = cli();
    expect(bare.status).toBe(2);
    expect(bare.stdout).toBe('');
    expect(bare.stderr).toMatch(/^usage: npm run cli -- <command>/);

    const help = cli('estimate', '--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^usage: npm run cli -- estimate/);
    expect(help.stderr).toBe('');
  });
});
