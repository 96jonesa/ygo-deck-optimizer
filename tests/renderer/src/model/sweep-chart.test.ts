import { describe, expect, it } from 'vitest';
import { CHART_BOX, sweepChart } from '../../../../src/renderer/src/model/sweep-chart';
import type { LineSweep, SweepCell } from '../../../../src/shared/types';

const DEN = 658_008;

/** A cell at `count` worth `num / 658,008`; the witness deck is never read by the chart. */
function cell(count: number, num: number): SweepCell {
  return {
    count,
    best: { classTotals: [], score: { parts: [], pDisplay: num / DEN }, blend: { num, den: DEN } },
  };
}

function sweepOf(cells: SweepCell[], argmax: number[], lineId = 'brick'): LineSweep {
  return { lineId, cls: 3, cells, argmax };
}

/** The brick example's own sweep: 41.5744% at one copy, falling to 40.8933% at three. */
const BRICK = sweepOf([cell(1, 273_563), cell(2, 272_039), cell(3, 269_081)], [1]);

describe('sweepChart', () => {
  it('places every count on the x axis and every score on the y, best at the top', () => {
    const chart = sweepChart(BRICK);
    expect(chart.lineId).toBe('brick');
    expect(chart.single).toBe(false);
    expect(chart.points).toEqual([
      {
        count: 1,
        x: 8,
        y: 10,
        percent: '41.5744%',
        exact: '273,563 / 658,008',
        best: true,
        title: '1 copy: 273,563 / 658,008 = 41.5744% — the best this template reaches',
      },
      {
        count: 2,
        x: 140,
        y: 40.6,
        percent: '41.3428%',
        exact: '272,039 / 658,008',
        best: false,
        title: '2 copies: 272,039 / 658,008 = 41.3428%',
      },
      {
        count: 3,
        x: 272,
        y: 100,
        percent: '40.8933%',
        exact: '269,081 / 658,008',
        best: false,
        title: '3 copies: 269,081 / 658,008 = 40.8933%',
      },
    ]);
  });

  it('labels the axis with this line’s OWN range, and says it does not start at zero', () => {
    const chart = sweepChart(BRICK);
    expect(chart.low).toBe('40.8933%');
    expect(chart.high).toBe('41.5744%');
    expect(chart.zeroBased).toBe(false);
  });

  it('is zero-based when a count really does reach nothing', () => {
    const chart = sweepChart(sweepOf([cell(0, 0), cell(1, 15_521), cell(2, 46_185)], [2]));
    expect(chart.zeroBased).toBe(true);
    expect(chart.low).toBe('0.0000%');
  });

  it('draws one unbroken polyline over consecutive counts', () => {
    expect(sweepChart(BRICK).segments).toEqual(['8,10 140,40.6 272,100']);
  });

  it('BREAKS the line at a count no deck can hold, rather than drawing across the gap', () => {
    const chart = sweepChart(sweepOf([cell(0, 100), cell(1, 200), cell(3, 300)], [3]));
    expect(chart.segments).toHaveLength(2);
    expect(chart.segments[1]?.split(' ')).toHaveLength(1);
    expect(chart.points.map((point) => point.count)).toEqual([0, 1, 3]);
  });

  it('marks the impossible count on the axis instead of leaving it out', () => {
    const chart = sweepChart(sweepOf([cell(0, 100), cell(1, 200), cell(3, 300)], [3]));
    expect(chart.ticks).toEqual([
      { count: 0, x: 8, present: true, labelled: true },
      { count: 1, x: 96, present: true, labelled: true },
      { count: 2, x: 184, present: false, labelled: true },
      { count: 3, x: 272, present: true, labelled: true },
    ]);
  });

  it('thins the tick labels once there are more counts than fit, keeping the ends and the best', () => {
    const cells = Array.from({ length: 20 }, (_, at) => cell(at, 100 + at));
    const chart = sweepChart(sweepOf(cells, [7]));
    expect(chart.ticks.filter((tick) => tick.labelled).map((tick) => tick.count)).toEqual([
      0, 7, 19,
    ]);
  });

  it('takes the best count from the engine’s argmax, never from a maximum of its own', () => {
    // A deliberately inconsistent sweep: the largest value is at 3, the engine
    // says 2. The engine wins — a second opinion here would silently disagree.
    const chart = sweepChart(sweepOf([cell(1, 100), cell(2, 200), cell(3, 300)], [2]));
    expect(chart.bestAt).toBe('2');
    expect(chart.points.map((point) => point.best)).toEqual([false, true, false]);
  });

  it('names every count the best is reached at', () => {
    expect(sweepChart(sweepOf([cell(1, 300), cell(2, 300), cell(3, 100)], [1, 2])).bestAt).toBe(
      '1–2',
    );
  });

  it('gives two exactly equal scores the same height, so a tie cannot look like a slope', () => {
    const chart = sweepChart(sweepOf([cell(1, 300), cell(2, 300), cell(3, 100)], [1, 2]));
    expect(chart.points[0]?.y).toBe(chart.points[1]?.y);
  });

  it('puts a sweep that is flat throughout down the middle rather than dividing by nothing', () => {
    const chart = sweepChart(sweepOf([cell(1, 300), cell(2, 300)], [1, 2]));
    expect(chart.points.map((point) => point.y)).toEqual([55, 55]);
    expect(chart.low).toBe(chart.high);
  });

  it('has no shape to draw when the template allows one count only', () => {
    const chart = sweepChart(sweepOf([cell(5, 46_185)], [5], 'monster'));
    expect(chart.single).toBe(true);
    expect(chart.segments).toEqual([]);
    expect(chart.points).toHaveLength(1);
    expect(chart.points[0]?.percent).toBe('7.0189%');
  });

  it('draws inside the box it is given', () => {
    const box = { ...CHART_BOX, width: 400, height: 200 };
    const chart = sweepChart(BRICK, box);
    expect(chart.box).toEqual(box);
    expect(chart.points.map((point) => point.x)).toEqual([8, 200, 392]);
    expect(chart.points.map((point) => point.y)).toEqual([10, 67.8, 180]);
  });
});
