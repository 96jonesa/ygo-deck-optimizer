import type { CompletionOption, CompletionSite } from '../../../shared/types';
import { clampActive, type ListNav, moveActive } from './listbox';

// Inline name completion, as a reducer over what the caret and main do to it
// (TDD §3: the renderer holds logic only about what is on screen). WHICH names
// match, and what text each inserts, are decided in main and arrive as
// `CompletionOption`s; everything here is about the popup.

export interface CompletionState extends ListNav {
  /** The name the caret is in, as main last read it; `null` when it is in none. */
  site: CompletionSite | null;
  /** The rows on screen. */
  options: CompletionOption[];
  /** The `siteKey` the rows answer; `null` before the first answer. */
  answered: string | null;
  /**
   * The field text Escape (or a blur) dismissed the popup over. It stays shut
   * until the text CHANGES: walking the caret through a name must not throw
   * back up the list that was just dismissed, and every keystroke must.
   */
  dismissedText: string | null;
  /**
   * The field text and caret the site was read FROM. A site is a pair of
   * offsets into one exact string, so a pick made against any other string
   * would cut it in the wrong place — and between a keystroke and main's
   * answer, one keystroke behind is precisely what the site is.
   */
  sourceText: string;
  sourceCaret: number;
}

export const EMPTY_COMPLETION: CompletionState = {
  site: null,
  options: [],
  answered: null,
  open: false,
  active: -1,
  dismissedText: null,
  sourceText: '',
  sourceCaret: -1,
};

export type CompletionEvent =
  /** The caret moved or the text changed: this is the name it is in now, and the text it was read from. */
  | { type: 'site'; site: CompletionSite | null; text: string; caret: number }
  /** Rows came back; `key` is the `siteKey` they answer. */
  | { type: 'options'; key: string; options: CompletionOption[] }
  /** Arrow keys: `by` is +1 down, -1 up. */
  | { type: 'move'; by: number }
  /** Escape, a blur: the popup goes away and the text stays. */
  | { type: 'close' }
  /** Back to nothing, after a pick. */
  | { type: 'reset' };

/**
 * What a set of rows is an answer to. Deliberately NOT the span: the same
 * name typed in two places has the same rows, so a request that only moved is
 * still answered, and an answer is matched to the name rather than the place.
 */
export function siteKey(site: CompletionSite | null): string | null {
  return site === null ? null : `${site.kind}:${site.prefix}`;
}

function sameSite(a: CompletionSite | null, b: CompletionSite | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.prefix === b.prefix &&
    a.start === b.start &&
    a.end === b.end &&
    a.closed === b.closed
  );
}

export function reduceCompletion(state: CompletionState, event: CompletionEvent): CompletionState {
  switch (event.type) {
    case 'site': {
      const source = { sourceText: event.text, sourceCaret: event.caret };
      if (sameSite(state.site, event.site))
        return state.sourceText === event.text && state.sourceCaret === event.caret
          ? state
          : { ...state, ...source };
      const dismissedText = event.text === state.dismissedText ? state.dismissedText : null;
      // The rows are kept — a search answers in microseconds, and clearing
      // them would blink the list between two keystrokes — but `answered`
      // still says which name they are about, so `completionShows` can tell.
      return {
        ...state,
        ...source,
        site: event.site,
        dismissedText,
        active: -1,
        open: event.site !== null && dismissedText === null,
      };
    }
    case 'options': {
      if (event.key !== siteKey(state.site)) return state;
      return {
        ...state,
        options: event.options,
        answered: event.key,
        active: clampActive(state.active, event.options.length),
      };
    }
    case 'move':
      if (state.options.length === 0) return state;
      return {
        ...state,
        ...moveActive(state, state.options.length, event.by),
        dismissedText: null,
      };
    case 'close':
      return { ...state, open: false, active: -1, dismissedText: state.sourceText };
    case 'reset':
      return EMPTY_COMPLETION;
  }
}

/** Whether the listbox is on screen: open, answered for the name in hand, and not empty. */
export function completionShows(state: CompletionState): boolean {
  return state.open && state.answered === siteKey(state.site) && state.options.length > 0;
}

/** The row Enter would take, or `null`. */
export function activeCompletion(state: CompletionState): CompletionOption | null {
  return state.options[state.active] ?? null;
}

/**
 * Whether the site still describes the field as it is NOW — the guard a pick
 * has to pass. Between a keystroke and main's answer the site is one
 * keystroke old, and `applyCompletion` against its offsets would cut the text
 * in the wrong place; the answer arrives in well under a millisecond, so the
 * cost of refusing is a pick that has to be made again and never notices.
 */
export function completionFits(state: CompletionState, text: string, caret: number): boolean {
  return state.site !== null && state.sourceText === text && state.sourceCaret === caret;
}

/**
 * The field after a pick: `insert` in place of the site's span, and the caret
 * left after it. The span is why this is a replacement rather than an
 * insertion — a name already closed has its closing delimiter eaten, so
 * picking into `[Ash]` cannot leave `[Ash Blossom]]`.
 */
export function applyCompletion(
  text: string,
  site: CompletionSite,
  insert: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, site.start) + insert + text.slice(site.end),
    caret: site.start + insert.length,
  };
}

/**
 * The popup's left edge: at `desired` — where the name being completed starts,
 * so the rows line up under it and do not drift right as it is typed — but
 * never hanging off either side of the field it belongs to.
 */
export function clampPopupLeft(
  desired: number,
  popupWidth: number,
  containerWidth: number,
): number {
  if (popupWidth >= containerWidth) return 0;
  return Math.max(0, Math.min(desired, containerWidth - popupWidth));
}
