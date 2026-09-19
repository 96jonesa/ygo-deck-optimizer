import type { RunResult } from '../../../shared/types';
import {
  bestRatioRows,
  confirmationLine,
  fractionText,
  progressLine,
  startFailureLines,
  topRows,
} from '../model/run-format';
import { selectCardsReady, useApp } from '../store';

// The results region (PRD §8.4). M2c keeps M2b's run controls working — start,
// progress, a graceful stop, the confirmation, the best ratio; the ranked
// table, the plateau, the sweep chart and the per-criterion breakdown are
// M2f's, and land in this panel.

function RunResultReadout({ result }: { result: RunResult }) {
  return (
    <div className="readout" data-testid="run-result">
      <p>
        {result.partial
          ? `Stopped early — the best of the ${result.done.toLocaleString('en-US')} ratios scored so far: `
          : 'Best ratio: '}
        <strong data-testid="run-best">{fractionText(result.best.blend)}</strong>
      </p>
      <table className="rows tight">
        <tbody>
          {bestRatioRows(result).map((row) => (
            <tr key={row.lineId}>
              <th>{row.lineId}</th>
              <td className="num">{row.copies}</td>
              <td className="note">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="scroll-x">
        <table className="rows ranked tight" data-testid="run-top">
          <thead>
            <tr>
              <th>#</th>
              <th>P</th>
              <th>exact</th>
              {result.lines.map((line) => (
                <th key={line.id}>{line.id}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topRows(result, 5).map((row) => (
              <tr key={row.rank}>
                <td className="num">{row.rank}</td>
                <td className="num">{row.percent}</td>
                <td className="num">{row.exact}</td>
                {result.lines.map((line, at) => (
                  <td key={line.id} className="num">
                    {row.example[at]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ResultsView() {
  const template = useApp((state) => state.template);
  const view = useApp((state) => state.run);
  const failure = useApp((state) => state.runFailure);
  const setRunFailure = useApp((state) => state.setRunFailure);
  const cancelling = useApp((state) => state.cancelling);
  const ready = useApp(selectCardsReady);
  const runnable = ready && template.lines.length > 0 && template.criteria.length > 0;

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
        <button type="button" className="primary" disabled={!runnable} onClick={() => void run()}>
          Run
        </button>
        {view.phase === 'running' && (
          <button type="button" disabled={view.cancelling} onClick={() => stop(view.runId)}>
            {view.cancelling ? 'Stopping…' : 'Cancel'}
          </button>
        )}
      </div>

      <p className="hint trailing" data-testid="run-template">
        {runnable
          ? `Ready to score: ${template.lines.length} lines, ${template.criteria.length} criteria, deck of ${template.deckSize}.`
          : ready
            ? 'A run needs at least one line and one criterion. Load the example to see one.'
            : 'A run needs the card database.'}
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
        </p>
      )}
      {view.phase === 'confirming' && (
        <div className="readout" data-testid="run-confirm">
          <p>{confirmationLine(view.confirmation)}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => void window.api.confirmRun(view.runId)}
            >
              Run anyway
            </button>
            <button type="button" onClick={() => void window.api.cancelRun(view.runId)}>
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
          The run was cancelled.
        </p>
      )}
      {(view.phase === 'done' || view.phase === 'cancelled') && view.result !== null && (
        <RunResultReadout result={view.result} />
      )}

      <p className="seam">
        The full ranked table, the plateau, the copies-vs-odds sweep and the per-criterion breakdown
        arrive in M2f.
      </p>
    </section>
  );
}
