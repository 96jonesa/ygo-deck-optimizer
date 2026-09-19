import { describe, expect, it } from 'vitest';
import { NAMED_CARD_MAX as CORE_NAMED_CARD_MAX } from '../../../../src/core/model/template';
import {
  type CopyRange,
  commitRange,
  NAMED_CARD_MAX,
  parseCount,
  rangeLabel,
  stepRange,
} from '../../../../src/renderer/src/model/copy-range';

const range = (min: number, max: number): CopyRange => ({ min, max });

describe('NAMED_CARD_MAX', () => {
  // The renderer cannot import `core` (TDD §3), so the copy limit is written
  // out here; this test is what keeps the two from drifting apart.
  it('is the copy limit `core` enforces', () => {
    expect(NAMED_CARD_MAX).toBe(CORE_NAMED_CARD_MAX);
  });
});

describe('rangeLabel', () => {
  it('is the two ends around an en dash, as the user reads them', () => {
    expect(rangeLabel(0, 3)).toBe('0–3');
    expect(rangeLabel(13, 33)).toBe('13–33');
  });

  it('is one number when the line holds exactly that many', () => {
    expect(rangeLabel(5, 5)).toBe('5');
    expect(rangeLabel(0, 0)).toBe('0');
  });
});

describe('parseCount', () => {
  it('reads a whole number', () => {
    expect(parseCount('0')).toBe(0);
    expect(parseCount('12')).toBe(12);
    expect(parseCount(' 7 ')).toBe(7);
  });

  it('is nothing for a field the user has emptied, so the value on hand stands', () => {
    expect(parseCount('')).toBeNull();
    expect(parseCount('   ')).toBeNull();
  });

  it('refuses what a copy count cannot be: a sign, a fraction, a word', () => {
    expect(parseCount('-1')).toBeNull();
    expect(parseCount('+2')).toBeNull();
    expect(parseCount('1.5')).toBeNull();
    expect(parseCount('two')).toBeNull();
    expect(parseCount('1e3')).toBeNull();
  });
});

describe('commitRange', () => {
  it('sets the end that was edited', () => {
    expect(commitRange(range(0, 3), 'min', '2', 40)).toEqual(range(2, 3));
    expect(commitRange(range(0, 3), 'max', '2', 40)).toEqual(range(0, 2));
  });

  it('keeps the range as it was while the field is empty mid-edit', () => {
    expect(commitRange(range(2, 3), 'min', '', 40)).toEqual(range(2, 3));
    expect(commitRange(range(2, 3), 'max', 'x', 40)).toEqual(range(2, 3));
  });

  it('carries `max` up with a `min` raised past it, rather than storing min > max', () => {
    expect(commitRange(range(0, 3), 'min', '5', 40)).toEqual(range(5, 5));
  });

  it('carries `min` down with a `max` lowered past it', () => {
    expect(commitRange(range(2, 3), 'max', '1', 40)).toEqual(range(1, 1));
  });

  it('clamps to the cap: no line holds more copies than the deck has cards', () => {
    expect(commitRange(range(0, 3), 'max', '99', 40)).toEqual(range(0, 40));
    expect(commitRange(range(0, 3), 'min', '99', 40)).toEqual(range(40, 40));
  });

  it('does NOT clamp a named card to three: `max` 4 is the error `analyze` reports', () => {
    expect(commitRange(range(0, 3), 'max', '4', 40)).toEqual(range(0, 4));
  });

  it('accepts zero at either end', () => {
    expect(commitRange(range(2, 3), 'min', '0', 40)).toEqual(range(0, 3));
    expect(commitRange(range(2, 3), 'max', '0', 40)).toEqual(range(0, 0));
  });
});

describe('stepRange', () => {
  it('moves one end by one, which is what the arrow keys do', () => {
    expect(stepRange(range(1, 3), 'min', 1, 40)).toEqual(range(2, 3));
    expect(stepRange(range(1, 3), 'max', -1, 40)).toEqual(range(1, 2));
  });

  it('stops at zero rather than going negative', () => {
    expect(stepRange(range(0, 3), 'min', -1, 40)).toEqual(range(0, 3));
    expect(stepRange(range(0, 0), 'max', -1, 40)).toEqual(range(0, 0));
  });

  it('stops at the cap', () => {
    expect(stepRange(range(0, 40), 'max', 1, 40)).toEqual(range(0, 40));
  });

  it('pushes the other end along, as typing the same number would', () => {
    expect(stepRange(range(3, 3), 'min', 1, 40)).toEqual(range(4, 4));
    expect(stepRange(range(2, 2), 'max', -1, 40)).toEqual(range(1, 1));
  });
});
