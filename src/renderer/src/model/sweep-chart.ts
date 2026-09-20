import type { Fraction, LineSweep, SweepCell } from '../../../shared/types';
import { countsLabel, exactText, fractionText, partLines, percentText } from './run-format';

// The geometry of one line's sweep (PRD §5.6): copies across, the best
// probability reachable at that count up. Inline SVG, so there is no charting
// library to disagree with the engine.
//
// The arithmetic here places a PIXEL and nothing else. No number this file
// computes is ever shown as a number: every value on screen is `percentText`
// or `exactText` of the exact fraction the engine returned, and the best
// count is the engine's own `argmax`, never a maximum found here. Two cells
// with the same exact score therefore land on exactly the same height, which
// is what stops a tie looking like a slope.

export interface ChartBox {
  width: number;
  height: number;
  /** The inset the plot area leaves, so a point on an extreme is drawn whole. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A small multiple: one of these per relevant line, side by side. */
export const CHART_BOX: ChartBox = {
  width: 280,
  height: 120,
  left: 8,
  right: 8,
  top: 10,
  bottom: 20,
};

/** Past this many counts the tick labels would overlap, and only the ends and the best are kept. */
const LABEL_EVERY_UP_TO = 12;

export interface ChartPoint {
  count: number;
  x: number;
  y: number;
  percent: string;
  exact: string;
  /** The engine's argmax: a count at which the overall best is reached. */
  best: boolean;
  /**
   * `3 copies: 269,081 / 658,008 = 40.8933%` — and, over both hands, each
   * hand's own fraction after it: the two denominators differ, so the mean
   * alone would not say what either hand was.
   */
  title: string;
}

export interface ChartTick {
  count: number;
  x: number;
  /** A deck of this template can hold this many: a count with no cell cannot be built. */
  present: boolean;
  labelled: boolean;
}

export interface SweepChart {
  lineId: string;
  box: ChartBox;
  /** Nothing to draw: the template allows one count only. */
  single: boolean;
  points: ChartPoint[];
  /** One polyline per run of consecutive counts — a gap BREAKS the line rather than being drawn across. */
  segments: string[];
  ticks: ChartTick[];
  /** The y axis's ends. The chart is scaled to THIS line alone, which the labels are what discloses. */
  low: string;
  high: string;
  /** The axis starts at nothing, so a height may be read as a size; otherwise it may not. */
  zeroBased: boolean;
  /** `1`, `1–2`: every count the best is reached at. */
  bestAt: string;
}

/** Exact: `a − b` in sign, with no rounding to fall foul of. */
const compare = (a: Fraction, b: Fraction): number => a.num * b.den - b.num * a.den;

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * One line's sweep, ready to draw. The vertical axis spans this line's own
 * range and no more: a swing of half a percentage point is the answer to
 * "how many copies of X?" and would be invisible on a shared or zero-based
 * axis. That is why `low`, `high` and `zeroBased` come out with the geometry —
 * a chart that does not start at zero has to say so.
 */
export function sweepChart(sweep: LineSweep, box: ChartBox = CHART_BOX): SweepChart {
  const cells = sweep.cells;
  const plotWidth = box.width - box.left - box.right;
  const plotHeight = box.height - box.top - box.bottom;
  const first = cells[0];
  const last = cells.at(-1);
  if (first === undefined || last === undefined)
    return {
      lineId: sweep.lineId,
      box,
      single: true,
      points: [],
      segments: [],
      ticks: [],
      low: '',
      high: '',
      zeroBased: false,
      bestAt: countsLabel(sweep.argmax),
    };

  const lowest = cells.reduce(
    (low, cell) => (compare(cell.best.blend, low.best.blend) < 0 ? cell : low),
    first,
  );
  const highest = cells.reduce(
    (high, cell) => (compare(cell.best.blend, high.best.blend) > 0 ? cell : high),
    first,
  );
  // Every cell of a run is over ONE denominator (TDD §11.2), so the exact
  // numerators place the points; the quotient is only the fallback.
  const den = first.best.blend.den;
  const level = ({ num, den: own }: Fraction): number => (own === den ? num : (num / own) * den);
  const bottom = level(lowest.best.blend);
  const span = level(highest.best.blend) - bottom;
  const spread = last.count - first.count;

  const xOf = (count: number): number =>
    round(
      spread === 0
        ? box.left + plotWidth / 2
        : box.left + ((count - first.count) / spread) * plotWidth,
    );
  const yOf = (score: Fraction): number =>
    round(
      span === 0
        ? box.top + plotHeight / 2
        : box.top + (1 - (level(score) - bottom) / span) * plotHeight,
    );

  const argmax = new Set(sweep.argmax);
  const copies = (count: number): string => `${count} cop${count === 1 ? 'y' : 'ies'}`;
  const points = cells.map((cell: SweepCell): ChartPoint => {
    const best = argmax.has(cell.count);
    const percent = percentText(cell.best.blend);
    const exact = exactText(cell.best.blend);
    return {
      count: cell.count,
      x: xOf(cell.count),
      y: yOf(cell.best.blend),
      percent,
      exact,
      best,
      title: [
        `${copies(cell.count)}: ${fractionText(cell.best.blend)}`,
        ...partLines(cell.best.score).map(
          (part) => `${part.label}: ${part.exact} = ${part.percent}`,
        ),
        ...(best ? ['the best this template reaches'] : []),
      ].join(' — '),
    };
  });

  const segments: string[] = [];
  let run: ChartPoint[] = [];
  for (const point of points) {
    const previous = run.at(-1);
    if (previous !== undefined && previous.count !== point.count - 1) {
      segments.push(run.map((at) => `${at.x},${at.y}`).join(' '));
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) segments.push(run.map((at) => `${at.x},${at.y}`).join(' '));

  const held = new Set(cells.map((cell) => cell.count));
  const all = spread + 1 <= LABEL_EVERY_UP_TO;
  const ticks: ChartTick[] = [];
  for (let count = first.count; count <= last.count; count++)
    ticks.push({
      count,
      x: xOf(count),
      present: held.has(count),
      labelled: all || count === first.count || count === last.count || argmax.has(count),
    });

  return {
    lineId: sweep.lineId,
    box,
    single: cells.length === 1,
    points,
    segments: cells.length === 1 ? [] : segments,
    ticks,
    low: percentText(lowest.best.blend),
    high: percentText(highest.best.blend),
    zeroBased: lowest.best.blend.num === 0,
    bestAt: countsLabel(sweep.argmax),
  };
}
