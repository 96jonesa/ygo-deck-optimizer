import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppInfo } from '../../shared/ipc';
import type { CardStatus, DescParseResult, WorkdirHealth } from '../../shared/types';
import { statusHeadline, statusRows } from './model/card-status';
import { chooseFolder } from './model/choose-folder';
import { LatestOnly } from './model/latest';
import { splitAtSpan } from './model/span';
import './styles.css';

// M2a's proof that the slice works end to end: card status by push, the
// folder flow, and one description box. M2c replaces all of it.

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
