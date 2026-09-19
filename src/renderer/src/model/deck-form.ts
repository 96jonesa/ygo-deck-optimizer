import { parseCount } from './copy-range';

// The two template-wide numbers: how big the deck is, and how many cards the
// opening hand holds. Both are written out rather than imported, since the
// renderer takes no code from `core` (TDD §3); tests hold the copies equal.

/** A Main Deck holds 40 to 60 cards (PRD §5.1). */
export const DECK_SIZE_MIN = 40;
export const DECK_SIZE_MAX = 60;

/** Going first, going second (PRD §5.5). */
export const HAND_SIZES = [5, 6] as const;

export type HandSize = (typeof HAND_SIZES)[number];

/**
 * The deck size after the field was typed into. An unreadable field leaves the
 * size as it was; anything outside the bounds is clamped, because a deck of 39
 * is not a template the tool can mean something by.
 */
export function commitDeckSize(text: string, current: number): number {
  const value = parseCount(text);
  if (value === null) return current;
  return Math.min(Math.max(value, DECK_SIZE_MIN), DECK_SIZE_MAX);
}

export function isHandSize(size: number): size is HandSize {
  return HAND_SIZES.includes(size as HandSize);
}
