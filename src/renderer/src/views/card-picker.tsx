import { type KeyboardEvent, useEffect, useReducer, useRef } from 'react';
import type { CardHit, CardState } from '../../../shared/types';
import { LatestOnly } from '../model/latest';
import {
  activeHit,
  activeOptionId,
  EMPTY_PICKER,
  hitLabel,
  optionId,
  pickerRows,
  pickerStatus,
  reducePicker,
} from '../model/picker';

// The card picker (PRD §8.2): a combobox over `cards:search`. All of its
// logic is in `model/picker.ts`; this file is the markup, the keys, and the
// one call to `window.api`.

export interface CardPickerProps {
  /**
   * The card this picker holds, or `null` for an empty one. Controlled: the
   * caller owns it, so a template line passes its own card and the picker
   * above a list passes `null` and appends on every pick.
   */
  value: CardHit | null;
  /** A card was picked, or (`null`) the one that was held has been removed. */
  onPick: (card: CardHit | null) => void;
  /** The card index: anything but `ready` disables the search and says why. */
  cardState: CardState;
  /** Unique on the page: the listbox and option ids are built from it. */
  id: string;
  /** Names the field for a screen reader; also the chip's own label. */
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** The caller's own reason, on top of `cardState`. */
  disabled?: boolean;
}

const NOT_READY: Record<CardState, string> = {
  idle: 'Card search needs an EDOPro folder.',
  loading: 'Card search is available once the cards have loaded.',
  error: 'Card search is unavailable: the cards could not be loaded.',
  ready: '',
};

export function CardPicker({
  value,
  onPick,
  cardState,
  id,
  label,
  placeholder = 'Search cards by name…',
  autoFocus = false,
  disabled = false,
}: CardPickerProps) {
  const [state, dispatch] = useReducer(reducePicker, EMPTY_PICKER);
  const latest = useRef(new LatestOnly());
  const field = useRef<HTMLInputElement>(null);
  const ready = cardState === 'ready';
  const query = state.query.trim();

  // Focused on mount rather than through the `autofocus` attribute, which the
  // browser applies before React has the element and which is a11y-hostile
  // when the page is not a form the user came to fill in.
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  // One search per query. The reply carries the query it answers, and a reply
  // that a newer keystroke has overtaken is dropped twice over: by the
  // sequence number here, and by the reducer's own check (TDD §12).
  useEffect(() => {
    if (!ready || query === '') return;
    const seq = latest.current.next();
    void window.api.searchCards(query).then((hits) => {
      if (latest.current.isCurrent(seq)) dispatch({ type: 'hits', query, hits });
    });
  }, [query, ready]);

  // The chip takes the field's own slot in the caller's row, so a narrow row
  // shrinks it rather than pushing what follows off the panel.
  if (value !== null)
    return (
      <div className="picker">
        <span className="card-chip" data-testid={`${id}-chip`}>
          <span className="name">{value.name}</span>
          <span className="typeline">{value.typeline}</span>
          <button
            type="button"
            aria-label={`Remove ${hitLabel(value)}`}
            onClick={() => onPick(null)}
          >
            ×
          </button>
        </span>
      </div>
    );

  const rows = pickerRows(state.hits);
  const status = pickerStatus(state, cardState);
  const listId = `${id}-list`;
  const noteId = `${id}-note`;
  const showList = state.open && status === 'results';

  function pick(hit: CardHit): void {
    dispatch({ type: 'reset' });
    onPick(hit);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        dispatch({ type: 'move', by: 1 });
        return;
      case 'ArrowUp':
        event.preventDefault();
        dispatch({ type: 'move', by: -1 });
        return;
      case 'Enter': {
        const hit = activeHit(state);
        if (hit === null) return;
        event.preventDefault();
        pick(hit);
        return;
      }
      case 'Escape':
        // The first Escape dismisses the list; a second clears what was typed.
        event.preventDefault();
        dispatch(state.open ? { type: 'close' } : { type: 'reset' });
        return;
      default:
        // Tab and everything else: the list must not swallow the key.
        if (event.key === 'Tab' && state.open) dispatch({ type: 'close' });
    }
  }

  return (
    <div className="picker">
      <input
        ref={field}
        type="text"
        role="combobox"
        id={id}
        data-testid={id}
        value={state.query}
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? activeOptionId(id, state) : undefined}
        aria-describedby={noteId}
        placeholder={ready ? placeholder : 'Card search unavailable'}
        disabled={disabled || !ready}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => dispatch({ type: 'query', query: event.target.value })}
        onKeyDown={onKeyDown}
        onBlur={() => dispatch({ type: 'close' })}
      />
      {showList && (
        // The ARIA combobox pattern: the popup is a listbox of `option`s that
        // are deliberately NOT focusable — focus stays in the field above, and
        // the active row is named by `aria-activedescendant`, which is what
        // makes the arrow keys work at all. The three rules suppressed here
        // each assume a widget the user tabs into; an option is not one, and
        // making one focusable would break the pattern rather than help it.
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a listbox popup IS a list; the role is what a screen reader needs to read it as one
        <ul className="hits" role="listbox" id={listId} aria-label={label} data-testid={listId}>
          {rows.map((row, at) => (
            // biome-ignore lint/a11y/useFocusableInteractive: options are reached with the arrow keys through aria-activedescendant, never by tabbing
            // biome-ignore lint/a11y/useKeyWithClickEvents: every key of this widget is handled on the combobox input above
            <li
              key={row.hit.passcode}
              className={row.ambiguous ? 'hit ambiguous' : 'hit'}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a list item is what an option is; the role is what tells a screen reader so
              role="option"
              id={optionId(id, at)}
              aria-selected={at === state.active}
              // Swallowed on mousedown, so the field does not lose focus first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(row.hit)}
            >
              <span className="hit-name">{row.hit.name}</span>
              <span className="hit-type">{row.hit.typeline}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="picker-note" id={noteId} data-testid={noteId} aria-live="polite">
        {status === 'not-ready' && NOT_READY[cardState]}
        {status === 'searching' && 'Searching…'}
        {status === 'no-matches' && `No card matches “${state.query.trim()}”.`}
      </p>
    </div>
  );
}
