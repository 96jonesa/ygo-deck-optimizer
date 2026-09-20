// The keyboard model of an ARIA combobox popup, shared by the two that exist
// (TDD §3): the card picker, which stands in for a field, and the inline
// completion, which opens at the caret inside one. The two differ in what
// they list and how they are anchored, and in nothing about the arrow keys —
// so this is the part they share, rather than one component pressed into two
// shapes.

/** The part of a popup's state the arrow keys move. */
export interface ListNav {
  /** Whether the listbox is showing. */
  open: boolean;
  /** The active row, `-1` for none: what `aria-activedescendant` points at and Enter picks. */
  active: number;
}

/**
 * Arrow keys over a list of `count` rows: `by` is +1 down, -1 up. With
 * nothing active yet, down starts at the top and up at the bottom; either end
 * holds rather than wrapping; and the list re-opens, so the arrow keys bring
 * back a popup Escape dismissed. An empty list does not move at all.
 */
export function moveActive(nav: ListNav, count: number, by: number): ListNav {
  if (count <= 0) return nav;
  const last = count - 1;
  const active =
    nav.active < 0 ? (by > 0 ? 0 : last) : Math.min(Math.max(nav.active + by, 0), last);
  return { open: true, active };
}

/** The active row after the list has become `count` long: where it was, or gone. */
export function clampActive(active: number, count: number): number {
  if (active < 0 || count <= 0) return -1;
  return Math.min(active, count - 1);
}

/** The DOM id of one row. Every popup on the page has its own `listId`. */
export function optionId(listId: string, at: number): string {
  return `${listId}-option-${at}`;
}

/** What `aria-activedescendant` should be, or `undefined` to leave the attribute off. */
export function activeOptionId(listId: string, nav: Pick<ListNav, 'active'>): string | undefined {
  return nav.active < 0 ? undefined : optionId(listId, nav.active);
}
