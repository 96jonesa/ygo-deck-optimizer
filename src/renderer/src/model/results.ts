import type {
  CriterionScore,
  IrrelevantLine,
  Rational,
  RunResult,
  SweepCell,
} from '../../../shared/types';
import { rangeLabel } from './copy-range';
import { countsLabel, exactText, formatCount, percentText } from './run-format';
import { deltaToPoints } from './settings-form';

// Reading a `RunResult` for the screen (PRD §5.6): the plateau, the lines that
// cannot matter, the per-criterion breakdown, and the two honesty notes that
// go with a number produced under limits.
//
// Nothing here computes a probability. Every score arrives as an exact
// fraction and is compared by its NUMERATOR — every vector of a run is over
// one denominator (TDD §11.2) — so an exact tie is shown as a tie and never
// as a rounding coincidence, and a number the result does not carry is not
// invented. The only arithmetic is turning a fraction into the percentage
// printed beside it.

/**
 * What each line is CALLED, by id — `Blue-Eyes White Dragon`, not `line3`. A
 * sweep chart answers "how many copies of X?" and has to name X.
 *
 * The names come off the RESULT, which main decorated from the template it
 * compiled for that run (`lineLabels` there). Not off the live analysis: a
 * result stays on screen while the template is edited, so labelling it from
 * what is on screen now would put today's names on yesterday's numbers. A run
 * that carried no name for a line falls back to the id, never to a blank.
 */
export function lineLabels(result: RunResult): Map<string, string> {
  return new Map(
    result.lines.map((line) => [line.id, line.label.trim() === '' ? line.id : line.label]),
  );
}

/** One label out of that map; a line the run did not have keeps its id. */
export function labelOf(labels: ReadonlyMap<string, string>, id: string): string {
  return labels.get(id) ?? id;
}

/**
 * `Blue-Eyes White…`: a label cut to fit a column that cannot widen — the
 * ranked table sizes to its contents, so CSS ellipsis would never trigger
 * there; it would just push the table wider. Cut at a word boundary when
 * there is a usable one. The whole label goes in the cell's `title`.
 */
export function shortLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  const cut = label.slice(0, max - 1);
  // The cut already fell between two words: there is no part-word to trim.
  if (label[max - 1] === ' ') return `${cut.trimEnd()}…`;
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The plateau's width as the user says it: `0.5` percentage points. */
export function pointsText(delta: Rational): string {
  return deltaToPoints(delta.num / delta.den);
}

const plural = (n: number, word: string): string =>
  `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

export interface PlateauLineRow {
  lineId: string;
  /** `1–2`, `0, 2–3`: every count the line takes across the plateau's vectors. */
  counts: string;
}

export interface PlateauView {
  /** The width the RUN used, in percentage points — not whatever the setting says now. */
  points: string;
  /** `2 class vectors · 2 raw ratios`, hedged wherever the figure is a bound. */
  size: string;
  /** Said when only the best few vectors were kept, because the ranges are then theirs. */
  truncated: string | null;
  /** The lines a criterion can see; the rest take whatever is left and say nothing. */
  lines: PlateauLineRow[];
}

/**
 * The plateau (PRD §5.6): every ratio within δ of the best, as the range of
 * copies each line takes across it — "2 or 3 copies are equally fine" is the
 * answer worth having. `size` stays exact under truncation (TDD §11.2), so a
 * truncated plateau reports its true size and says that the ranges below it
 * are only those of the vectors kept.
 */
export function plateauView(result: RunResult): PlateauView {
  const { plateau } = result;
  const relevant = new Set(result.sweeps.map((sweep) => sweep.lineId));
  const vectors = `${plateau.sizeExact ? '' : 'at least '}${plural(plateau.size, 'class vector')}`;
  const ratios = `${plateau.truncated ? 'at least ' : ''}${formatCount(plateau.rawRatios)} raw ratio${plateau.rawRatios === 1 ? '' : 's'}`;
  return {
    points: pointsText(plateau.delta),
    size: `${vectors} · ${ratios}`,
    truncated: plateau.truncated
      ? `Only the best ${formatCount(plateau.vectors.length)} were kept, so the copies below are theirs.`
      : null,
    lines: plateau.lines
      .filter(({ lineId }) => relevant.has(lineId))
      .map(({ lineId, counts }) => ({ lineId, counts: countsLabel(counts) })),
  };
}

export interface BreakdownRow {
  id: string;
  /** The name the RUN had for it, else its id — never what the editor calls it NOW. */
  label: string;
  percent: string;
  exact: string;
}

/**
 * Each TEMPLATE criterion's own exact probability at the best ratio (PRD
 * §5.6). The engine scores each as a problem of its own precisely because the
 * compiled criteria are the flat alternatives of all of them together, whose
 * indices are not the template's (see `breakdown`) — so a row is found by its
 * `id` here too, never by its position.
 */
export function breakdownRows(result: RunResult): BreakdownRow[] {
  return result.breakdown.map(({ id, name, blend }: CriterionScore) => ({
    id,
    label: name ?? id,
    percent: percentText(blend),
    exact: exactText(blend),
  }));
}

export interface CellRun {
  /** `13–23`: the counts this one score covers. */
  counts: string;
  percent: string;
  exact: string;
  /** This run reaches the overall best. */
  best: boolean;
}

/**
 * A sweep's cells as reading matter: neighbouring counts of the SAME exact
 * score are one entry. A gap — a count no valid deck can hold — starts a new
 * entry rather than being swallowed into the run beside it.
 */
export function cellRuns(cells: readonly SweepCell[], bestNum: number): CellRun[] {
  const runs: SweepCell[][] = [];
  for (const cell of cells) {
    const last = runs.at(-1)?.at(-1);
    if (
      last !== undefined &&
      last.count === cell.count - 1 &&
      last.best.blend.num === cell.best.blend.num
    )
      runs.at(-1)!.push(cell);
    else runs.push([cell]);
  }
  return runs.map((run) => {
    const [first] = run as [SweepCell, ...SweepCell[]];
    return {
      counts: countsLabel(run.map((cell) => cell.count)),
      percent: percentText(first.best.blend),
      exact: exactText(first.best.blend),
      best: first.best.blend.num === bestNum,
    };
  });
}

export interface IrrelevantRow {
  lineId: string;
  /** No count costs anything: the line only trades copies with the remainder. */
  flat: boolean;
  /** `0–7`: the counts it takes across the scored decks. */
  range: string;
  /** Not flat: the counts that still reach the best — `13–23`. */
  free: string | null;
  /** Not flat: what every count is actually worth. */
  cells: CellRun[];
}

/**
 * The lines no requirement or limit can see (PRD §5.6) — with M1c's
 * correction: such a line is free only while the blank class can absorb it.
 * Past that its cards crowd out ones that matter, and the engine says so by
 * sending `flat: false` and the cells. Where that happens the cells are shown
 * rather than the line being called irrelevant.
 */
export function irrelevantRows(result: RunResult): IrrelevantRow[] {
  return result.irrelevant.map((line: IrrelevantLine) => {
    const range = line.min === line.max ? `${line.min}` : `${line.min}–${line.max}`;
    if (line.flat || line.cells === undefined)
      return { lineId: line.lineId, flat: line.flat, range, free: null, cells: [] };
    const bestNum = line.best.blend.num;
    const free = line.cells.filter((cell) => cell.best.blend.num === bestNum);
    return {
      lineId: line.lineId,
      flat: false,
      range,
      free: countsLabel(free.map((cell) => cell.count)),
      cells: cellRuns(line.cells, bestNum),
    };
  });
}

export interface BlindLimit {
  /** `at most 1x #89631139`. */
  heading: string;
  /** `1–22`: how many cards it cannot see. */
  range: string;
  /** The lines holding them. */
  lines: string[];
}

export interface LimitsNote {
  reading: string;
  /** Per limit that cannot see some cards; empty when every line is specific enough. */
  blind: BlindLimit[];
}

/**
 * The footnote PRD §6.3 asks for, read off the RUN. Without limits the
 * reported number is a guaranteed lower bound and needs no caveat; WITH them it is exact only
 * under the tool's one matching rule, and a deck whose under-specified cards
 * really do match the limit would do worse. Said once, quietly, beside the
 * number — the gap is pointed at, never guessed at.
 */
export function limitsNote(result: RunResult): LimitsNote | null {
  if (result.criterionLimits.length === 0) return null;
  return {
    reading:
      'A card counts against a limit only where its line is specific enough to be known to match, so this figure is exact under that reading rather than a bound on any concrete deck.',
    blind: result.criterionLimits
      .filter((limit) => limit.blindRange !== null)
      .map((limit) => ({
        heading: `${limit.counts.map((n) => (n === 0 ? 'no' : `at most ${n}x`)).join(' / ')} ${limit.text}`,
        range: rangeLabel(limit.blindRange!.min, limit.blindRange!.max),
        lines: limit.blind.map((line) => line.label),
      })),
  };
}

export interface DroppedLimitRow {
  /** `at most 1x trap`, or `no trap`. */
  heading: string;
  why: string;
}

const WHY: Record<'counts-nothing' | 'never-binds', string> = {
  'counts-nothing': 'no line counts against it, so it holds of every hand',
  'never-binds': 'a hand cannot hold that many, so it holds of every hand',
};

/**
 * Limits the engine left out of the scoring because they hold of every hand.
 * One limit is said once however many flat alternatives it reached: the
 * indices the analysis files them under are the compiled criteria's, not the
 * template's, so they name nothing the reader would recognise.
 */
export function droppedLimitRows(result: RunResult): DroppedLimitRow[] {
  const seen = new Set<string>();
  const rows: DroppedLimitRow[] = [];
  for (const { text, n, reason } of result.droppedLimits) {
    const key = `${n}:${reason}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ heading: n === 0 ? `no ${text}` : `at most ${n}x ${text}`, why: WHY[reason] });
  }
  return rows;
}
