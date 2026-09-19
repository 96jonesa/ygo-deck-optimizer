import { runCli } from './run';

// The thin process wrapper: everything testable is in `runCli`.
process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
