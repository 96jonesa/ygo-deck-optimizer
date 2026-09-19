import { analyze } from '../core/model/analyze';
import {
  type CliIo,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  fail,
  handArg,
  loadInstall,
  type Parsed,
  parseFlags,
  readTemplate,
  templateArg,
  workdirArg,
} from './common';
import { formatAnalysis } from './report';

export const ANALYZE_USAGE = `usage: npm run cli -- analyze <template.json> [options]

Show everything the tool understands of a template BEFORE anything is scored:
what each line and criterion was read as, which lines fill each requirement
and which only nearly do, what each limit counts and ignores, the derived
totals, the classes the criteria can tell apart, and what a run would cost.
Exits 1 when the template has errors; the report is printed either way.

  --workdir <dir>    the EDOPro install to read card data from (default: $EDOPRO_WORKDIR)
  --hand <5|6>       hand size (default: the template's)
  --json             print the raw Analysis value as JSON, and nothing else
  -h, --help         show this
`;

export interface AnalyzeArgs {
  template: string;
  workdir: string;
  hand?: number;
  json: boolean;
}

export type ParsedAnalyzeArgs = Parsed<AnalyzeArgs> | { ok: true; help: true };

export function parseAnalyzeArgs(argv: readonly string[], env: CliIo['env']): ParsedAnalyzeArgs {
  const flags = parseFlags(argv, ['--workdir', '--hand'] as const, ['--json'] as const);
  if (!flags.ok) return flags;
  if (flags.help) return { ok: true, help: true };
  const template = templateArg(flags.positional);
  if (!template.ok) return template;
  const workdir = workdirArg(flags.values.get('--workdir'), env);
  if (!workdir.ok) return workdir;
  const hand = handArg(flags.values.get('--hand'));
  if (!hand.ok) return hand;
  const value: AnalyzeArgs = {
    template: template.value,
    workdir: workdir.value,
    json: flags.switches.has('--json'),
  };
  if (hand.value !== undefined) value.hand = hand.value;
  return { ok: true, value };
}

/**
 * `analyze <template.json>`: load the card data, analyze the template, and
 * print the report — or, with `--json`, the `Analysis` value itself — to
 * stdout. Returns the exit code: 1 when the analysis holds an error.
 */
export async function runAnalyze(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseAnalyzeArgs(argv, io.env);
  if (!parsed.ok) {
    io.stderr.write(`error: ${parsed.message}\n\n${ANALYZE_USAGE}`);
    return EXIT_USAGE;
  }
  if ('help' in parsed) {
    io.stdout.write(ANALYZE_USAGE);
    return EXIT_OK;
  }
  const args = parsed.value;

  const template = readTemplate(args.template, args.hand);
  if (!template.ok) return fail(io, template.errors);
  const install = await loadInstall(args.workdir);
  if (!install.ok) return fail(io, install.errors);
  const { cards, setnames, header } = install.value;

  const analysis = analyze(template.value, { cards, setnames });
  io.stdout.write(
    args.json
      ? `${JSON.stringify(analysis, null, 2)}\n`
      : header + formatAnalysis(analysis, args.template),
  );
  return analysis.ok ? EXIT_OK : EXIT_FAILED;
}
