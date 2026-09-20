import { useState } from 'react';
import type { RunResult } from '../../../shared/types';
import {
  type BreakdownRow,
  breakdownRows,
  droppedLimitRows,
  type IrrelevantRow,
  irrelevantRows,
  labelOf,
  limitsNote,
  lineLabels,
  plateauView,
  shortLabel,
} from '../model/results';
import {
  bestRatioRows,
  bestReachText,
  confirmationLine,
  exactText,
  formatCount,
  percentText,
  progressLine,
  runStatsText,
  startFailureLines,
  topRows,
} from '../model/run-format';
import { deltaFromPoints, deltaToPoints } from '../model/settings-form';
import { selectRunnable, selectRunSentence, useApp } from '../store';
import { SweepCharts } from './sweep-chart';

// The results region (PRD §8.4): the answer the whole tool exists to give.
// Everything on screen is READ off the `RunResult` the worker sent — the
// renderer holds no core code (TDD §3) and works out no probability, no tie,
// no argmax and no plateau of its own. Where a figure would have to be
// derived it is left out rather than guessed at, since a number computed here
// would disagree with the engine sooner or later and nothing would say which
// was wrong.

/** The rows of the ranked table shown before "show all" is pressed. */
const TOP_ROWS = 10;

function Heading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <>
      <h3>{children}</h3>
      {note !== undefined && <p className="hint flush">{note}</p>}
    </>
  );
}

/**
 * The best ratio: the percentage large, the exact fraction beside it, and the
 * copies per line. The fraction is not decoration — two ratios a ten-thousandth
 * of a point apart are ranked by it (PRD §4.3), so it is what a reader quotes.
 */
/** The widest a ranked column's heading may be before it is cut; the whole name stays in its tooltip. */
const COLUMN_CHARS = 16;

function BestRatio({ result }: { result: RunResult }) {
  const labels = lineLabels(result);
  return (
    <div className="headline" data-testid="run-headline">
      <p className="headline-label">
        {result.partial ? 'Best of what was scored' : 'Best ratio'}
        <span className="dim"> — P(at least one criterion)</span>
      </p>
      <p className="headline-value">
        <strong className="big tabular" data-testid="run-best-percent">
          {percentText(result.best.blend)}
        </strong>
        <span className="exact tabular" data-testid="run-best">
          {exactText(result.best.blend)} exactly
        </span>
      </p>
      <table className="rows tight best-lines" data-testid="best-lines">
        <tbody>
          {bestRatioRows(result).map((row) => (
            <tr key={row.lineId} data-testid={`best-line-${row.lineId}`}>
              <th
                className="line-name"
                title={`${labelOf(labels, row.lineId)} — line ${row.lineId}`}
              >
                {labelOf(labels, row.lineId)}
              </th>
              <td className="num">{row.copies}</td>
              <td className="note">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint flush tabular" data-testid="run-stats">
        {runStatsText(result)} · {bestReachText(result)}
      </p>
    </div>
  );
}

/**
 * PRD §6.3: with a limit in play the number is exact under one reading, and
 * can flatter a real deck. Read off the RUN — a caveat has to be true of the
 * number it sits under, whatever the editor says by the time it is read.
 */
function LimitsFootnote({ result }: { result: RunResult }) {
  const note = limitsNote(result);
  if (note === null) return null;
  return (
    <div className="foot" data-testid="limits-note">
      <p>{note.reading}</p>
      {note.blind.map((limit) => (
        <p key={limit.heading}>
          <code>{limit.heading}</code> cannot see <strong className="tabular">{limit.range}</strong>{' '}
          cards, on {limit.lines.map((line) => line).join(', ')}: if some of those really do match,
          a concrete deck does worse than this.
        </p>
      ))}
    </div>
  );
}

function Ranked({ result }: { result: RunResult }) {
  const [all, setAll] = useState(false);
  const kept = result.ranked.length;
  const rows = topRows(result, all ? kept : TOP_ROWS);
  const blank = new Set(result.lines.filter((line) => line.cls === 0).map((line) => line.id));
  const labels = lineLabels(result);

  return (
    <>
      <Heading note="Equal scores are EXACT ties, not a rounding coincidence: tied ratios share one rank.">
        Ranked ratios
      </Heading>
      <div className="scroll-x">
        <table className="rows ranked tight" data-testid="run-top">
          <thead>
            <tr>
              <th>#</th>
              <th>P</th>
              <th>exact</th>
              {result.lines.map((line) => (
                // A column cannot widen — the table sizes to its contents —
                // so the name is cut here rather than by CSS, and kept whole,
                // with the line it is, in the tooltip.
                <th
                  key={line.id}
                  className={blank.has(line.id) ? 'dim' : ''}
                  title={`${labelOf(labels, line.id)} — line ${line.id}`}
                >
                  {shortLabel(labelOf(labels, line.id), COLUMN_CHARS)}
                </th>
              ))}
              <th>ratios</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, at) => (
              // A tie has one rank, so the rank cannot be the key: the vector is.
              <tr key={row.key} data-testid={`top-row-${at + 1}`}>
                <td className="num">
                  {row.tiedWith > 1 ? (
                    <span className="tie" title={`an exact ${row.tiedWith}-way tie`}>
                      ={row.rank}
                    </span>
                  ) : (
                    row.rank
                  )}
                </td>
                <td className="num">{row.percent}</td>
                <td className="num">{row.exact}</td>
                {result.lines.map((line, column) => (
                  <td key={line.id} className={blank.has(line.id) ? 'num dim' : 'num'}>
                    {row.example[column]}
                  </td>
                ))}
                <td className="num dim">{row.rawRatios}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint trailing">
        {all ? kept : Math.min(TOP_ROWS, kept)} of {formatCount(kept)} kept
        {kept >= result.limits.topK &&
          ` (the top ${formatCount(result.limits.topK)} of the search)`}
        .{' '}
        {blank.size > 0 && (
          <>
            The dim columns are lines no criterion can see: their counts are one split of several
            that score the same.{' '}
          </>
        )}
        {kept > TOP_ROWS && (
          <button
            type="button"
            className="link"
            data-testid="show-all"
            onClick={() => setAll(!all)}
          >
            {all ? 'Show the top 10' : `Show all ${formatCount(kept)}`}
          </button>
        )}
      </p>
    </>
  );
}

/**
 * The plateau (PRD §5.6). "2 or 3 copies are equally fine" is the useful
 * answer, so the ranges come first; δ is the user's to set, in the percentage
 * points they would say it in, and the plateau on screen keeps saying which δ
 * IT was computed under until a new run replaces it.
 */
function Plateau({ result, onRun }: { result: RunResult; onRun: () => void }) {
  const labels = lineLabels(result);
  const settings = useApp((state) => state.settings);
  const store = useApp((state) => state.setSettings);
  const [typed, setTyped] = useState<string | null>(null);

  const view = plateauView(result);
  const setting = settings === null ? view.points : deltaToPoints(settings.plateauDelta);
  const shown = typed ?? setting;
  const width = deltaFromPoints(shown);
  const stale = width !== null && setting !== view.points;

  function save(): void {
    setTyped(null);
    if (width === null || settings === null || width === settings.plateauDelta) return;
    void window.api.setSettings({ plateauDelta: width }).then(store);
  }

  return (
    <>
      <div className="plateau-head">
        <h3>Plateau</h3>
        <label htmlFor="plateau-delta">within</label>
        <input
          type="text"
          id="plateau-delta"
          className="count wide"
          data-testid="plateau-delta"
          value={shown}
          inputMode="decimal"
          aria-invalid={width === null}
          aria-describedby="plateau-delta-note"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          onBlur={save}
        />
        <span className="dim">percentage points of the best</span>
      </div>
      <p className="hint flush" id="plateau-delta-note" data-testid="plateau-delta-note">
        {width === null ? (
          <span className="bad">A width between 0 and 100 percentage points.</span>
        ) : stale ? (
          <>
            The plateau below was computed at <strong>{view.points}</strong> points.{' '}
            <button type="button" className="link" data-testid="plateau-rerun" onClick={onRun}>
              Run again
            </button>{' '}
            to use {shown}.
          </>
        ) : (
          'Every ratio this close to the best: for practical purposes they are as good as each other.'
        )}
      </p>

      <div className="readout" data-testid="plateau">
        <p className="tabular" data-testid="plateau-size">
          {view.size} within <strong>{view.points}</strong> percentage points
        </p>
        {view.truncated !== null && (
          <p className="dim" data-testid="plateau-truncated">
            {view.truncated}
          </p>
        )}
        <table className="rows tight">
          <tbody>
            {view.lines.map((row) => (
              <tr key={row.lineId} data-testid={`plateau-line-${row.lineId}`}>
                <th
                  className="line-name"
                  title={`${labelOf(labels, row.lineId)} — line ${row.lineId}`}
                >
                  {labelOf(labels, row.lineId)}
                </th>
                <td className="num">{row.counts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Breakdown({ rows, result }: { rows: BreakdownRow[]; result: RunResult }) {
  return (
    <table className="rows tight breakdown" data-testid="breakdown">
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} data-testid={`breakdown-${row.id}`}>
            <th>{row.label}</th>
            <td className="num">{row.percent}</td>
            <td className="num dim">{row.exact}</td>
          </tr>
        ))}
        <tr className="total" data-testid="breakdown-any">
          <th>any of them</th>
          <td className="num">{percentText(result.best.blend)}</td>
          <td className="num dim">{exactText(result.best.blend)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The lines no requirement or limit can see (PRD §5.6) — and M1c's correction
 * to it: such a line ties only while the blank class can absorb it, so where
 * the engine says the counts are NOT flat, what each one costs is shown
 * instead of the line being called free.
 */
function Irrelevant({
  rows,
  labels,
}: {
  rows: IrrelevantRow[];
  labels: ReadonlyMap<string, string>;
}) {
  const flat = rows.filter((row) => row.flat);
  const priced = rows.filter((row) => !row.flat);
  return (
    <ul className="readouts" data-testid="irrelevant">
      {flat.length > 0 && (
        <li className="readout-row" data-testid="irrelevant-flat">
          <p className="readout-head">Every count ties for the best</p>
          <p className="readout-line">
            <span className="readout-label">Free</span>
            <span>
              {flat.map((row, at) => (
                <span key={row.lineId} title={`line ${row.lineId}`}>
                  {at > 0 && ', '}
                  <strong>{labelOf(labels, row.lineId)}</strong>{' '}
                  <span className="dim">{row.range}</span>
                </span>
              ))}
            </span>
          </p>
        </li>
      )}
      {priced.map((row) => (
        <li className="readout-row" key={row.lineId} data-testid={`irrelevant-${row.lineId}`}>
          <p className="readout-head" title={`line ${row.lineId}`}>
            <strong>{labelOf(labels, row.lineId)}</strong>{' '}
            <span className="dim">
              no loss at {row.free}; beyond that its cards crowd out ones that matter
            </span>
          </p>
          <p className="chart-values tabular">
            {row.cells.map((cell) => (
              <span key={cell.counts} className={cell.best ? 'cell best' : 'cell'}>
                <span className="dim">{cell.counts}:</span> {cell.percent}
              </span>
            ))}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Everything a finished (or half-finished) run has to say. */
function RunResultReadout({ result, onRun }: { result: RunResult; onRun: () => void }) {
  // No live state is read here: everything on screen is the run's own, so a
  // result keeps saying what it meant while the template is edited under it.
  const dropped = droppedLimitRows(result);

  return (
    <div data-testid="run-result">
      {result.partial && (
        <p className="readout warn-row" data-testid="run-partial">
          <span className="tag">partial</span> This run was stopped early. Everything below holds
          for the {formatCount(result.done)} ratios it reached and for those only — a better one may
          be among the {formatCount(result.total)} it did not.
        </p>
      )}

      <BestRatio result={result} />
      <LimitsFootnote result={result} />

      <Ranked result={result} />

      <Plateau result={result} onRun={onRun} />

      <Heading note="The best probability reachable with a line held at each count, everything else re-optimized. Each chart is scaled to its own line — the figures at its left are where that line's axis starts and ends, and an axis starts at zero only where it says 0.0000%.">
        Copies vs odds
      </Heading>
      <SweepCharts sweeps={result.sweeps} labels={lineLabels(result)} />

      <Heading note="Each criterion on its own, at the best ratio. They overlap, so they do not add up.">
        Per criterion
      </Heading>
      <Breakdown rows={breakdownRows(result)} result={result} />

      {result.irrelevant.length > 0 && (
        <>
          <Heading note="No requirement or limit can see these cards, so nothing in them can make a hand succeed.">
            Lines that cannot matter
          </Heading>
          <Irrelevant rows={irrelevantRows(result)} labels={lineLabels(result)} />
        </>
      )}

      {dropped.length > 0 && (
        <>
          <Heading>Limits that were not scored</Heading>
          <ul className="readouts" data-testid="dropped-limits">
            {dropped.map((row) => (
              <li className="readout-row" key={row.heading}>
                <p className="readout-head">
                  <code>{row.heading}</code>
                </p>
                <p className="readout-line">
                  <span className="readout-label">Left out</span>
                  <span>{row.why}</span>
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function ResultsView() {
  const template = useApp((state) => state.template);
  const view = useApp((state) => state.run);
  const failure = useApp((state) => state.runFailure);
  const setRunFailure = useApp((state) => state.setRunFailure);
  const cancelling = useApp((state) => state.cancelling);
  // M2d put the analysis on screen, so a template it has already found errors
  // in is not offered as runnable: the errors are beside the lines and criteria
  // they are about. `selectRunBlocker` is the whole rule, and `selectRunSentence`
  // is that rule in words — the button and the sentence cannot disagree.
  const runnable = useApp(selectRunnable);
  const sentence = useApp(selectRunSentence);

  async function run(): Promise<void> {
    setRunFailure(startFailureLines(await window.api.startRun({ template })));
  }

  function stop(runId: number): void {
    cancelling();
    // Graceful: what was scored so far comes back as the `cancelled` event.
    void window.api.cancelRun(runId, { graceful: true });
  }

  return (
    <section className="panel" data-region="results">
      <h2>Results</h2>
      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="run"
          disabled={!runnable}
          onClick={() => void run()}
        >
          Run
        </button>
        {view.phase === 'running' && (
          <button
            type="button"
            data-testid="cancel"
            disabled={view.cancelling}
            onClick={() => stop(view.runId)}
          >
            {view.cancelling ? 'Stopping…' : 'Cancel'}
          </button>
        )}
      </div>

      <p className="hint trailing" data-testid="run-template">
        {sentence}
      </p>

      {failure.length > 0 && (
        <ul className="readout bad" data-testid="run-failure">
          {failure.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {view.phase === 'running' && (
        <p className="progress" data-testid="run-progress" aria-live="polite">
          {view.progress === null ? 'Starting…' : progressLine(view.progress)}
          {view.cancelling && ' · stopping, and keeping what was scored'}
        </p>
      )}
      {view.phase === 'confirming' && (
        <div className="readout" data-testid="run-confirm">
          <p>{confirmationLine(view.confirmation)}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              data-testid="run-anyway"
              onClick={() => void window.api.confirmRun(view.runId)}
            >
              Run anyway
            </button>
            <button
              type="button"
              data-testid="run-dont"
              onClick={() => void window.api.cancelRun(view.runId)}
            >
              Don’t run
            </button>
          </div>
        </div>
      )}
      {view.phase === 'failed' && (
        <p className="readout bad" data-testid="run-error">
          The run failed: {view.message}
        </p>
      )}
      {view.phase === 'cancelled' && view.result === null && (
        <p className="readout" data-testid="run-cancelled">
          The run was cancelled before anything was scored.
        </p>
      )}
      {view.phase === 'idle' && (
        <p className="seam" data-testid="run-idle">
          Nothing has been scored yet. Run scores every valid ratio exactly — the best one, how flat
          the optimum is, and what each line's copies are worth.
        </p>
      )}
      {(view.phase === 'done' || view.phase === 'cancelled') && view.result !== null && (
        <RunResultReadout result={view.result} onRun={() => void run()} />
      )}
    </section>
  );
}
