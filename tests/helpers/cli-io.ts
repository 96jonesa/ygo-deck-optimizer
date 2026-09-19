import type { CliIo } from '../../src/cli/estimate';

/** A `CliIo` that collects what is written, for running a command in-process. */
export function captureIo(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    env,
  };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}
