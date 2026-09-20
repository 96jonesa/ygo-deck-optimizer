import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { CompletionOption } from '../../../shared/types';
import {
  activeCompletion,
  applyCompletion,
  clampPopupLeft,
  completionFits,
  completionShows,
  EMPTY_COMPLETION,
  reduceCompletion,
  siteKey,
} from '../model/completion';
import { LatestOnly } from '../model/latest';
import { activeOptionId, optionId } from '../model/listbox';
import { selectCardsReady, useApp } from '../store';

// Inline name completion (PRD §5.2): a text field that offers the names that
// could go where the caret is. The card picker replaces a field; this one
// lives INSIDE one, so it shares the keyboard model (`model/listbox.ts`) and
// nothing else. All of its state is `model/completion.ts`; this file is the
// markup, the keys, the one call to `window.api`, and the two measurements —
// where the caret is, and how wide the text before it is — that only the DOM
// can answer.

/** How close to the window's right edge the popup may come. */
const POPUP_MARGIN = 12;

/** One canvas for the page: `measureText` needs a 2D context and nothing else. */
let ruler: CanvasRenderingContext2D | null | undefined;

/** How wide `text` is in `field`'s own font: where the popup goes. */
function textWidth(field: HTMLInputElement, text: string): number {
  ruler ??= document.createElement('canvas').getContext('2d');
  if (!ruler) return 0;
  const style = getComputedStyle(field);
  ruler.font = style.font === '' ? `${style.fontSize} ${style.fontFamily}` : style.font;
  return ruler.measureText(text).width;
}

/** The left inset of a field's text: its border and padding. */
function textInset(field: HTMLInputElement): number {
  const style = getComputedStyle(field);
  return (
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.borderLeftWidth) || 0)
  );
}

export interface CompletingInputProps {
  /** Unique on the page: the field's DOM id, its `data-testid`, and the base of every option id. */
  id: string;
  value: string;
  onChange: (text: string) => void;
  /** Names the field for a screen reader. */
  label: string;
  placeholder?: string;
  className?: string;
}

export function CompletingInput({
  id,
  value,
  onChange,
  label,
  placeholder,
  className = 'desc',
}: CompletingInputProps) {
  const [state, dispatch] = useReducer(reduceCompletion, EMPTY_COMPLETION);
  const ready = useApp(selectCardsReady);
  const groups = useApp((app) => app.template.groups);
  const latest = useRef(new LatestOnly());
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** Set by a pick, applied once React has drawn the text it belongs to. */
  const pending = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [left, setLeft] = useState(0);

  const shows = completionShows(state);
  const listId = `${id}-list`;

  /** Where the caret is now. Read after everything that can move it. */
  function look(): void {
    const input = field.current;
    if (input !== null) setCaret(input.selectionStart ?? input.value.length);
  }

  // One request per (text, caret). The reply carries the text and caret it
  // answers, so a pick can never be made against a site one keystroke old,
  // and `LatestOnly` drops a reply a newer caret has overtaken (TDD §12).
  useEffect(() => {
    if (!ready) {
      dispatch({ type: 'site', site: null, text: value, caret });
      return;
    }
    const seq = latest.current.next();
    void window.api
      .completeName({ seq, payload: { text: value, caret, groups: [...groups] } })
      .then((answer) => {
        if (!latest.current.isCurrent(seq)) return;
        const result = answer.payload;
        const site = result.ok ? result.site : null;
        dispatch({ type: 'site', site, text: value, caret });
        if (result.ok && result.site !== null)
          dispatch({ type: 'options', key: siteKey(result.site)!, options: result.options });
      });
  }, [value, caret, ready, groups]);

  // The popup sits under the START of the name, not under the caret: anchored
  // at the caret it would creep right with every character typed.
  //
  // Measured after every render rather than off a dependency list, because
  // three of the four numbers — the width of the text before the name, the
  // width of the popup, and the field's own horizontal scroll — are the
  // browser's and change without React being told. `setLeft` only moves for a
  // real difference, so this settles in one pass.
  useLayoutEffect(() => {
    const input = field.current;
    const popup = list.current;
    if (input === null || popup === null || state.site === null) return;
    const desired =
      textInset(input) + textWidth(input, value.slice(0, state.site.start)) - input.scrollLeft;
    // The room is the WINDOW's, not the field's: the popup is allowed to reach
    // past the field it belongs to — the card picker's does too, since a card
    // name is what is being read — and only the window edge may move it.
    const room = window.innerWidth - POPUP_MARGIN - input.getBoundingClientRect().left;
    const next = clampPopupLeft(desired, popup.offsetWidth, room);
    setLeft((was) => (Math.abs(was - next) < 0.5 ? was : next));
  });

  // The caret goes after the inserted name, once the field is showing it —
  // one render later, since the text it is an offset into is the caller's.
  useLayoutEffect(() => {
    const at = pending.current;
    const input = field.current;
    if (at === null || input === null) return;
    pending.current = null;
    input.setSelectionRange(at, at);
    setCaret(at);
  });

  function pick(option: CompletionOption): void {
    if (state.site === null || !completionFits(state, value, caret)) return;
    const next = applyCompletion(value, state.site, option.insert);
    dispatch({ type: 'reset' });
    pending.current = next.caret;
    onChange(next.text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        // Only while there is a list: otherwise the arrows move the caret.
        if (state.options.length === 0 || state.site === null) return;
        event.preventDefault();
        dispatch({ type: 'move', by: event.key === 'ArrowDown' ? 1 : -1 });
        return;
      case 'Enter': {
        const option = shows ? activeCompletion(state) : null;
        if (option === null) return;
        event.preventDefault();
        pick(option);
        return;
      }
      case 'Escape':
        // Only the popup's Escape is taken; with none open the key is the
        // caller's (nothing here has a draft of its own to clear).
        if (!shows) return;
        event.preventDefault();
        dispatch({ type: 'close' });
        return;
      default:
        if (event.key === 'Tab' && state.open) dispatch({ type: 'close' });
    }
  }

  return (
    <span className="completing">
      <input
        ref={field}
        type="text"
        className={className}
        role="combobox"
        id={id}
        data-testid={id}
        value={value}
        aria-label={label}
        aria-expanded={shows}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shows ? activeOptionId(id, state) : undefined}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={look}
        onMouseUp={look}
        onFocus={look}
        onBlur={() => dispatch({ type: 'close' })}
      />
      {shows && (
        // The ARIA combobox pattern, as the card picker uses it: the options
        // are deliberately NOT focusable — focus stays in the field, and the
        // active row is named by `aria-activedescendant`, which is what makes
        // the arrow keys work while the text is still being typed.
        <ul
          ref={list}
          className="hits completions"
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a listbox popup IS a list; the role is what a screen reader needs to read it as one
          role="listbox"
          id={listId}
          aria-label={label}
          data-testid={listId}
          style={{ left: `${left}px` }}
        >
          {state.options.map((option, at) => (
            // biome-ignore lint/a11y/useFocusableInteractive: options are reached with the arrow keys through aria-activedescendant, never by tabbing
            // biome-ignore lint/a11y/useKeyWithClickEvents: every key of this widget is handled on the combobox input above
            <li
              key={option.key}
              className={option.ambiguous ? 'hit ambiguous' : 'hit'}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a list item is what an option is; the role is what tells a screen reader so
              role="option"
              id={optionId(id, at)}
              aria-selected={at === state.active}
              // Swallowed on mousedown, so the field does not lose focus first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(option)}
            >
              <span className="hit-name">{option.label}</span>
              <span className="hit-type">{option.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
