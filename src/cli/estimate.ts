import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import {
  type ResolvedFlat,
  type ResolvedLine,
  type ResolvedTemplate,
  resolveTemplate,
} from '../core/model/compile';
import { HAND_SIZES, validateTemplate } from '../core/model/template';
import { estimate } from '../core/prob/montecarlo';
import type { Progress } from '../core/util/progress';
import { collectStringsConf, loadCardIndex, loadSetnames } from '../main/edopro/loader';

/** Where a command reads its environment and writes its output; `process` satisfies it. */
export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
}

export const EXIT_OK = 0;
/** The template, or the card data, is at fault. */
export const EXIT_FAILED = 1;
/** The command line is at fault. */
export const EXIT_USAGE = 2;

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
type ValueFlag = (typeof VALUE_FLAGS)[number];

function wholeNumber(text: string): number | undefined {
  return /^[0-9]{1,15}$/.test(text) ? Number(text) : undefined;
}

/** Parse `estimate`'s arguments; both `--flag value` and `--flag=value` are read. */
export function parseEstimateArgs(argv: readonly string[], env: CliIo['env']): ParsedArgs {
  if (argv.includes('-h') || argv.includes('--help')) return { ok: true, help: true };
  const values = new Map<ValueFlag, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = (equals < 0 ? arg : arg.slice(0, equals)) as ValueFlag;
    if (!VALUE_FLAGS.includes(flag)) return { ok: false, message: `unknown option ${flag}` };
    if (values.has(flag)) return { ok: false, message: `${flag} is given twice` };
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined || value === '') return { ok: false, message: `${flag} needs a value` };
    values.set(flag, value);
  }

  if (positional.length === 0) return { ok: false, message: 'which template? give a .json file' };
  if (positional.length > 1)
    return { ok: false, message: `one template at a time, not ${positional.join(' and ')}` };

  const workdir = values.get('--workdir') ?? env.EDOPRO_WORKDIR;
  if (workdir === undefined || workdir === '')
    return { ok: false, message: 'no EDOPro install: pass --workdir <dir> or set EDOPRO_WORKDIR' };

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

  const args: EstimateArgs = { template: positional[0]!, workdir, samples, seed, ratio: 'max' };

  const hand = values.get('--hand');
  if (hand !== undefined) {
    const size = wholeNumber(hand);
    if (size === undefined || !HAND_SIZES.includes(size as 5 | 6))
      return { ok: false, message: `--hand must be ${HAND_SIZES.join(' or ')}, not ${hand}` };
    args.hand = size;
  }

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

function int(value: number): string {
  return value.toLocaleString('en-US');
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line per report, no `\r`: readable in a log file (TDD §11.3). */
export function formatProgress({ done, total, elapsedMs, etaMs }: Progress): string {
  const percent = ((100 * done) / total).toFixed(1);
  return `estimate: ${int(done)} / ${int(total)} samples (${percent}%), elapsed ${seconds(elapsedMs)}, ETA ${seconds(etaMs)}\n`;
}

/** Left-aligned columns, except those named in `right`; two spaces apart, indented by two. */
function table(rows: readonly (readonly string[])[], right: readonly number[] = []): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  return rows
    .map((row) =>
      `  ${row.map((cell, i) => (right.includes(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join('  ')}`.trimEnd(),
    )
    .join('\n');
}

function nameOf(line: ResolvedLine): string {
  return line.isRemainder ? '(remainder)' : line.id;
}

function rangeOf(line: ResolvedLine): string {
  return line.max === null ? `${line.min}+` : `${line.min}-${line.max}`;
}

function formatFlat(flat: ResolvedFlat, resolved: ResolvedTemplate): string {
  const counted = (prefix: string, desc: number) => {
    const { text, desc: parsed } = resolved.descriptions[desc]!;
    return `${prefix} ${parsed.anyOf.length > 1 ? `(${text})` : text}`;
  };
  const parts = [
    ...flat.reqs.map(({ n, desc }) => counted(`${n}x`, desc)),
    ...flat.limits.map(({ n, desc }) => counted(n === 0 ? 'no' : `at most ${n}x`, desc)),
  ];
  return parts.length === 0 ? '(nothing: every hand meets it)' : parts.join(', ');
}

/** Everything the estimate is an estimate OF: what was loaded, what was understood, what matches what. */
function formatReport(
  resolved: ResolvedTemplate,
  counts: readonly number[],
  templatePath: string,
): string {
  const out: string[] = [];
  const remainder = resolved.deckSize - counts.reduce((sum, n) => sum + n, 0);

  out.push(
    `Template — ${templatePath}: deck of ${resolved.deckSize}, hand of ${resolved.handSize}`,
  );
  out.push(
    table(
      [
        ['line', 'description', 'understood as', 'matches', 'range', 'count'],
        ...resolved.lines.map((line, i) => [
          nameOf(line),
          line.text,
          line.echo,
          int(line.count),
          rangeOf(line),
          String(line.isRemainder ? remainder : counts[i]),
        ]),
      ],
      [3, 5],
    ),
  );

  out.push('', 'Criteria — a hand succeeds if it meets any one');
  for (const criterion of resolved.criteria) {
    const title =
      criterion.name === undefined ? criterion.id : `${criterion.id} (${criterion.name})`;
    out.push(`  ${title}: ${criterion.text}`);
    criterion.alternatives.forEach((flat, i) => {
      out.push(`      ${i + 1}. ${formatFlat(flat, resolved)}`);
    });
    if (criterion.dropped > 0)
      out.push(`      (${criterion.dropped} more need over ${resolved.handSize} cards: never met)`);
  }
  out.push(`  judged as ${resolved.flat.length} distinct flat alternative(s)`);

  out.push(
    '',
    'Matching — a line fills a requirement, or counts toward a limit, only if its description implies it',
  );
  if (resolved.descriptions.length > 0)
    out.push(
      table(
        resolved.descriptions.map((description) => {
          const role =
            description.inRequirement && description.inLimit
              ? 'requirement+limit'
              : description.inLimit
                ? 'limit'
                : 'requirement';
          const lines = description.lines.map((line) => nameOf(resolved.lines[line]!));
          const verb = description.inLimit && !description.inRequirement ? 'counts' : 'filled by';
          return [
            role,
            description.text,
            `[${description.echo}]`,
            `${verb}: ${lines.length === 0 ? '(no line)' : lines.join(', ')}`,
          ];
        }),
      ),
    );
  const idle = resolved.lines.filter((_, i) => resolved.matrix[i]!.every((fills) => !fills));
  if (idle.length > 0)
    out.push(`  match nothing, so they cannot affect the odds: ${idle.map(nameOf).join(', ')}`);

  if (resolved.warnings.length > 0) {
    out.push('', 'Warnings');
    for (const warning of resolved.warnings) out.push(`  ${warning}`);
  }
  return `${out.join('\n')}\n`;
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
  const fail = (messages: readonly string[]): number => {
    for (const message of messages) io.stderr.write(`error: ${message}\n`);
    return EXIT_FAILED;
  };

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path.resolve(args.template), 'utf8'));
  } catch (failure) {
    return fail([`cannot read ${args.template}: ${(failure as Error).message}`]);
  }
  const validated = validateTemplate(json);
  if (!validated.ok) return fail(validated.errors.map((e) => `${args.template}: ${e}`));
  const template =
    args.hand === undefined
      ? validated.template
      : { ...validated.template, hand: { size: args.hand } };

  if (!existsSync(args.workdir) || !statSync(args.workdir).isDirectory())
    return fail([`${args.workdir} is not a directory`]);
  const cards = loadCardIndex(args.workdir, await initSqlJs());
  const status = cards.status;
  if (status.databases === 0)
    return fail([
      `no card database under ${args.workdir}: expected cards.cdb, expansions/*.cdb or repositories/*/*.cdb`,
    ]);
  const setnames = loadSetnames(args.workdir);
  const stringsFiles = collectStringsConf(args.workdir).length;
  io.stdout.write(
    `Card database — ${args.workdir}\n${table([
      ['databases', `${status.databases} loaded, ${status.skippedDatabases} skipped`],
      ['cards', int(status.cards)],
      ['replacedRows', `${int(status.replacedRows)} (rows a later database updated: expected)`],
      ['conflicts', `${int(status.conflicts)} (ids on which two repositories disagree)`],
      [
        'setnames',
        setnames === null
          ? 'none — no strings.conf found, so archetype descriptions are unavailable'
          : `${int(setnames.size)} archetype names from ${stringsFiles} strings.conf file(s)`,
      ],
    ])}\n\n`,
  );

  const result = resolveTemplate(template, { cards, setnames });
  if (!result.ok) return fail(result.errors.map((e) => `${args.template}: ${e}`));
  const { resolved } = result;

  const chosen = countsOf(resolved, args.ratio);
  if (!chosen.ok) {
    io.stderr.write(`error: ${chosen.message}\n`);
    return EXIT_USAGE;
  }
  io.stdout.write(formatReport(resolved, chosen.counts, args.template));

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
