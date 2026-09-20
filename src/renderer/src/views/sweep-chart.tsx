import type { LineSweep } from '../../../shared/types';
import { labelOf } from '../model/results';
import { sweepChart } from '../model/sweep-chart';

// The copies-vs-odds sweep (PRD §5.6), drawn as inline SVG — the direct answer
// to "how many copies of X?".
//
// Small multiples, one per line, rather than one chart behind a line selector:
// a 40-card list is tuned by weighing several lines against each other at once
// (PRD §3), and a selector turns that into a memory exercise. The cost of the
// choice is that each chart is scaled to its own range — it has to be, since a
// line that swings half a percentage point would be a flat line on any axis
// wide enough for a line that swings thirty — so every chart states the two
// ends of its own axis, and the note above the grid says the scales differ.
//
// Dots joined by a line, not bars: a bar's LENGTH is its value, so a bar chart
// may not leave out zero, and one that includes zero would show none of the
// differences that matter here. A dot's position may.

function Chart({ sweep, name }: { sweep: LineSweep; name: string }) {
  const chart = sweepChart(sweep);
  const { box } = chart;
  const floor = box.height - box.bottom;
  const described = `${name}: the best probability at each number of copies, from ${chart.low} to ${chart.high}, best at ${chart.bestAt}`;

  return (
    <figure className="chart" data-testid={`sweep-${sweep.lineId}`}>
      {/* The NAME, not the line id: a chart that cannot say what it is
          charting does not answer "how many copies of X?". The id stays as
          the test id and the key. A long name ellipsises and keeps the whole
          of itself, and the line it belongs to, in the tooltip. */}
      <figcaption title={`${name} — line ${sweep.lineId}`}>
        <span className="chart-name">{name}</span>{' '}
        <span className="dim">
          best at <strong>{chart.bestAt}</strong>
        </span>
      </figcaption>

      {chart.single ? (
        <p className="chart-single">
          Fixed at {chart.points[0]?.count} — the template allows no other count.
        </p>
      ) : (
        <div className="chart-body">
          <div className="chart-axis tabular">
            <span>{chart.high}</span>
            <span>{chart.low}</span>
          </div>
          <svg
            className="sweep"
            viewBox={`0 0 ${box.width} ${box.height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={described}
          >
            <line className="rule" x1={0} y1={box.top} x2={box.width} y2={box.top} />
            <line className="rule" x1={0} y1={floor} x2={box.width} y2={floor} />
            {chart.segments.map((points) => (
              <polyline key={points} className="trend" points={points} />
            ))}
            {chart.ticks.map((tick) => (
              <line
                key={tick.count}
                className={tick.present ? 'tick' : 'tick missing'}
                x1={tick.x}
                y1={floor}
                x2={tick.x}
                y2={floor + 4}
              />
            ))}
            {chart.points.map((point) => (
              <circle
                key={point.count}
                className={point.best ? 'dot best' : 'dot'}
                cx={point.x}
                cy={point.y}
                r={point.best ? 4 : 2.5}
              >
                <title>{point.title}</title>
              </circle>
            ))}
            {chart.ticks
              .filter((tick) => tick.labelled)
              .map((tick) => (
                <text
                  key={tick.count}
                  className={tick.present ? 'tick-label' : 'tick-label missing'}
                  x={tick.x}
                  y={box.height - 4}
                  textAnchor="middle"
                >
                  {tick.count}
                </text>
              ))}
          </svg>
        </div>
      )}

      {/*
        The numbers themselves, because a shape is not a figure anyone can
        cite (PRD §3) — and because a count no deck can hold is absent here
        exactly as it is absent from the line above.
      */}
      <p className="chart-values tabular" data-testid={`sweep-${sweep.lineId}-values`}>
        {chart.points.map((point) => (
          <span key={point.count} className={point.best ? 'cell best' : 'cell'}>
            <span className="dim">{point.count}:</span> {point.percent}
          </span>
        ))}
      </p>
    </figure>
  );
}

export function SweepCharts({
  sweeps,
  labels,
}: {
  sweeps: readonly LineSweep[];
  labels: ReadonlyMap<string, string>;
}) {
  if (sweeps.length === 0)
    return (
      <p className="seam" data-testid="no-sweeps">
        No line matters to these criteria, so there is nothing to sweep.
      </p>
    );
  return (
    <div className="charts" data-testid="sweeps">
      {sweeps.map((sweep) => (
        <Chart key={sweep.lineId} sweep={sweep} name={labelOf(labels, sweep.lineId)} />
      ))}
    </div>
  );
}
