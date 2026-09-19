import type { CardHit, CardState } from '../../../shared/types';

// The card picker's state, as a reducer over what the user and the search do
// to it (TDD §3: the renderer holds logic only about what is on screen). The
// component around it is props in, JSX out.

export interface PickerState {
  /** What is typed. */
  query: string;
  /** The rows on screen. */
  hits: CardHit[];
  /** The query `hits` are the answer to; `null` before the first answer. */
  answered: string | null;
  /** Whether the listbox is showing. */
  open: boolean;
  /** The active row, `-1` for none: what `aria-activedescendant` points at and Enter picks. */
  active: number;
}

export const EMPTY_PICKER: PickerState = {
  query: '',
  hits: [],
  answered: null,
  open: false,
  active: -1,
};

export type PickerEvent =
  /** A keystroke, or any other edit of the field. */
  | { type: 'query'; query: string }
  /** A search came back; `query` is what it answers. */
  | { type: 'hits'; query: string; hits: CardHit[] }
  /** Arrow keys: `by` is +1 down, -1 up. */
  | { type: 'move'; by: number }
  /** Escape, a blur, a pick: the popup goes away and the query stays. */
  | { type: 'close' }
  /** Back to an empty picker, after a pick. */
  | { type: 'reset' };

function clamp(at: number, last: number): number {
  return Math.min(Math.max(at, 0), last);
}

export function reducePicker(state: PickerState, event: PickerEvent): PickerState {
  switch (event.type) {
    case 'query':
      // The hits are kept — a search answers in microseconds, and clearing
      // them would blink the list between two keystrokes — but `answered`
      // still says which query they are about, so `pickerStatus` can tell.
      return { ...state, query: event.query, open: event.query !== '', active: -1 };
    case 'hits': {
      // The answer to a query that is no longer typed is not what to show.
      if (event.query !== state.query) return state;
      const active = state.active < 0 ? -1 : clamp(state.active, event.hits.length - 1);
      return {
        ...state,
        hits: event.hits,
        answered: event.query,
        active: event.hits.length === 0 ? -1 : active,
      };
    }
    case 'move': {
      const last = state.hits.length - 1;
      if (last < 0) return state;
      // Nothing active yet: down starts at the top, up at the bottom.
      const active =
        state.active < 0 ? (event.by > 0 ? 0 : last) : clamp(state.active + event.by, last);
      return { ...state, open: true, active };
    }
    case 'close':
      return { ...state, open: false, active: -1 };
    case 'reset':
      return EMPTY_PICKER;
  }
}

/**
 * What the picker has to say below the field. `not-ready`, `empty-query` and
 * `no-matches` are three different things and read differently; `searching`
 * only shows if a search ever takes longer than a frame (they take 0.025 ms).
 */
export type PickerStatus = 'not-ready' | 'empty-query' | 'searching' | 'no-matches' | 'results';

export function pickerStatus(state: PickerState, cardState: CardState): PickerStatus {
  if (cardState !== 'ready') return 'not-ready';
  if (state.query.trim() === '') return 'empty-query';
  if (state.answered !== state.query) return 'searching';
  return state.hits.length === 0 ? 'no-matches' : 'results';
}

/** The row Enter would pick, or `null`: a closed list has no active row. */
export function activeHit(state: PickerState): CardHit | null {
  return state.hits[state.active] ?? null;
}

/** The DOM id of one row. Every picker on the page has its own `listId`. */
export function optionId(listId: string, at: number): string {
  return `${listId}-option-${at}`;
}

/** What `aria-activedescendant` should be, or `undefined` to leave the attribute off. */
export function activeOptionId(listId: string, state: PickerState): string | undefined {
  return state.active < 0 ? undefined : optionId(listId, state.active);
}

export interface PickerRow {
  hit: CardHit;
  /** Another row has this name: the typeline is the only thing telling them apart. */
  ambiguous: boolean;
}

/**
 * The rows to draw, in the order the search gave. Two cards can share a name
 * and differ only by typeline — "Black Luster Soldier" is a Ritual Monster and
 * a Normal Monster — so those rows are marked, and the typeline shown louder.
 */
export function pickerRows(hits: readonly CardHit[]): PickerRow[] {
  const seen = new Map<string, number>();
  for (const hit of hits) seen.set(hit.name, (seen.get(hit.name) ?? 0) + 1);
  return hits.map((hit) => ({ hit, ambiguous: (seen.get(hit.name) ?? 0) > 1 }));
}

/** One card in a line of text: the name, and the typeline that identifies it. */
export function hitLabel(hit: CardHit): string {
  return `${hit.name} — ${hit.typeline}`;
}
