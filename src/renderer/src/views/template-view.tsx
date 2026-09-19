import { useEffect } from 'react';
import {
  kindTotals,
  lineAnalysisOf,
  remainderRange,
  remainderText,
  templateErrorText,
  workText,
} from '../model/analysis-view';
import { commitDeckSize, DECK_SIZE_MAX, DECK_SIZE_MIN, HAND_SIZES } from '../model/deck-form';
import { exampleTemplate } from '../model/example-template';
import { EMPTY_TEMPLATE } from '../model/template-edit';
import {
  selectAnalysis,
  selectCardState,
  selectCardsReady,
  unknownPasscodes,
  useApp,
} from '../store';
import { CardPicker } from './card-picker';
import { useField } from './fields';
import { GroupsEditor } from './groups-editor';
import { LineRow } from './line-row';

// The template editor (PRD §8.2). Everything it says about what a template
// MEANS — what a line matched, what fills what, the remainder, the totals, the
// errors — is read off the `Analysis` main sends back on every edit (TDD §9).
// The renderer decides nothing here but what the row looks like.

/**
 * The display fields of named cards a template arrived with. A template file
 * keeps a passcode and a name (TDD §14), so a chip's typeline comes from
 * `cards:get` — and a passcode the database lacks stays unresolved, which is
 * why this asks once per set of passcodes and not again.
 */
function useResolveNamedCards(): void {
  const template = useApp((state) => state.template);
  const known = useApp((state) => state.known);
  const learn = useApp((state) => state.learn);
  const ready = useApp(selectCardsReady);
  const missing = unknownPasscodes(template, known).join(',');

  useEffect(() => {
    if (!ready || missing === '') return;
    void window.api.getCards(missing.split(',').map(Number)).then(learn);
  }, [ready, missing, learn]);
}

/** Deck size and hand size: the two numbers the whole template is measured against. */
function DeckControls() {
  const deckSize = useApp((state) => state.template.deckSize);
  const handSize = useApp((state) => state.template.hand.size);
  const setDeckSize = useApp((state) => state.setDeckSize);
  const setHandSize = useApp((state) => state.setHandSize);
  const [draft, setDraft] = useField(String(deckSize));

  return (
    <div className="deck-controls">
      <label htmlFor="deck-size">Deck</label>
      <input
        type="number"
        className="count wide"
        id="deck-size"
        data-testid="deck-size"
        inputMode="numeric"
        min={DECK_SIZE_MIN}
        max={DECK_SIZE_MAX}
        step={1}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setDeckSize(commitDeckSize(event.target.value, deckSize));
        }}
        onBlur={() => setDraft(String(deckSize))}
      />
      <span className="dim">
        cards ({DECK_SIZE_MIN}–{DECK_SIZE_MAX})
      </span>
      <span className="spacer" />
      <span className="dim">Opening hand</span>
      {/* Two toggles rather than a group: each one says in full what it sets,
          so a screen reader needs no wrapper to make sense of a bare "5". */}
      <span className="segmented">
        {HAND_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            aria-pressed={handSize === size}
            aria-label={`Opening hand of ${size} cards, going ${size === 5 ? 'first' : 'second'}`}
            data-testid={`hand-${size}`}
            onClick={() => setHandSize(size)}
          >
            {size}
          </button>
        ))}
      </span>
      <span className="dim">{handSize === 5 ? 'going first' : 'going second'}</span>
    </div>
  );
}

/** The read-only totals: derived from the lines, since nothing states a total (PRD §6.4). */
function Totals() {
  const analysis = useApp(selectAnalysis);
  const rows = kindTotals(analysis);
  const remainder = remainderText(analysis);
  const error = templateErrorText(analysis);
  const work = workText(analysis);

  return (
    <div className="totals" data-testid="totals">
      {rows.map((row) => (
        <p key={row.kind}>
          <span className="total-label">{row.label}</span>
          <strong className="tabular">{row.range ?? '—'}</strong>
          <span className="dim">{row.lines.length === 0 ? 'no line' : row.lines.join(', ')}</span>
        </p>
      ))}
      {remainder !== null && (
        <p className="remainder" data-testid="remainder" title={remainder}>
          <span className="total-label">Unspecified cards</span>
          <strong className="tabular">{remainderRange(analysis) ?? '—'}</strong>
          <span className="dim">what the lines leave of the deck</span>
        </p>
      )}
      {error !== null && (
        <p className="line-error" data-testid="totals-error">
          {error}
        </p>
      )}
      {work !== null && (
        <p className="dim work" data-testid="work">
          {work}
        </p>
      )}
    </div>
  );
}

export function TemplateView() {
  const template = useApp((state) => state.template);
  const known = useApp((state) => state.known);
  const analysis = useApp(selectAnalysis);
  const problem = useApp((state) => state.analysis.problem);
  const cardState = useApp(selectCardState);
  const pickCard = useApp((state) => state.pickCard);
  const addDescriptionLine = useApp((state) => state.addDescriptionLine);
  const dropLine = useApp((state) => state.dropLine);
  const setLineText = useApp((state) => state.setLineText);
  const setLineRange = useApp((state) => state.setLineRange);
  const moveLine = useApp((state) => state.moveLine);
  const setTemplate = useApp((state) => state.setTemplate);
  useResolveNamedCards();

  const { lines } = template;

  return (
    <section className="panel" data-region="template">
      <h2>Template</h2>
      <p className="hint">
        Each line is one card or one description, with the copies it may hold. Lines are separate
        and additive: <code>monster</code> and <code>level 4 monster</code> are different cards, and
        a line only ever fills what it says (PRD §6).
      </p>

      <DeckControls />

      <h3>Lines</h3>
      <ul className="lines" data-testid="lines">
        {lines.map((line, at) => (
          <LineRow
            key={line.id}
            line={line}
            found={lineAnalysisOf(analysis, line.id)}
            known={('card' in line ? known[line.card.passcode] : undefined) ?? null}
            cardState={cardState}
            deckSize={template.deckSize}
            first={at === 0}
            last={at === lines.length - 1}
            onText={(text) => setLineText(line.id, text)}
            onRange={(range) => setLineRange(line.id, range)}
            onMove={(by) => moveLine(line.id, by)}
            onRemove={() => dropLine(line.id)}
          />
        ))}
        <li className="line computed" data-testid="remainder-line">
          <div className="line-main">
            <span className="line-id">rest</span>
            <span className="computed-text">
              Unspecified cards — everything no line accounts for, about which nothing is known
            </span>
            <span className="range tabular" data-testid="remainder-range">
              {remainderRange(analysis) ?? '—'}
            </span>
            <span className="line-buttons" />
          </div>
        </li>
      </ul>

      <div className="actions">
        <button type="button" onClick={addDescriptionLine} data-testid="add-description">
          Add description
        </button>
        <CardPicker
          id="line-new"
          label="Add a card to the template"
          value={null}
          cardState={cardState}
          placeholder="Add a card by name…"
          onPick={(card) => {
            if (card !== null) pickCard(card);
          }}
        />
      </div>

      <h3>Totals</h3>
      <Totals />
      {problem !== null && (
        <p className="line-error" data-testid="analysis-problem">
          {problem}
        </p>
      )}

      <GroupsEditor />

      <div className="actions spaced">
        <button type="button" onClick={() => setTemplate(exampleTemplate())}>
          Load example
        </button>
        <button
          type="button"
          disabled={lines.length === 0 && template.groups.length === 0}
          onClick={() => setTemplate(EMPTY_TEMPLATE)}
        >
          Clear
        </button>
      </div>
    </section>
  );
}
