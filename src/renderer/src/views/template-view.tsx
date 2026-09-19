import { useEffect } from 'react';
import type { CardHit } from '../../../shared/types';
import { EXAMPLE_TEMPLATE } from '../model/example-template';
import {
  cardLines,
  EMPTY_TEMPLATE,
  selectCardState,
  selectCardsReady,
  unknownPasscodes,
  useApp,
} from '../store';
import { CardPicker } from './card-picker';

// The template region (PRD §8.2). M2c has the named-card lines, which is what
// the picker is for; the description lines, groups, ranges, remainder and
// totals are M2d's, and land in this panel.

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

export function TemplateView() {
  const template = useApp((state) => state.template);
  const known = useApp((state) => state.known);
  const cardState = useApp(selectCardState);
  const pickCard = useApp((state) => state.pickCard);
  const dropLine = useApp((state) => state.dropLine);
  const setTemplate = useApp((state) => state.setTemplate);
  useResolveNamedCards();

  const lines = cardLines(template);
  const described = template.lines.length - lines.length;

  return (
    <section className="panel" data-region="template">
      <h2>Template</h2>
      <p className="hint">
        A deck of {template.deckSize} cards, drawn {template.hand.size} at a time. Each line is one
        card or one description, with the number of copies it may hold.
      </p>

      <h3>Named cards</h3>
      <ul className="lines" data-testid="card-lines">
        {lines.map((line) => {
          const hit: CardHit = known[line.card.passcode] ?? {
            passcode: line.card.passcode,
            name: line.card.name,
            typeline: `#${line.card.passcode}`,
          };
          return (
            <li key={line.id}>
              <span className="line-id">{line.id}</span>
              <CardPicker
                id={`line-${line.id}`}
                label={`Card on line ${line.id}`}
                value={hit}
                cardState={cardState}
                onPick={(card) => {
                  if (card === null) dropLine(line.id);
                }}
              />
              <span className="copies">
                {line.min}–{line.max} copies
              </span>
            </li>
          );
        })}
      </ul>
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

      <p className="seam">
        {described === 0
          ? 'Description lines, groups, copy ranges and the derived totals arrive in M2d.'
          : `The template's other ${described} line${described === 1 ? ' is a description' : 's are descriptions'}. Showing and editing them, with groups, copy ranges and the derived totals, arrives in M2d.`}
      </p>

      <div className="actions spaced">
        <button type="button" onClick={() => setTemplate(EXAMPLE_TEMPLATE)}>
          Load example
        </button>
        <button
          type="button"
          disabled={template.lines.length === 0}
          onClick={() => setTemplate(EMPTY_TEMPLATE)}
        >
          Clear
        </button>
      </div>
    </section>
  );
}
