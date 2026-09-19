import { type CliIo, EXIT_OK, EXIT_USAGE, runEstimate } from './estimate';

export const USAGE = `usage: npm run cli -- <command> [options]

The development harness over src/core (TDD §16). Not shipped with the app.

commands:
  estimate <template.json>   Monte Carlo estimate of P(success) at one deck ratio

\`npm run cli -- <command> --help\` describes a command.
`;

/** Dispatch `argv` (without `node` and the script) to a command; returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    io.stderr.write(USAGE);
    return EXIT_USAGE;
  }
  if (command === '-h' || command === '--help') {
    io.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (command === 'estimate') return runEstimate(rest, io);
  io.stderr.write(`error: unknown command ${command}\n\n${USAGE}`);
  return EXIT_USAGE;
}
