import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ANALYZE_DEBOUNCE_MS, Debouncer } from './model/debounce';
import { LatestOnly } from './model/latest';
import { appStore, selectCardState, selectShows, useApp } from './store';
import { CriteriaView } from './views/criteria-view';
import { ResultsView } from './views/results-view';
import { SettingsView } from './views/settings-view';
import { SetupView } from './views/setup-view';
import { StatusBar } from './views/status-bar';
import { TemplateView } from './views/template-view';
import './styles.css';

// The app shell. The renderer is UI only (TDD §3): it subscribes to what main
// pushes, renders it, and sends every edit back — it never reads a file and
// never parses, compiles or scores anything itself.

/**
 * Everything main pushes, into the store. Subscribed BEFORE anything is asked
 * for, so a push that lands while the first invoke is in flight wins, being
 * newer — and a `started` event that beats `run:start`'s own reply is not lost
 * (TDD §12).
 */
function useMainProcess(): void {
  useEffect(() => {
    const { setCards, setSettings, setInfo, applyRunEvent } = appStore.getState();
    let pushed = false;
    const unsubscribeCards = window.api.onCardStatus((status) => {
      pushed = true;
      setCards(status);
    });
    const unsubscribeRuns = window.api.onRunEvent(applyRunEvent);
    void window.api.getCardStatus().then((first) => {
      if (!pushed) setCards(first);
    });
    void window.api.getSettings().then(setSettings);
    void window.api.getAppInfo().then(setInfo);
    return () => {
      unsubscribeCards();
      unsubscribeRuns();
    };
  }, []);
}

/**
 * The Analysis (TDD §9), re-asked on every edit and whenever the card data
 * changes under it. Held back ~150 ms, because an edit is a keystroke and an
 * analysis is a round trip; the reply of a request a newer one has overtaken
 * is dropped by its sequence number (TDD §12), so a slow answer can never
 * overwrite a newer one. Asked for once, here, for the whole app: the template
 * editor, the criteria editor and the results all read the one answer.
 */
function useAnalysis(): void {
  const template = useApp((state) => state.template);
  const cardState = useApp(selectCardState);
  const setAnalysis = useApp((state) => state.setAnalysis);
  const pending = useRef(new Debouncer(ANALYZE_DEBOUNCE_MS));
  const latest = useRef(new LatestOnly());

  // biome-ignore lint/correctness/useExhaustiveDependencies: cardState is a trigger, not an input — the template is analysed again against the new index
  useEffect(() => {
    const debouncer = pending.current;
    debouncer.schedule(() => {
      const seq = latest.current.next();
      void window.api.analyzeTemplate({ seq, payload: template }).then((response) => {
        if (latest.current.isCurrent(response.seq)) setAnalysis(response.payload);
      });
    });
    return () => debouncer.cancel();
  }, [template, cardState, setAnalysis]);
}

/**
 * What you edit on the left, what it scores on the right. The three regions
 * are the template (M2d), criteria (M2e) and results (M2f) editors, each in
 * the place and panel it will grow into.
 */
function Workspace() {
  return (
    <div className="workspace">
      <div className="column">
        <TemplateView />
        <CriteriaView />
      </div>
      <div className="column">
        <ResultsView />
      </div>
    </div>
  );
}

function Footer() {
  const info = useApp((state) => state.info);
  return (
    <footer className="footer">
      <span>{info === null ? 'Connecting to the main process…' : `v${info.version}`}</span>
      {info !== null && (
        <span>
          Electron {info.electron} · Node {info.node} · Chromium {info.chrome}
        </span>
      )}
    </footer>
  );
}

function App() {
  useMainProcess();
  useAnalysis();
  // Settings is reachable in every state — including the one where the cards
  // will not load, which is often what it is needed for.
  const shows = useApp(selectShows);

  return (
    <div className="app">
      <StatusBar />
      <main className="main">
        {shows === 'settings' ? (
          <SettingsView />
        ) : shows === 'workspace' ? (
          <Workspace />
        ) : (
          <SetupView />
        )}
      </main>
      <Footer />
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
