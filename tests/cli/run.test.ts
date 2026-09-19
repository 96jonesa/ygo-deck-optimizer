import { describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_USAGE } from '../../src/cli/estimate';
import { runCli } from '../../src/cli/run';
import { captureIo } from '../helpers/cli-io';

async function run(argv: string[]) {
  const captured = captureIo();
  const code = await runCli(argv, captured.io);
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

describe('runCli', () => {
  it('prints the usage to stderr and exits 2 when no command is given', async () => {
    const { code, stdout, stderr } = await run([]);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^usage: npm run cli -- <command>/);
    expect(stderr).toMatch(/analyze <template\.json>/);
    expect(stderr).toMatch(/estimate <template\.json>/);
  });

  it('rejects an unknown command by name', async () => {
    const { code, stderr } = await run(['optimise']);
    expect(code).toBe(EXIT_USAGE);
    expect(stderr).toMatch(/^error: unknown command optimise/);
  });

  it('prints the usage to stdout for --help, and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { code, stdout, stderr } = await run([flag]);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toMatch(/^usage: npm run cli -- <command>/);
      expect(stderr).toBe('');
    }
  });

  it('hands `analyze` its own arguments', async () => {
    const help = await run(['analyze', '--help']);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toMatch(/^usage: npm run cli -- analyze/);

    const bare = await run(['analyze']);
    expect(bare.code).toBe(EXIT_USAGE);
    expect(bare.stderr).toMatch(/which template\?/);
  });

  it('hands `estimate` its own arguments', async () => {
    const help = await run(['estimate', '--help']);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toMatch(/^usage: npm run cli -- estimate/);

    const bare = await run(['estimate']);
    expect(bare.code).toBe(EXIT_USAGE);
    expect(bare.stderr).toMatch(/which template\?/);
  });
});
