import type { Analysis } from '../core/model/analyze';
import { type ExpandedClass, expandClassVector, REMAINDER_ID } from '../core/model/compile';
import type {
  Compiled,
  CriterionScore,
  FixedSweepCell,
  OptimizeOutputs,
  OptimizeProgress,
  RankedVector,
  ScoredVector,
  SweepCell,
} from '../core/opt/optimizer';
import type { BlendPart, BlendScore, Fraction } from '../core/prob/scorer';
import { type Count, countToNumber, formatCount } from '../core/util/count';
import {
  classesSection,
  criteriaSection,
  formatDuration,
  int,
  issueSections,
  matchingSection,
  table,
  templateSection,
} from './report';

/**
 * The readable report of an optimizer run (PRD §5.6): what was understood —
 * the analysis's own sections — then the best ratio in LINES, the ranked
 * table, the plateau, the lines that cannot matter, every line's sweep, and
 * the best ratio by criterion. Probabilities are exact fractions; the
 * percentage beside each is for the eye.
 */

const nameOf = (id: string): string => (id === REMAINDER_ID ? '(remainder)' : id);

export function percent(p: number): string {
  return `${(100 * p).toFixed(4)}%`;
}

export function fraction({ num, den }: Fraction): string {
  return `${int(num)} / ${int(den)}`;
}

/** `3`, `2–3`, `0, 2–3`: a sorted set of counts, runs collapsed. */
export function formatCounts(counts: readonly number[]): string {
  const runs: string[] = [];
  for (let at = 0; at < counts.length; ) {
    let end = at;
    while (end + 1 < counts.length && counts[end + 1] === counts[end]! + 1) end++;
    runs.push(at === end ? `${counts[at]}` : `${counts[at]}–${counts[end]}`);
    at = end + 1;
  }
  return runs.length === 0 ? '-' : runs.join(', ');
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line per report, no `\r`: readable in a log file (TDD §11.3). The total may be past 2^53. */
export function formatOptimizeProgress({
  done,
  total,
  elapsedMs,
  etaMs,
}: OptimizeProgress): string {
  const share = ((100 * done) / countToNumber(total)).toFixed(1);
  return `optimize: ${int(done)} / ${formatCount(total)} vectors (${share}%), elapsed ${seconds(elapsedMs)}, ETA ${seconds(etaMs)}\n`;
}

/** The copies each line holds in a class vector: `3`, or `0–3` where a class's total splits freely. */
function copiesByLine(compiled: Compiled, classTotals: readonly number[]): Map<string, string> {
  const copies = new Map<string, string>();
  for (const { lines } of expandClassVector(compiled.classes, classTotals))
    for (const { id, min, max } of lines) copies.set(id, min === max ? `${min}` : `${min}–${max}`);
  return copies;
}

/** Line ids in template order, the remainder last; `relevant` leaves out the blank class's. */
const lineIds = (compiled: Compiled, relevant = false): string[] =>
  compiled.classes
    .slice(relevant ? 1 : 0)
    .flatMap((cls) => cls.lines)
    .sort((a, b) => a.line - b.line)
    .map((line) => line.id);

export function searchSection(run: OptimizeOutputs, partial: boolean): string {
  const rows = [
    [
      'class vectors',
      `${int(run.done)} of ${formatCount(run.total)} scored in ${formatDuration(run.elapsedMs)}${partial ? ' — CANCELLED: everything below holds for these only' : ''}`,
    ],
    [
      'raw ratios',
      `${formatCount(run.rawRatios)} — every one behind a class vector ties with it exactly`,
    ],
    [
      'hands',
      run.handSizes
        .map(({ H, weight }) =>
          run.handSizes.length === 1 ? `${H} cards` : `${H} cards × ${weight}`,
        )
        .join(', '),
    ],
    [
      'cost',
      `estimated ${formatDuration(run.estimatedMs)} at ${run.cost.perTermNs.toFixed(1)} ns a term, calibrated on this machine`,
    ],
  ];
  return ['Search — every class vector, scored exactly', table(rows)].join('\n');
}

/** `going first: 41.5744% (273,563 / 658,008)` — a part's own exact answer. */
function partText(part: BlendPart): string {
  return `going ${part.H === 5 ? 'first' : 'second'}: ${percent(part.num / part.den)} (${fraction(part)})`;
}

/**
 * The score as the reader needs it. With two parts the AVERAGE is the sort
 * key, and the two hands have DIFFERENT denominators — C(40,5) against
 * C(40,6) — so both are printed whole: one fraction could only be one of them.
 */
function scoreText({ score, blend }: ScoredVector): string {
  const head = `${fraction(blend)} = ${percent(score.pDisplay)}`;
  return score.parts.length === 1 ? head : `${head}\n  ${score.parts.map(partText).join('\n  ')}`;
}

export function bestSection(compiled: Compiled, best: RankedVector): string {
  const expanded = expandClassVector(compiled.classes, best.classTotals);
  const copies = copiesByLine(compiled, best.classTotals);
  const noted = new Set<number>();
  const note = (cls: ExpandedClass): string => {
    // A class of several lines is said once, on its first line.
    if (cls.lines.length < 2 || noted.has(cls.cls)) return '';
    noted.add(cls.cls);
    return cls.text.replaceAll(`\`${REMAINDER_ID}\``, '(remainder)').replaceAll('`', '');
  };
  const rows = lineIds(compiled).map((id) => {
    const cls = expanded.find((c) => c.lines.some((line) => line.id === id))!;
    return [nameOf(id), copies.get(id)!, note(cls)];
  });
  return [
    `Best ratio — P(success) = ${scoreText(best)}`,
    table([['line', 'copies', ''], ...rows], [1]),
    `  ${formatCount(best.rawRatios)} raw ratio(s) are this deck as far as the criteria can tell`,
  ].join('\n');
}

export function rankedSection(compiled: Compiled, run: OptimizeOutputs, top: number): string {
  const shown = run.ranked.slice(0, top);
  // Lines of the blank class cannot matter: one column holds them all.
  const relevant = lineIds(compiled, true);
  const blends = run.handSizes.length > 1;
  const header = [
    '#',
    'P',
    'exact',
    ...(blends
      ? run.handSizes.flatMap(({ H }) => [`going ${H === 5 ? 'first' : 'second'}`, `${H} exact`])
      : []),
    ...relevant.map(nameOf),
    'blank',
    'raw ratios',
  ];
  const rows = shown.map((entry, at) => {
    const copies = copiesByLine(compiled, entry.classTotals);
    return [
      String(at + 1),
      percent(entry.score.pDisplay),
      fraction(entry.blend),
      ...(blends
        ? entry.score.parts.flatMap((part) => [percent(part.num / part.den), fraction(part)])
        : []),
      ...relevant.map((id) => copies.get(id)!),
      String(entry.classTotals[0]),
      formatCount(entry.rawRatios),
    ];
  });
  const right = header.map((_, column) => column).filter((column) => column !== 2);
  return [
    `Ranked — the top ${shown.length} of ${int(run.done)} class vectors; equal scores are exact ties`,
    table([header, ...rows], right),
  ].join('\n');
}

export function plateauSection(run: OptimizeOutputs): string {
  const { plateau } = run;
  const points = (100 * plateau.delta.num) / plateau.delta.den;
  const atLeast = plateau.truncated ? 'at least ' : '';
  const size = `${plateau.sizeExact ? '' : 'at least '}${int(plateau.size)}`;
  const out = [
    `Plateau — within ${points} percentage point(s) of the best`,
    `  ${size} class vector(s) / ${atLeast}${formatCount(plateau.rawRatios)} raw ratio(s)`,
  ];
  if (plateau.truncated)
    out.push(
      `  only the best ${int(plateau.vectors.length)} are kept: the ranges below are theirs`,
    );
  const relevant = new Set(run.sweeps.map((sweep) => sweep.lineId));
  const ranges = plateau.lines
    .filter(({ lineId }) => relevant.has(lineId))
    .map(({ lineId, counts }) => [nameOf(lineId), formatCounts(counts)]);
  out.push(table([['line', 'copies across the plateau'], ...ranges]));
  return out.join('\n');
}

/** `0: 1.2%   1: 2.4%   2–3: 3.1% *` — neighbouring counts with the same exact score are one entry. */
function cellsRow(cells: readonly SweepCell[], argmax: readonly number[]): string {
  const runs: SweepCell[][] = [];
  for (const cell of cells) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (last?.count === cell.count - 1 && last.best.blend.num === cell.best.blend.num)
      run!.push(cell);
    else runs.push([cell]);
  }
  return runs
    .map((run) => {
      const [first] = run as [SweepCell, ...SweepCell[]];
      const counts = formatCounts(run.map((cell) => cell.count));
      return `${counts}: ${percent(first.best.score.pDisplay)}${argmax.includes(first.count) ? ' *' : ''}`;
    })
    .join('   ');
}

export function irrelevantSection(run: OptimizeOutputs): string {
  const out = ['Irrelevant lines — no requirement or limit can see their cards (PRD §5.6)'];
  const flat = run.irrelevant.filter((line) => line.flat);
  if (flat.length > 0)
    out.push(
      `  every count ties for the best: ${flat.map(({ lineId, min, max }) => `${nameOf(lineId)} (${min === max ? min : `${min}–${max}`})`).join(', ')}`,
    );
  for (const line of run.irrelevant.filter((l) => !l.flat)) {
    const bestNum = line.best.blend.num;
    const free = line.cells!.filter((cell) => cell.best.blend.num === bestNum).map((c) => c.count);
    out.push(
      `  ${nameOf(line.lineId)}: no loss at ${formatCounts(free)}; beyond, its cards crowd out ones that matter`,
    );
    // The remainder can take twenty counts and more: eight to a row.
    const entries = cellsRow(line.cells!, free).split('   ');
    for (let at = 0; at < entries.length; at += 8)
      out.push(`      ${entries.slice(at, at + 8).join('   ')}`);
  }
  if (run.irrelevant.length === 0) out.push('  (none)');
  return out.join('\n');
}

export function sweepsSection(run: OptimizeOutputs): string {
  const out = [
    'Sweeps — the best P with a line held at each count, everything else re-optimized (* = the best)',
  ];
  const rows = run.sweeps.map((sweep) => [
    nameOf(sweep.lineId),
    cellsRow(sweep.cells, sweep.argmax),
  ]);
  out.push(rows.length === 0 ? '  (no line matters)' : table(rows));
  return out.join('\n');
}

export function sweepDetailSection(
  lineId: string,
  cells: readonly SweepCell[] | undefined,
  argmax: readonly number[],
  fixed: readonly FixedSweepCell[],
  compiled: Compiled,
): string {
  const held = (count: number): string => {
    const cell = fixed.find((c) => c.count === count);
    return cell === undefined || !cell.feasible ? '-' : percent(cell.best.score.pDisplay);
  };
  const title = `Sweep of \`${nameOf(lineId)}\` — "held" keeps every other line at the best ratio, the remainder absorbing the difference`;
  if (cells === undefined)
    return [
      title,
      '  irrelevant: re-optimized, every count reaches the best',
      table([['copies', 'held'], ...fixed.map(({ count }) => [String(count), held(count)])], [1]),
    ].join('\n');
  // The lines of the blank class take whatever is left: they say nothing about the deck.
  const others = lineIds(compiled, true).filter((id) => id !== lineId);
  const rows = cells.map(({ count, best }) => {
    const copies = copiesByLine(compiled, best.classTotals);
    return [
      `${count}${argmax.includes(count) ? ' *' : ''}`,
      percent(best.score.pDisplay),
      fraction(best.blend),
      held(count),
      others.map((id) => `${nameOf(id)} ${copies.get(id)}`).join(', '),
    ];
  });
  return [
    title,
    table([['copies', 're-optimized', 'exact', 'held', 'the deck that does it'], ...rows], [1, 3]),
  ].join('\n');
}

export function breakdownSection(rows: readonly CriterionScore[], best: RankedVector): string {
  const blends = best.score.parts.length > 1;
  const parts = ({ score }: { score: BlendScore }) =>
    blends ? score.parts.flatMap((part) => [percent(part.num / part.den), fraction(part)]) : [];
  const body = rows.map((row) => [
    row.name === undefined ? row.id : `${row.id} (${row.name})`,
    percent(row.score.pDisplay),
    fraction(row.blend),
    ...parts(row),
  ]);
  body.push(['any of them', percent(best.score.pDisplay), fraction(best.blend), ...parts(best)]);
  return ['Per criterion — at the best ratio, each criterion by itself', table(body, [1])].join(
    '\n',
  );
}

export interface OptimizeReport {
  analysis: Analysis;
  templatePath: string;
  compiled: Compiled;
  run: OptimizeOutputs;
  partial: boolean;
  top: number;
  breakdown: readonly CriterionScore[];
  sweep?: {
    lineId: string;
    /** Absent for an irrelevant line whose every count ties. */
    cells?: readonly SweepCell[];
    argmax: readonly number[];
    fixed: readonly FixedSweepCell[];
  };
}

export function formatOptimizeReport(report: OptimizeReport): string {
  const { analysis: a, compiled, run } = report;
  const sections = [
    templateSection(a, report.templatePath),
    criteriaSection(a),
    matchingSection(a),
    classesSection(a),
    ...issueSections(a, ['warning', 'notice']),
    searchSection(run, report.partial),
    bestSection(compiled, run.best),
    rankedSection(compiled, run, report.top),
    plateauSection(run),
    irrelevantSection(run),
    sweepsSection(run),
    ...(report.sweep === undefined
      ? []
      : [
          sweepDetailSection(
            report.sweep.lineId,
            report.sweep.cells,
            report.sweep.argmax,
            report.sweep.fixed,
            compiled,
          ),
        ]),
    breakdownSection(report.breakdown, run.best),
  ];
  return `${sections.join('\n\n')}\n`;
}

export function formatNeedsConfirmation(
  total: Count,
  estimatedMs: number,
  message: string,
): string {
  return `optimize: nothing was scored — ${message}\n  ${formatCount(total)} class vectors, about ${formatDuration(estimatedMs)}; re-run with --force to go ahead\n`;
}
