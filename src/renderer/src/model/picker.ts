import type { CardHit, CardState } from '../../../shared/types';
import { activeOptionId, clampActive, type ListNav, moveActive, optionId } from './listbox';

// The card picker's state, as a reducer over what the user and the search do
// to it (TDD §3: the renderer holds logic only about what is on screen). The
// component around it is props in, JSX out. What the arrow keys do is
// `model/listbox.ts`, shared with the inline completion.

export { activeOptionId, optionId };

export interface PickerState extends ListNav {
  /** What is typed. */
  query: string;
  /** The rows on screen. */
  hits: CardHit[];
  /** The query `hits` are the answer to; `null` before the first answer. */
  answered: string | null;
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
      return {
        ...state,
        hits: event.hits,
        answered: event.query,
        active: clampActive(state.active, event.hits.length),
      };
    }
    case 'move':
      // The same state, not a copy of it, when there is nothing to move through.
      if (state.hits.length === 0) return state;
      return { ...state, ...moveActive(state, state.hits.length, event.by) };
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
