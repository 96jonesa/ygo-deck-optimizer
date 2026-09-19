import { analyze } from '../core/model/analyze';
import { type ResolvedLine, type ResolvedTemplate, resolveTemplate } from '../core/model/compile';
import { estimate } from '../core/prob/montecarlo';
import type { Progress } from '../core/util/progress';
import {
  type CliIo,
  EXIT_OK,
  EXIT_USAGE,
  fail,
  handArg,
  loadInstall,
  parseFlags,
  readTemplate,
  templateArg,
  wholeNumber,
  workdirArg,
} from './common';
import { formatEstimateReport, int } from './report';

export { type CliIo, EXIT_FAILED, EXIT_OK, EXIT_USAGE } from './common';

export const ESTIMATE_USAGE = `usage: npm run cli -- estimate <template.json> [options]

Estimate, by Monte Carlo, the odds that an opening hand meets the template's
criteria at ONE deck ratio. A development harness: the app scores exactly.

  --workdir <dir>    the EDOPro install to read card data from (default: $EDOPRO_WORKDIR)
  --samples <n>      hands to draw (default 200000)
  --seed <n>         PRNG seed; the same seed gives the same estimate (default 1)
  --hand <5|6>       hand size (default: the template's)
  --ratio <a,b,...>  copies of each line, in template order; the remainder is computed
  --at <max|min>     every line at its max, or its min (default: max)
  -h, --help         show this
`;

export interface EstimateArgs {
  template: string;
  workdir: string;
  samples: number;
  seed: number;
  hand?: number;
  ratio: number[] | 'max' | 'min';
}

export type ParsedArgs =
  | { ok: true; args: EstimateArgs }
  | { ok: true; help: true }
  | { ok: false; message: string };

const VALUE_FLAGS = ['--workdir', '--samples', '--seed', '--hand', '--ratio', '--at'] as const;

/** Parse `estimate`'s arguments; both `--flag value` and `--flag=value` are read. */
export function parseEstimateArgs(argv: readonly string[], env: CliIo['env']): ParsedArgs {
  const flags = parseFlags(argv, VALUE_FLAGS);
  if (!flags.ok) return flags;
  if (flags.help) return { ok: true, help: true };
  const { values } = flags;
  const template = templateArg(flags.positional);
  if (!template.ok) return template;
  const workdir = workdirArg(values.get('--workdir'), env);
  if (!workdir.ok) return workdir;

  const samples = wholeNumber(values.get('--samples') ?? '200000');
  if (samples === undefined || samples < 1)
    return {
      ok: false,
      message: `--samples must be a positive whole number, not ${values.get('--samples')}`,
    };
  const seed = wholeNumber(values.get('--seed') ?? '1');
  if (seed === undefined || seed > 0xffffffff)
    return {
      ok: false,
      message: `--seed must be a whole number below 2^32, not ${values.get('--seed')}`,
    };

  const args: EstimateArgs = {
    template: template.value,
    workdir: workdir.value,
    samples,
    seed,
    ratio: 'max',
  };
  const hand = handArg(values.get('--hand'));
  if (!hand.ok) return hand;
  if (hand.value !== undefined) args.hand = hand.value;

  const ratio = values.get('--ratio');
  const at = values.get('--at');
  if (ratio !== undefined && at !== undefined)
    return { ok: false, message: '--ratio and --at are two ways to say the same thing; give one' };
  if (at !== undefined) {
    if (at !== 'max' && at !== 'min')
      return { ok: false, message: `--at must be max or min, not ${at}` };
    args.ratio = at;
  }
  if (ratio !== undefined) {
    const counts = ratio.split(',').map((part) => wholeNumber(part.trim()));
    if (counts.includes(undefined))
      return {
        ok: false,
        message: `--ratio must be whole numbers separated by commas, not ${ratio}`,
      };
    args.ratio = counts as number[];
  }
  return { ok: true, args };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line per report, no `\r`: readable in a log file (TDD §11.3). */
export function formatProgress({ done, total, elapsedMs, etaMs }: Progress): string {
  const percent = ((100 * done) / total).toFixed(1);
  return `estimate: ${int(done)} / ${int(total)} samples (${percent}%), elapsed ${seconds(elapsedMs)}, ETA ${seconds(etaMs)}\n`;
}

function rangeOf(line: ResolvedLine): string {
  return line.max === null ? `${line.min}+` : `${line.min}-${line.max}`;
}

type Counts = { ok: true; counts: number[] } | { ok: false; message: string };

/** The line counts `--ratio` / `--at` ask for, checked against the template's ranges and deck size. */
function countsOf(resolved: ResolvedTemplate, ratio: EstimateArgs['ratio']): Counts {
  const lines = resolved.lines.filter((line) => !line.isRemainder);
  const remainderLine = resolved.lines.at(-1)!;
  const given = typeof ratio !== 'string';
  const counts = given ? ratio : lines.map((line) => (ratio === 'max' ? line.max! : line.min));
  if (counts.length !== lines.length)
    return {
      ok: false,
      message: `--ratio has ${counts.length} counts, but the template has ${lines.length} lines (${lines.map((l) => l.id).join(', ')})`,
    };
  for (const [i, line] of lines.entries()) {
    const count = counts[i]!;
    if (count < line.min || count > line.max!)
      return {
        ok: false,
        message: `--ratio gives line ${JSON.stringify(line.id)} ${count} copies, outside its range ${rangeOf(line)}`,
      };
  }
  const total = counts.reduce((sum, n) => sum + n, 0);
  const how = given ? 'this ratio' : `every line at its ${ratio}`;
  if (total > resolved.deckSize)
    return {
      ok: false,
      message: `${how} is ${total} cards, more than the deck of ${resolved.deckSize}; pass a smaller --ratio`,
    };
  const remainder = resolved.deckSize - total;
  if (
    remainder < remainderLine.min ||
    (remainderLine.max !== null && remainder > remainderLine.max)
  )
    return {
      ok: false,
      message: `${how} leaves ${remainder} unspecified cards, outside the remainder's range ${rangeOf(remainderLine)}`,
    };
  return { ok: true, counts: [...counts] };
}

/**
 * `estimate <template.json>`: load the card data, resolve the template, print
 * what was understood, and estimate P(success) at one ratio. The report goes
 * to stdout, progress and errors to stderr. Returns the exit code.
 */
export async function runEstimate(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseEstimateArgs(argv, io.env);
  if (!parsed.ok) {
    io.stderr.write(`error: ${parsed.message}\n\n${ESTIMATE_USAGE}`);
    return EXIT_USAGE;
  }
  if ('help' in parsed) {
    io.stdout.write(ESTIMATE_USAGE);
    return EXIT_OK;
  }
  const { args } = parsed;

  const read = readTemplate(args.template, args.hand);
  if (!read.ok) return fail(io, read.errors);
  const template = read.value;
  const install = await loadInstall(args.workdir);
  if (!install.ok) return fail(io, install.errors);
  const { cards, setnames, header } = install.value;
  io.stdout.write(header);

  const result = resolveTemplate(template, { cards, setnames });
  if (!result.ok)
    return fail(
      io,
      result.errors.map((e) => `${args.template}: ${e}`),
    );
  const { resolved } = result;

  const chosen = countsOf(resolved, args.ratio);
  if (!chosen.ok) {
    io.stderr.write(`error: ${chosen.message}\n`);
    return EXIT_USAGE;
  }
  // The report is the analysis's: `estimate` and `analyze` say the same things the same way.
  const analysis = analyze(template, { cards, setnames });
  io.stdout.write(formatEstimateReport(analysis, args.template, chosen.counts));

  const { hits, samples, p, stderr, ci95 } = estimate(resolved, chosen.counts, {
    handSize: resolved.handSize,
    samples: args.samples,
    seed: args.seed,
    onProgress: (progress) => io.stderr.write(formatProgress(progress)),
  });
  io.stdout.write(
    `\nP(success) = ${p.toFixed(4)}  (95% CI ${ci95[0].toFixed(4)}–${ci95[1].toFixed(4)}, ${int(samples)} samples, seed ${args.seed})\n` +
      `  ${int(hits)} hits; standard error ${stderr.toFixed(5)}; the interval is the Wilson score interval\n`,
  );
  return EXIT_OK;
}
