import { useEffect, useState } from 'react';
import { FILE_REFERENCE } from '../../../shared/syntax';
import { importStatus, openStatus, saveStatus } from '../model/files';
import { selectCardsReady, useApp } from '../store';
import { FactReference } from './syntax-reference';

// Open, Save, and the install's decks (M2g). The renderer holds no path and
// reads no file: every button here is one `window.api` call, and every
// sentence under them came back from main (TDD §3).

/**
 * The install's decks, by name. A list rather than a file dialog because the
 * app already knows where EDOPro keeps them and a dialog would make the user
 * find a folder they never think about; the dialog stays, as one more row, for
 * a deck kept elsewhere.
 *
 * The list is fetched when it is opened, not held: decks are edited in EDOPro
 * while this app is running, and a list from ten minutes ago is worse than a
 * short wait.
 */
function DeckList({ onClose }: { onClose: () => void }) {
  const importDeck = useApp((state) => state.importDeck);
  const setFileStatus = useApp((state) => state.setFileStatus);
  const [decks, setDecks] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.api.listDecks().then((result) => {
      if (!live) return;
      if (result.ok) setDecks(result.decks);
      else setProblem(result.message);
    });
    return () => {
      live = false;
    };
  }, []);

  async function choose(name?: string): Promise<void> {
    const result = await window.api.importDeck(name === undefined ? {} : { name });
    // The edit first, then what to say about it: an edit clears the file line.
    if (result.ok) importDeck(result.template);
    setFileStatus(importStatus(result));
    if (result.ok || result.reason !== 'cancelled') onClose();
  }

  return (
    <div className="deck-list" data-testid="deck-list">
      <p className="hint flush">
        A deck becomes one line per card, at the copies it holds. Your criteria and groups stay as
        they are.
      </p>
      {problem !== null && (
        <p className="field-note bad" data-testid="deck-list-problem">
          {problem}
        </p>
      )}
      {decks !== null && decks.length === 0 && problem === null && (
        <p className="hint flush" data-testid="deck-list-empty">
          No decks in this install’s <code>deck</code> folder.
        </p>
      )}
      <ul className="deck-names">
        {(decks ?? []).map((name) => (
          <li key={name}>
            <button
              type="button"
              className="link"
              data-testid={`deck-${name}`}
              onClick={() => void choose(name)}
            >
              {name}
            </button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" data-testid="deck-browse" onClick={() => void choose()}>
          Choose a .ydk file…
        </button>
        <button type="button" className="link" data-testid="deck-close" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Open, Save, Import deck — and the one line that says what the last one did. */
export function FileActions() {
  const template = useApp((state) => state.template);
  const setTemplate = useApp((state) => state.setTemplate);
  const setFileStatus = useApp((state) => state.setFileStatus);
  const status = useApp((state) => state.file);
  const ready = useApp(selectCardsReady);
  const [importing, setImporting] = useState(false);

  async function open(): Promise<void> {
    const result = await window.api.openTemplate();
    if (result.ok) setTemplate(result.template);
    setFileStatus(openStatus(result));
  }

  async function save(): Promise<void> {
    setFileStatus(saveStatus(await window.api.saveTemplate(template)));
  }

  return (
    <div className="file-actions">
      <div className="actions">
        <button
          type="button"
          data-testid="template-open"
          disabled={!ready}
          onClick={() => void open()}
        >
          Open…
        </button>
        <button
          type="button"
          data-testid="template-save"
          disabled={!ready}
          onClick={() => void save()}
        >
          Save…
        </button>
        <button
          type="button"
          data-testid="deck-import"
          disabled={!ready}
          aria-expanded={importing}
          onClick={() => setImporting(!importing)}
        >
          Import a deck…
        </button>
      </div>
      <FactReference section={FILE_REFERENCE} />
      {importing && <DeckList onClose={() => setImporting(false)} />}
      {status !== null && (
        <ul
          className={status.tone === 'bad' ? 'readout bad' : 'readout'}
          data-testid="file-status"
          aria-live="polite"
        >
          {status.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
