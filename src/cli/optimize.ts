import { analyze } from '../core/model/analyze';
import { compileProblem, resolveTemplate } from '../core/model/compile';
import type { HandSize } from '../core/model/problem';
import { calibrateCost } from '../core/opt/calibrate';
import {
  breakdown,
  DEFAULT_TOP_K,
  exampleRatio,
  optimize,
  type Rational,
  sweepFixed,
} from '../core/opt/optimizer';
import {
  type CliIo,
  EXIT_FAILED,
  EXIT_NEEDS_CONFIRMATION,
  EXIT_OK,
  EXIT_USAGE,
  fail,
  handArg,
  loadInstall,
  type Parsed,
  parseFlags,
  readTemplate,
  templateArg,
  wholeNumber,
  workdirArg,
} from './common';
import {
  formatNeedsConfirmation,
  formatOptimizeProgress,
  formatOptimizeReport,
  type OptimizeReport,
} from './optimize-report';
import { formatAnalysis } from './report';

export const OPTIMIZE_USAGE = `usage: npm run cli -- optimize <template.json> [options]

Score EVERY deck ratio the template allows, exactly, and report the best one in
lines, the ranked table, the plateau of ratios that are as good as the best,
the lines that cannot matter, how the odds move with the copies of each line,
and the best ratio criterion by criterion. Progress goes to stderr.

  --workdir <dir>      the EDOPro install to read card data from (default: $EDOPRO_WORKDIR)
  --top <n>            rows of the ranked table to print (default 20)
  --delta <points>     the plateau's width in percentage points (default 0.5)
  --sweep <lineId>     also sweep this line in detail: re-optimized, and with the others held fixed
  --hand <5|6>         hand size (default: the template's)
  --blend <W5:W6>      rank by going first (5 cards) and second (6) together, e.g. 3:2 for first 60% of the time
  --threshold <sec>    ask for --force when the estimated time is over this (default 60)
  --force              run however long the estimate says
  --json               print the raw result as JSON, and nothing else
  -h, --help           show this

Exits 3, having scored nothing, when the run needs --force.
`;

export interface OptimizeArgs {
  template: string;
  workdir: string;
  top: number;
  delta: Rational;
  sweep?: string;
  hand?: number;
  /** Weights of a hand of 5 and a hand of 6, in lowest terms. */
  blend?: [number, number];
  thresholdMs: number;
  force: boolean;
  json: boolean;
}

export type ParsedOptimizeArgs = Parsed<OptimizeArgs> | { ok: true; help: true };

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** `0.5` percentage points as the exact fraction 1/200: the digits over a power of ten, in lowest terms. */
export function deltaArg(text: string): Parsed<Rational> {
  const match = /^([0-9]{1,3})(?:\.([0-9]{1,6}))?$/.exec(text);
  if (match === null)
    return { ok: false, message: `--delta is percentage points such as 0.5, not ${text}` };
  const decimals = match[2] ?? '';
  const num = Number(match[1]! + decimals);
  const den = 100 * 10 ** decimals.length;
  const shared = gcd(num, den);
  return { ok: true, value: { num: num / shared, den: den / shared } };
}

export function blendArg(text: string): Parsed<[number, number]> {
  const match = /^([0-9]{1,4}):([0-9]{1,4})$/.exec(text);
  const first = Number(match?.[1]);
  const second = Number(match?.[2]);
  if (match === null || first < 1 || second < 1)
    return {
      ok: false,
      message: `--blend is two positive whole weights such as 3:2 — first : second — not ${text}`,
    };
  const shared = gcd(first, second);
  return { ok: true, value: [first / shared, second / shared] };
}

const VALUE_FLAGS = [
  '--workdir',
  '--top',
  '--delta',
  '--sweep',
  '--hand',
  '--blend',
  '--threshold',
] as const;

export function parseOptimizeArgs(argv: readonly string[], env: CliIo['env']): ParsedOptimizeArgs {
  const flags = parseFlags(argv, VALUE_FLAGS, ['--force', '--json'] as const);
  if (!flags.ok) return flags;
  if (flags.help) return { ok: true, help: true };
  const { values } = flags;
  const template = templateArg(flags.positional);
  if (!template.ok) return template;
  const workdir = workdirArg(values.get('--workdir'), env);
  if (!workdir.ok) return workdir;

  const top = wholeNumber(values.get('--top') ?? '20');
  if (top === undefined || top < 1 || top > 100_000)
    return {
      ok: false,
      message: `--top must be a positive whole number, not ${values.get('--top')}`,
    };
  const delta = deltaArg(values.get('--delta') ?? '0.5');
  if (!delta.ok) return delta;
  const threshold = wholeNumber(values.get('--threshold') ?? '60');
  if (threshold === undefined)
    return {
      ok: false,
      message: `--threshold must be a whole number of seconds, not ${values.get('--threshold')}`,
    };
  const hand = handArg(values.get('--hand'));
  if (!hand.ok) return hand;

  const value: OptimizeArgs = {
    template: template.value,
    workdir: workdir.value,
    top,
    delta: delta.value,
    thresholdMs: threshold * 1000,
    force: flags.switches.has('--force'),
    json: flags.switches.has('--json'),
  };
  const blendText = values.get('--blend');
  if (blendText !== undefined) {
    if (hand.value !== undefined)
      return { ok: false, message: '--blend ranks by both hand sizes; it cannot go with --hand' };
    const blend = blendArg(blendText);
    if (!blend.ok) return blend;
    value.blend = blend.value;
  }
  if (hand.value !== undefined) value.hand = hand.value;
  const sweep = values.get('--sweep');
  if (sweep !== undefined) value.sweep = sweep;
  return { ok: true, value };
}

/**
 * `optimize <template.json>`: load the card data, analyze and compile the
 * template, score every class vector, and print the report — or, with
 * `--json`, the raw result — to stdout. Progress and errors go to stderr.
 * Returns the exit code.
 */
export async function runOptimize(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseOptimizeArgs(argv, io.env);
  if (!parsed.ok) {
    io.stderr.write(`error: ${parsed.message}\n\n${OPTIMIZE_USAGE}`);
    return EXIT_USAGE;
  }
  if ('help' in parsed) {
    io.stdout.write(OPTIMIZE_USAGE);
    return EXIT_OK;
  }
  const args = parsed.value;

  // A blend is judged at both hands, so the criteria are expanded for the larger (TDD §8).
  const read = readTemplate(args.template, args.blend === undefined ? args.hand : 6);
  if (!read.ok) return fail(io, read.errors);
  const template = read.value;
  const install = await loadInstall(args.workdir);
  if (!install.ok) return fail(io, install.errors);
  const { cards, setnames, header } = install.value;

  const analysis = analyze(template, { cards, setnames });
  if (!analysis.ok) {
    // Nothing can be run: the analysis says why, line by line.
    if (!args.json) io.stdout.write(header + formatAnalysis(analysis, args.template));
    return fail(io, [`${args.template} has errors; nothing was scored`]);
  }
  const resolved = resolveTemplate(template, { cards, setnames });
  if (!resolved.ok) return fail(io, resolved.errors);
  const handSizes: HandSize[] | undefined =
    args.blend === undefined
      ? undefined
      : [
          { H: 5, weight: args.blend[0] },
          { H: 6, weight: args.blend[1] },
        ];
  const compiled = compileProblem(resolved.resolved, handSizes === undefined ? {} : { handSizes });
  if (!compiled.ok) return fail(io, compiled.errors);

  const lineIds = resolved.resolved.lines.filter((line) => !line.isRemainder).map((l) => l.id);
  if (args.sweep !== undefined && !lineIds.includes(args.sweep)) {
    io.stderr.write(
      `error: --sweep names no line of the template: ${args.sweep} (it has ${lineIds.join(', ')})\n`,
    );
    return EXIT_USAGE;
  }

  const { cost } = calibrateCost({ now: () => performance.now() });
  const result = optimize(compiled, {
    topK: Math.max(DEFAULT_TOP_K, args.top),
    plateauDelta: args.delta,
    force: args.force,
    confirmThresholdMs: args.thresholdMs,
    cost,
    now: () => performance.now(),
    onProgress: (progress) => io.stderr.write(formatOptimizeProgress(progress)),
  });
  if (result.status === 'error' || result.status === 'infeasible')
    return fail(io, [result.message]);
  if (result.status === 'needs-confirmation') {
    if (args.json) io.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
    io.stderr.write(formatNeedsConfirmation(result.total, result.estimatedMs, result.message));
    return EXIT_NEEDS_CONFIRMATION;
  }

  const byCriterion = breakdown(compiled, resolved.resolved.criteria, result.best.classTotals);
  const report: OptimizeReport = {
    analysis,
    templatePath: args.template,
    compiled,
    run: result,
    partial: result.partial,
    top: args.top,
    breakdown: byCriterion,
  };
  let fixed: ReturnType<typeof sweepFixed> | undefined;
  if (args.sweep !== undefined) {
    const lineId = args.sweep;
    const base = exampleRatio(compiled, result.best.classTotals).slice(0, -1);
    fixed = sweepFixed(compiled, base, lineId);
    const swept = result.sweeps.find((sweep) => sweep.lineId === lineId);
    const idle = result.irrelevant.find((line) => line.lineId === lineId);
    // A flat irrelevant line has no table: every count it takes reaches the best.
    const cells = swept?.cells ?? idle?.cells;
    const bestNum = result.best.blend.num;
    const argmax = (cells ?? [])
      .filter((cell) => cell.best.blend.num === bestNum)
      .map((cell) => cell.count);
    report.sweep = { lineId, ...(cells === undefined ? {} : { cells }), argmax, fixed };
  }
  io.stdout.write(
    args.json
      ? `${JSON.stringify({ result, breakdown: byCriterion, ...(fixed === undefined ? {} : { sweepFixed: fixed }) }, null, 2)}\n`
      : header + formatOptimizeReport(report),
  );
  return result.status === 'done' ? EXIT_OK : EXIT_FAILED;
}
