import type {
  Analysis,
  BlendScore,
  Count,
  Fraction,
  Issue,
  OptimizeProgress,
  RunConfirmation,
  RunResult,
  RunStartResult,
  Template,
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

/**
 * `7.0189%`: an exact fraction as a percentage, for the eye. Four places,
 * because ratios a fraction of a point apart is the whole point of scoring
 * exactly (PRD §2) — and the percentage is never what two scores are COMPARED
 * by: that is the numerator, which `topRows` and the sweeps use.
 */
export function percentText(fraction: Fraction): string {
  return `${((100 * fraction.num) / fraction.den).toFixed(4)}%`;
}

/**
 * `0.9317`: an exact fraction as an EXPECTED WEIGHT per hand — what a weighted
 * run reports instead of a percentage (PRD §5.6). It runs from 0 to the largest
 * weight in play, so it is not a share of anything and a `%` would be a lie.
 * Four places, for the same reason a percentage has four.
 */
export function weightText(fraction: Fraction): string {
  return (fraction.num / fraction.den).toFixed(4);
}

/**
 * The score as the run reports it: the expected weight where the criteria are
 * weighted, the probability as a percentage where they are not. Which of the
 * two it is comes off the RESULT (`weighted`), never off the template on
 * screen — a result stays put while the template is edited under it (TDD §3).
 */
export function scoreText(fraction: Fraction, weighted: boolean): string {
  return weighted ? weightText(fraction) : percentText(fraction);
}

/** What a run's headline number is CALLED: enough that no reader has to guess. */
export function scoreLabel(weighted: boolean): string {
  return weighted ? 'expected weight per hand' : 'P(at least one criterion)';
}

/** `46,185 / 658,008`: the fraction the ranking is actually done in. */
export function exactText({ num, den }: Fraction): string {
  return `${formatCount(num)} / ${formatCount(den)}`;
}

/** `46,185 / 658,008 = 7.0189%`: the exact answer, and the percentage it is. */
export function fractionText(fraction: Fraction): string {
  return `${exactText(fraction)} = ${percentText(fraction)}`;
}

/**
 * `3`, `2–3`, `0, 2–3`: a sorted set of counts with its runs collapsed. A GAP
 * stays a gap — `0, 2–3` is not `0–3`, and a line whose plateau skips a count
 * must not be read as covering it.
 */
export function countsLabel(counts: readonly number[]): string {
  const runs: string[] = [];
  for (let at = 0; at < counts.length; ) {
    let end = at;
    while (end + 1 < counts.length && counts[end + 1] === counts[end]! + 1) end++;
    runs.push(at === end ? `${counts[at]}` : `${counts[at]}–${counts[end]}`);
    at = end + 1;
  }
  return runs.join(', ');
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

/** One hand of a blended score, as it reads: `going first  41.5744%  273,563 / 658,008`. */
export interface ScoreLine {
  /** `going first`, or `going first × 3` when the weights are uneven. */
  label: string;
  /** The hand size, for a test or a tooltip that wants the number itself. */
  hand: number;
  /** The score this hand contributes, as shown: a percentage, or an expected weight. */
  value: string;
  exact: string;
  /** This hand's P(at least one criterion); the same number as `value` unless the run is weighted. */
  successPercent: string;
  successExact: string;
}

/**
 * The hands behind a blended score, in the order the engine reports them —
 * EMPTY for a run of one hand, whose single number IS the headline.
 *
 * Both are shown in full because their DENOMINATORS DIFFER: going first is
 * over C(N,5) and going second over C(N,6), so there is no one fraction that
 * says both, and picking one would be quietly showing the wrong one. The mean
 * beside them is the run's own exact `blend` — never an average worked out
 * here (TDD §3): nothing in the renderer computes a probability.
 */
export function partLines(score: BlendScore, weighted = false): ScoreLine[] {
  if (score.parts.length < 2) return [];
  const even = score.parts.every((part) => part.weight === score.parts[0]!.weight);
  return score.parts.map((part) => {
    const success = { num: part.successNum, den: part.den };
    return {
      label: `going ${part.H === 5 ? 'first' : 'second'}${even ? '' : ` × ${part.weight}`}`,
      hand: part.H,
      value: scoreText(part, weighted),
      exact: exactText(part),
      successPercent: percentText(success),
      successExact: exactText(success),
    };
  });
}

export interface TopRow {
  /** The vector's class totals, joined: what tells one row from another, since a tied rank does not. */
  key: string;
  /** Exactly tied rows share ONE rank: a tie is not an ordering. */
  rank: number;
  /** How many kept rows hold this same exact score; 1 when it stands alone. */
  tiedWith: number;
  /**
   * The score the row is RANKED by, as shown: the average when there are two
   * hands, and an expected weight rather than a percentage when the criteria
   * are weighted.
   */
  value: string;
  exact: string;
  /** P(at least one criterion) for the row; the same as `value` unless the run is weighted. */
  successPercent: string;
  successExact: string;
  /** Each hand on its own; empty for a run of one hand. */
  parts: ScoreLine[];
  /** One deck behind the row: a count per line, in the order of `result.lines`. */
  example: number[];
  /** How many raw line ratios are this row, as far as the criteria can tell. */
  rawRatios: string;
}

/**
 * The first `rows` of the ranked table. Two vectors tie iff their `blend.num`
 * are equal — every vector of a run is over one denominator (TDD §11.2) — so
 * the tie is read off the NUMERATOR and never off the percentage beside it,
 * which rounds two scores four places apart to the same four places. The tie's
 * size is counted over the whole kept table, so a tie running past the last
 * row on screen is still reported as one.
 */
export function topRows(result: RunResult, rows: number): TopRow[] {
  const tied = new Map<number, number>();
  const firstAt = new Map<number, number>();
  result.ranked.forEach((vector, at) => {
    const key = vector.blend.num;
    tied.set(key, (tied.get(key) ?? 0) + 1);
    if (!firstAt.has(key)) firstAt.set(key, at);
  });
  return result.ranked.slice(0, rows).map((vector, at) => ({
    key: vector.classTotals.join('-'),
    rank: (firstAt.get(vector.blend.num) ?? at) + 1,
    tiedWith: tied.get(vector.blend.num) ?? 1,
    value: scoreText(vector.blend, result.weighted),
    exact: exactText(vector.blend),
    successPercent: percentText(vector.success),
    successExact: exactText(vector.success),
    parts: partLines(vector.score, result.weighted),
    example: result.rankedRatios[at]?.example ?? [],
    rawRatios: formatCount(vector.rawRatios),
  }));
}

/** `128 of 128 class vectors · 4,096 raw ratios · hand of 5`: what the search covered. */
export function runStatsText(result: RunResult): string {
  const hands = result.handSizes
    .map(({ H, weight }) =>
      result.handSizes.length === 1 ? `hand of ${H}` : `hand of ${H} × ${weight}`,
    )
    .join(', ');
  return [
    `${formatCount(result.done)} of ${formatCount(result.total)} class vectors`,
    `${formatCount(result.rawRatios)} raw ratios`,
    hands,
  ].join(' · ');
}

/**
 * `32 raw ratios are this deck, as far as the criteria can tell`: the exact
 * tie a class vector stands for (TDD §11.2), so that a ratio reported as one
 * deck is not read as the only one.
 */
export function bestReachText(result: RunResult): string {
  const ratios = result.best.rawRatios;
  const one = ratios === 1;
  return `${formatCount(ratios)} raw ratio${one ? '' : 's'} ${one ? 'is' : 'are'} this deck, as far as the criteria can tell`;
}

/**
 * The sentence beside Run when nothing blocks it. The size and the estimate
 * are `analyze`'s own (TDD §9) and are read off it rather than worked out
 * again here; before the first reply the template alone is what there is to
 * say.
 */
export function readyText(template: Template, analysis: Analysis | null): string {
  const head = `Ready to score: ${template.lines.length} lines, ${template.criteria.length} criteria, deck of ${template.deckSize}.`;
  const work = analysis?.work;
  if (work === undefined || work.classVectors === null) return head;
  const ratios = work.rawRatios === null ? '' : ` over ${formatCount(work.rawRatios)} raw ratios`;
  const estimate = work.estimatedMs === null ? '' : `, ${about(work.estimatedMs)}`;
  return `${head} ${formatCount(work.classVectors)} class vectors${ratios}${estimate}.`;
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
