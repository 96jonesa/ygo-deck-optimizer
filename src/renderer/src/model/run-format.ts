import type {
  Count,
  Fraction,
  Issue,
  OptimizeProgress,
  RunConfirmation,
  RunResult,
  RunStartResult,
} from '../../../shared/types';

// How a run reads on screen. Pure text: the renderer holds no core code (TDD
// §3), so the little of it that is needed to show a count lives here.

/** `658,008`; past 2^53 a count arrives as exact digits, and reads `about 9.00 × 10^15`. */
export function formatCount(count: Count): string {
  if (typeof count === 'number') return count.toLocaleString('en-US');
  return `about ${count[0]}.${count.slice(1, 3)} × 10^${count.length - 1}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) return 'under 1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  const days = Math.round(seconds / 86_400);
  return `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`;
}

/** An estimate: `about 3.0 s` — but `under 1 ms` is already vague enough. */
function about(ms: number): string {
  return ms < 1 ? formatDuration(ms) : `about ${formatDuration(ms)}`;
}

function percent({ num, den }: Fraction): string {
  return `${((100 * num) / den).toFixed(4)}%`;
}

/** `46,185 / 658,008 = 7.0189%`: the exact answer, and the percentage it is. */
export function fractionText(fraction: Fraction): string {
  return `${formatCount(fraction.num)} / ${formatCount(fraction.den)} = ${percent(fraction)}`;
}

/** `32 / 128 (25.0%) · 1.0 s elapsed · about 3.0 s left`. */
export function progressLine({ done, total, elapsedMs, etaMs }: OptimizeProgress): string {
  const share = ((100 * done) / Number(total)).toFixed(1);
  const head = `${formatCount(done)} / ${formatCount(total)} (${share}%) · ${formatDuration(elapsedMs)} elapsed`;
  return etaMs > 0 ? `${head} · ${about(etaMs)} left` : head;
}

/** What "Run anyway" is a yes to. */
export function confirmationLine({ reason, total, estimatedMs }: RunConfirmation): string {
  const uncountable = reason === 'unsafe-count' ? ' — more than can be counted off —' : '';
  return `This search scores ${formatCount(total)} class vectors${uncountable} and would take ${about(estimatedMs)}.`;
}

export interface BestRatioRow {
  lineId: string;
  /** `3`, or `0–7` when the line's class can split its total among several lines. */
  copies: string;
  /** On the first line of a class that can split: `8 copies among …— any split`. */
  note: string;
}

/** The best ratio as line counts, in template order: what the vector fixes, and what it leaves open. */
export function bestRatioRows(result: RunResult): BestRatioRow[] {
  const intervals = new Map<string, { min: number; max: number }>();
  const notes = new Map<string, string>();
  for (const cls of result.bestRatio.classes) {
    for (const line of cls.lines) intervals.set(line.id, line);
    const [first] = cls.lines;
    if (first !== undefined && cls.lines.length > 1) notes.set(first.id, cls.text);
  }
  return result.lines.map((line, at) => {
    const interval = intervals.get(line.id);
    const copies =
      interval === undefined
        ? String(result.bestRatio.example[at] ?? 0)
        : interval.min === interval.max
          ? String(interval.min)
          : `${interval.min}–${interval.max}`;
    return { lineId: line.id, copies, note: notes.get(line.id) ?? '' };
  });
}

export interface TopRow {
  rank: number;
  percent: string;
  exact: string;
  /** One deck behind the row: a count per line, in the order of `result.lines`. */
  example: number[];
  /** How many raw line ratios are this row, as far as the criteria can tell. */
  rawRatios: string;
}

export function topRows(result: RunResult, rows: number): TopRow[] {
  return result.ranked.slice(0, rows).map((vector, at) => ({
    rank: at + 1,
    percent: percent(vector.blend),
    exact: `${formatCount(vector.blend.num)} / ${formatCount(vector.blend.den)}`,
    example: result.rankedRatios[at]?.example ?? [],
    rawRatios: formatCount(vector.rawRatios),
  }));
}

/** Why `run:start` started nothing, line by line; empty when it did start. */
export function startFailureLines(result: RunStartResult): string[] {
  if (result.ok) return [];
  if (result.reason === 'not-ready') return [result.message];
  if (result.reason === 'invalid') return [result.message, ...result.errors];
  const { analysis } = result;
  const errors = (where: string, issues: readonly Issue[]) =>
    issues.filter((issue) => issue.severity === 'error').map((issue) => `${where}${issue.message}`);
  return [
    'The template has errors; nothing was run.',
    ...errors('', analysis.issues),
    ...analysis.lines.flatMap((line) => errors(`line ${line.id}: `, line.issues)),
    ...errors('remainder: ', analysis.remainder.issues),
    ...analysis.groups.flatMap((group) => errors(`group ${group.id}: `, group.issues)),
    ...analysis.requirements.flatMap((req) => errors(`requirement ${req.text}: `, req.issues)),
    ...analysis.limits.flatMap((limit) => errors(`limit ${limit.text}: `, limit.issues)),
    ...analysis.criteria.flatMap((criterion) =>
      errors(`criterion ${criterion.id}: `, criterion.issues),
    ),
  ];
}
