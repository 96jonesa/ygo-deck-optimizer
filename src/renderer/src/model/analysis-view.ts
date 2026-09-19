import type {
  Analysis,
  AnalyzeTemplateResult,
  GroupAnalysis,
  Issue,
  LineAnalysis,
  Severity,
  Span,
} from '../../../shared/types';
import { rangeLabel } from './copy-range';
import { formatCount } from './run-format';

// Reading an `Analysis` for the screen. Everything the editor shows about what
// a template MEANS comes through here, and every function is a lookup or a
// sentence over what `analyze` already decided (TDD §9): no probability, no
// match, no total and no severity is worked out in the renderer.

export interface AnalysisView {
  /** The latest analysis, or the last one still worth showing; `null` before the first. */
  analysis: Analysis | null;
  /** Why the latest request produced no analysis; `null` when it did. */
  problem: string | null;
}

export const NO_ANALYSIS: AnalysisView = { analysis: null, problem: null };

/**
 * The view after one `template:analyze` reply. A reply that produced no
 * analysis KEEPS the one in hand and says why — a re-index is 68 ms (TDD §13)
 * and blanking every echo for it would throw away what the user was reading,
 * the same rule `selectShows` follows for the workspace itself.
 */
export function reduceAnalysis(view: AnalysisView, result: AnalyzeTemplateResult): AnalysisView {
  if (result.ok) return { analysis: result.analysis, problem: null };
  const problem =
    result.reason === 'invalid' ? [result.message, ...result.errors].join(' — ') : result.message;
  return { analysis: view.analysis, problem };
}

/** The analysis of one line, or `null`: the analysis lags an edit behind, so a new line has none yet. */
export function lineAnalysisOf(analysis: Analysis | null, id: string): LineAnalysis | null {
  return analysis?.lines.find((line) => line.id === id) ?? null;
}

export function groupAnalysisOf(analysis: Analysis | null, id: string): GroupAnalysis | null {
  return analysis?.groups.find((group) => group.id === id) ?? null;
}

const LOUDNESS: Record<Severity, number> = { notice: 0, warning: 1, error: 2 };

/** The loudest severity among the issues, or `null` when there are none. */
export function worstSeverity(issues: readonly Issue[]): Severity | null {
  let worst: Severity | null = null;
  for (const found of issues)
    if (worst === null || LOUDNESS[found.severity] > LOUDNESS[worst]) worst = found.severity;
  return worst;
}

/**
 * The class that colours an issue. A `notice` explains a rule at work — the
 * zero-match line of the motivating example is one — and must not be painted
 * as a failure (PRD §5.1).
 */
export function issueTone(severity: Severity | null): string {
  if (severity === null) return '';
  return severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : 'note';
}

/** What the description was understood as: `Level 4 or lower · Monster`. */
export function echoText(line: LineAnalysis | null): string | null {
  return line?.parsed.ok === true ? (line.parsed.echo ?? line.parsed.canonical) : null;
}

/**
 * What the card database says of the line: how many cards match and a few of
 * their names. A description matching nothing is a fact about today's card
 * pool, not a fault — said in those words, since the line is allowed to stand
 * (PRD §5.1).
 */
export function matchText(line: LineAnalysis | null): string | null {
  if (line === null || line.count === null) return null;
  if (line.count === 0) return 'no matching cards in the database';
  const cards = `${formatCount(line.count)} card${line.count === 1 ? '' : 's'}`;
  if (line.samples.length === 0) return cards;
  const more = line.count > line.samples.length ? ', …' : '';
  return `${cards}: ${line.samples.join(', ')}${more}`;
}

/** The parse error of a line, for marking the offending span in the input. */
export function parseFailureOf(line: LineAnalysis | null): { message: string; span: Span } | null {
  if (line === null || line.parsed.ok) return null;
  return { message: line.parsed.message, span: line.parsed.span };
}

/**
 * The issues to list beside a line. A parse failure reaches the analysis twice
 * — as `parsed` and as a `parse` issue — and is shown once, by the readout
 * that can also mark the span it is about.
 */
export function issuesToList(line: LineAnalysis | null): Issue[] {
  if (line === null) return [];
  return parseFailureOf(line) === null
    ? line.issues
    : line.issues.filter((found) => found.code !== 'parse');
}

/** `13–33`, or `null` when the ranges cannot fill the deck: the range as `analyze` computed it. */
export function remainderRange(analysis: Analysis | null): string | null {
  const range = analysis?.remainder.range;
  return range === undefined || range === null ? null : rangeLabel(range.min, range.max);
}

/** `Unspecified cards: 13–33` — never re-derived here, only read off the analysis. */
export function remainderText(analysis: Analysis | null): string | null {
  if (analysis === null) return null;
  const range = remainderRange(analysis);
  return range === null
    ? 'Unspecified cards: none — the ranges cannot fill the deck'
    : `Unspecified cards: ${range}`;
}

export interface KindTotalRow {
  kind: string;
  /** `Known monsters`. */
  label: string;
  /** `7–14`, or `null` when the ranges cannot sum to the deck size. */
  range: string | null;
  /** The lines that make it up, in template order. */
  lines: string[];
}

/** The derived read-only totals (PRD §6.4), in the engine's order. */
export function kindTotals(analysis: Analysis | null): KindTotalRow[] {
  return (analysis?.totals.kinds ?? []).map(({ kind, lines, range }) => ({
    kind,
    label: `Known ${kind}s`,
    range: range === null ? null : rangeLabel(range.min, range.max),
    lines: [...lines],
  }));
}

/** The errors of the template as a whole — the ranges not summing to the deck size, above all. */
export function templateErrorText(analysis: Analysis | null): string | null {
  const errors = (analysis?.issues ?? []).filter((found) => found.severity === 'error');
  return errors.length === 0 ? null : errors.map((found) => found.message).join(' · ');
}

/** `4,096 ratios · 128 scored`: the running count PRD §8.2 asks for. */
export function workText(analysis: Analysis | null): string | null {
  const work = analysis?.work;
  if (work === undefined || work.rawRatios === null || work.classVectors === null) return null;
  return `${formatCount(work.rawRatios)} ratios · ${formatCount(work.classVectors)} scored`;
}
