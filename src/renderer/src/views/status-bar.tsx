import { statusChips, statusTone } from '../model/card-status';
import { selectStatusText, useApp } from '../store';

// The title bar doubles as the card-database status (PRD §8.1): what is
// loaded, and the two things one does about it — re-index, and settings.

export function StatusBar() {
  const status = useApp((state) => state.cards);
  const text = useApp(selectStatusText);
  const view = useApp((state) => state.view);
  const show = useApp((state) => state.show);
  const settings = view === 'settings';

  return (
    <header className="statusbar">
      <h1>YGO Deck Optimizer</h1>
      {/* One live region for the whole card-database state: a load, a failure,
          a re-index all speak here, and nowhere else. */}
      <div className="status" data-testid="status" aria-live="polite">
        <span className={`dot ${statusTone(status)}`} />
        <span className="status-text">{text}</span>
        <ul className="counts">
          {statusChips(status).map((chip) => (
            <li key={chip.label}>
              <b>{chip.value}</b>
              {chip.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="statusbar-actions">
        <button
          type="button"
          disabled={status === null || status.workdir === null || status.state === 'loading'}
          onClick={() => void window.api.reindexCards()}
        >
          Re-index
        </button>
        <button
          type="button"
          aria-pressed={settings}
          onClick={() => show(settings ? 'workspace' : 'settings')}
        >
          Settings
        </button>
      </div>
    </header>
  );
}
