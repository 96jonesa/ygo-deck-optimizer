import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppInfo } from '../../shared/ipc';
import type {
  CardStatus,
  DescParseResult,
  RunResult,
  Template,
  WorkdirHealth,
} from '../../shared/types';
import { statusHeadline, statusRows } from './model/card-status';
import { chooseFolder } from './model/choose-folder';
import { EXAMPLE_TEMPLATE } from './model/example-template';
import { LatestOnly } from './model/latest';
import {
  bestRatioRows,
  confirmationLine,
  fractionText,
  progressLine,
  startFailureLines,
  topRows,
} from './model/run-format';
import { IDLE_RUN, markCancelling, type RunView, reduceRun } from './model/run-state';
import { splitAtSpan } from './model/span';
import './styles.css';

// The proof that the slices so far work end to end — M2a: card status by
// push, the folder flow, one description box; M2b: a run with progress, a
// graceful stop, the confirmation, and the best ratio. M2c–M2f replace all of it.

/** The card status: asked for once, then kept current by push — never polled (TDD §3). */
function useCardStatus(): CardStatus | null {
  const [status, setStatus] = useState<CardStatus | null>(null);

  useEffect(() => {
    // Subscribe first, then ask once: a push that lands in between wins, being newer.
    let pushed = false;
    const unsubscribe = window.api.onCardStatus((next) => {
      pushed = true;
      setStatus(next);
    });
    void window.api.getCardStatus().then((first) => {
      if (!pushed) setStatus(first);
    });
    return unsubscribe;
  }, []);

  return status;
}

function CardStatusPanel({ status }: { status: CardStatus | null }) {
  const [health, setHealth] = useState<WorkdirHealth | null>(null);

  async function choose() {
    const outcome = await chooseFolder(window.api);
    if (outcome.kind !== 'cancelled') setHealth(outcome.health);
  }

  return (
    <section>
      <h2>Card data</h2>
      <p>{status === null ? 'Asking the main process…' : statusHeadline(status)}</p>
      {status !== null && (
        <table className="rows">
          <tbody>
            {statusRows(status).map(([label, value]) => (
              <tr key={label}>
                <th>{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <button type="button" onClick={() => void choose()}>
          Choose EDOPro folder…
        </button>{' '}
        <button
          type="button"
          disabled={status === null || status.workdir === null || status.state === 'loading'}
          onClick={() => void window.api.reindexCards()}
        >
          Re-index
        </button>
      </p>
      {health !== null && (
        <div className={health.ok ? 'probe ok' : 'probe bad'}>
          <p>
            {health.ok ? 'Using' : 'Not an EDOPro folder:'} {health.path}
            {health.ok &&
              ` — ${health.databases} database(s), ${health.stringsConf} strings.conf file(s)`}
          </p>
          <ul>
            {health.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
            {health.notes.map((note) => (
              <li key={note} className="note">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DescriptionBox({ cardState }: { cardState: CardStatus['state'] | undefined }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<DescParseResult | null>(null);
  const latest = useRef(new LatestOnly());

  // Re-asked on every edit, and whenever the card data changes under the text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cardState is the trigger, not an input
  useEffect(() => {
    const seq = latest.current.next();
    void window.api.parseDescription({ seq, payload: { text, groups: [] } }).then((response) => {
      // An answer a newer keystroke has overtaken is dropped (TDD §12).
      if (latest.current.isCurrent(response.seq)) setResult(response.payload);
    });
  }, [text, cardState]);

  return (
    <section>
      <h2>Description</h2>
      <input
        className="desc"
        value={text}
        placeholder="level 4 or lower monster"
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
      />
      {text !== '' && result !== null && <ParseReadout text={text} result={result} />}
    </section>
  );
}

function ParseReadout({ text, result }: { text: string; result: DescParseResult }) {
  if (result.ok)
    return (
      <div className="readout">
        <p>
          <strong>{result.echo}</strong> — <code>{result.canonical}</code>
        </p>
        <p>
          {result.count.toLocaleString('en-US')} matching card(s)
          {result.samples.length > 0 && `: ${result.samples.join(', ')}`}
          {result.count > result.samples.length && result.samples.length > 0 && ', …'}
        </p>
      </div>
    );
  if (result.reason !== 'parse') return <p className="readout bad">{result.message}</p>;
  const { before, at, after } = splitAtSpan(text, result.span);
  return (
    <div className="readout bad">
      <p>{result.message}</p>
      <p>
        <code>
          {before}
          <mark>{at === '' ? '⟨here⟩' : at}</mark>
          {after}
        </code>
      </p>
    </div>
  );
}

/** The latest run, kept current by `run:event` pushes — whichever window started it. */
function useRunView(): [RunView, (change: (view: RunView) => RunView) => void] {
  const [view, setView] = useState<RunView>(IDLE_RUN);
  useEffect(() => window.api.onRunEvent((event) => setView((was) => reduceRun(was, event))), []);
  return [view, setView];
}

function RunResultReadout({ result }: { result: RunResult }) {
  return (
    <div className="readout" data-testid="run-result">
      <p>
        {result.partial
          ? `Stopped early — the best of the ${result.done.toLocaleString('en-US')} ratios scored so far: `
          : 'Best ratio: '}
        <strong data-testid="run-best">{fractionText(result.best.blend)}</strong>
      </p>
      <table className="rows">
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
      <table className="rows ranked" data-testid="run-top">
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
  );
}

function RunPanel() {
  const [template, setTemplate] = useState<Template | null>(null);
  const [view, setView] = useRunView();
  const [failure, setFailure] = useState<string[]>([]);

  async function run() {
    if (template === null) return;
    setFailure(startFailureLines(await window.api.startRun({ template })));
  }

  function stop(runId: number) {
    setView(markCancelling);
    // Graceful: what was scored so far comes back as the `cancelled` event.
    void window.api.cancelRun(runId, { graceful: true });
  }

  return (
    <section>
      <h2>Optimizer</h2>
      <p>
        <button type="button" onClick={() => setTemplate(EXAMPLE_TEMPLATE)}>
          Load example
        </button>{' '}
        <button type="button" disabled={template === null} onClick={() => void run()}>
          Run
        </button>{' '}
        {view.phase === 'running' && (
          <button type="button" disabled={view.cancelling} onClick={() => stop(view.runId)}>
            {view.cancelling ? 'Stopping…' : 'Cancel'}
          </button>
        )}
      </p>
      <p data-testid="run-template">
        {template === null
          ? 'No template loaded.'
          : `Example loaded: ${template.lines.length} lines, ${template.criteria.length} criteria, deck of ${template.deckSize}.`}
      </p>
      {failure.length > 0 && (
        <ul className="readout bad" data-testid="run-failure">
          {failure.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {view.phase === 'running' && (
        <p data-testid="run-progress">
          {view.progress === null ? 'Starting…' : progressLine(view.progress)}
        </p>
      )}
      {view.phase === 'confirming' && (
        <div className="readout" data-testid="run-confirm">
          <p>{confirmationLine(view.confirmation)}</p>
          <p>
            <button type="button" onClick={() => void window.api.confirmRun(view.runId)}>
              Run anyway
            </button>{' '}
            <button type="button" onClick={() => void window.api.cancelRun(view.runId)}>
              Don’t run
            </button>
          </p>
        </div>
      )}
      {view.phase === 'failed' && (
        <p className="readout bad" data-testid="run-error">
          The run failed: {view.message}
        </p>
      )}
      {view.phase === 'cancelled' && view.result === null && (
        <p data-testid="run-cancelled">The run was cancelled.</p>
      )}
      {(view.phase === 'done' || view.phase === 'cancelled') && view.result !== null && (
        <RunResultReadout result={view.result} />
      )}
    </section>
  );
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const status = useCardStatus();

  useEffect(() => {
    void window.api.getAppInfo().then(setInfo);
  }, []);

  return (
    <main className="shell">
      <h1>YGO Deck Optimizer</h1>
      <p className="meta">
        {info === null
          ? 'Connecting to the main process…'
          : `v${info.version} · Electron ${info.electron} · Node ${info.node}`}
      </p>
      <CardStatusPanel status={status} />
      <DescriptionBox cardState={status?.state} />
      <RunPanel />
    </main>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
