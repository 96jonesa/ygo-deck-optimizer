// A line's copy range, as two small number fields. All of it is arithmetic on
// what was typed: the renderer decides nothing about the range beyond keeping
// it a pair of whole numbers in order — whether it is a range the deck can
// hold is `analyze`'s to say (TDD §9).

/**
 * The game's copy limit. Written out rather than imported: the renderer takes
 * no code from `core` (TDD §3). A test holds it equal to `core`'s own.
 */
export const NAMED_CARD_MAX = 3;

export interface CopyRange {
  min: number;
  max: number;
}

export type RangeEnd = 'min' | 'max';

/** `0–3`, or `5` when a line holds exactly that many: the range as it reads. */
export function rangeLabel(min: number, max: number): string {
  return min === max ? `${min}` : `${min}–${max}`;
}

/**
 * What a number field holds, or `null` for a field that is empty or holds
 * something no copy count can be. Whole digits only: `-1`, `1.5` and `1e3`
 * are all refusals, not values rounded into something plausible.
 */
export function parseCount(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * The range after one end was typed into. An unreadable field leaves the range
 * as it was — a field is empty for a keystroke or two in the middle of an edit
 * — and an end typed past the other carries the other along, so the pair is
 * never stored out of order.
 */
export function commitRange(range: CopyRange, end: RangeEnd, text: string, cap: number): CopyRange {
  const value = parseCount(text);
  if (value === null) return range;
  const at = Math.min(value, cap);
  return end === 'min'
    ? { min: at, max: Math.max(at, range.max) }
    : { min: Math.min(at, range.min), max: at };
}

/**
 * One end moved by `by` — the arrow keys. Held inside `0`–`cap` by
 * `commitRange` alone: it clamps to the cap, and a step below zero prints as
 * `-1`, which `parseCount` refuses, so the range stays as it was. Clamping
 * here as well would be a floor no test could ever reach.
 */
export function stepRange(range: CopyRange, end: RangeEnd, by: number, cap: number): CopyRange {
  const from = end === 'min' ? range.min : range.max;
  return commitRange(range, end, String(from + by), cap);
}
