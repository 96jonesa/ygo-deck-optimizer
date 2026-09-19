/**
 * A text field the user types into whose value ALSO changes from outside it —
 * Load example, Clear, a reorder that moves a different line under the same
 * row. Typing must never wait on anything (TDD §3), so the draft is what the
 * field shows and what was last seen from outside is what says whether an
 * outside change has happened at all.
 */
export interface FieldState {
  /** What the field shows. */
  draft: string;
  /** The value from outside that the draft was last reconciled against. */
  seen: string;
}

export function fieldOf(external: string): FieldState {
  return { draft: external, seen: external };
}

/** A keystroke: the draft moves, and `seen` does not, so the echo cannot undo it. */
export function editField(state: FieldState, draft: string): FieldState {
  return { draft, seen: state.seen };
}

/**
 * The state to render for the value `external` now holds. The same state —
 * the same object, so nothing re-renders — while the outside value is the one
 * already reconciled against, including when what came back is the very text
 * this field just sent.
 */
export function syncField(state: FieldState, external: string): FieldState {
  return external === state.seen ? state : { draft: external, seen: external };
}
