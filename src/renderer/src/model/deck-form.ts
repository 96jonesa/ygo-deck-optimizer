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

/** What a run ranks by (PRD §5.5); the order the mode picker offers them in. */
export const RUN_MODES = ['first', 'second', 'average'] as const;

export type RunMode = (typeof RUN_MODES)[number];

/** Which hand a criterion is judged for; absent on a criterion means `both`. */
export const CRITERION_WHENS = ['first', 'second', 'both'] as const;

export type CriterionWhen = (typeof CRITERION_WHENS)[number];

/**
 * The hand a mode's largest part holds. `core` holds the template to this
 * (`handSizeForMode`), so the editor sets the two together and a template it
 * writes can never say one thing in `mode` and another in `hand.size`.
 */
export function handSizeForMode(mode: RunMode): HandSize {
  return mode === 'first' ? 5 : 6;
}

/** What each mode is called on screen, and the hand it means. */
export const MODE_LABELS: Record<RunMode, { title: string; hand: string; hint: string }> = {
  first: {
    title: 'Going first',
    hand: '5 cards',
    hint: 'the criteria for going first, and those for either hand',
  },
  second: {
    title: 'Going second',
    hand: '6 cards',
    hint: 'the criteria for going second, and those for either hand',
  },
  average: {
    title: 'Average',
    hand: '5 and 6',
    hint: 'both of those, weighted evenly: the best ratio over a whole match-up',
  },
};

/** What each tag is called on the criterion that carries it. */
export const WHEN_LABELS: Record<CriterionWhen, string> = {
  first: 'going first',
  second: 'going second',
  both: 'either hand',
};

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
