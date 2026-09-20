import { describe, expect, it } from 'vitest';
import {
  CRITERION_WEIGHT_MAX as CORE_CRITERION_WEIGHT_MAX,
  CRITERION_WHENS as CORE_CRITERION_WHENS,
  DECK_SIZE_MAX as CORE_DECK_SIZE_MAX,
  DECK_SIZE_MIN as CORE_DECK_SIZE_MIN,
  HAND_SIZES as CORE_HAND_SIZES,
  RUN_MODES as CORE_RUN_MODES,
  handSizeForMode as coreHandSizeForMode,
} from '../../../../src/core/model/template';
import {
  CRITERION_WEIGHT_MAX,
  CRITERION_WEIGHT_MIN,
  CRITERION_WHENS,
  commitDeckSize,
  commitWeight,
  DECK_SIZE_MAX,
  DECK_SIZE_MIN,
  HAND_SIZES,
  handSizeForMode,
  isHandSize,
  MODE_LABELS,
  RUN_MODES,
  WHEN_LABELS,
} from '../../../../src/renderer/src/model/deck-form';

// The renderer cannot import `core` (TDD §3), so these bounds are written out
// here; this group is what keeps the two copies from drifting apart.
describe('the bounds `core` enforces', () => {
  it('has the same deck-size bounds', () => {
    expect([DECK_SIZE_MIN, DECK_SIZE_MAX]).toEqual([CORE_DECK_SIZE_MIN, CORE_DECK_SIZE_MAX]);
  });

  it('has the same hand sizes', () => {
    expect(HAND_SIZES).toEqual([...CORE_HAND_SIZES]);
  });

  it('has the same run modes and criterion tags, in the same order', () => {
    expect(RUN_MODES).toEqual([...CORE_RUN_MODES]);
    expect(CRITERION_WHENS).toEqual([...CORE_CRITERION_WHENS]);
  });

  it('pairs a mode with the same hand size `core` holds a template to', () => {
    for (const mode of RUN_MODES) expect(handSizeForMode(mode)).toBe(coreHandSizeForMode(mode));
  });

  it('has a label for every mode and every tag: no picker row can come out blank', () => {
    for (const mode of RUN_MODES) expect(MODE_LABELS[mode].title).not.toBe('');
    for (const when of CRITERION_WHENS) expect(WHEN_LABELS[when]).not.toBe('');
  });
});

describe('commitDeckSize', () => {
  it('takes a size a Main Deck can be', () => {
    expect(commitDeckSize('40', 40)).toBe(40);
    expect(commitDeckSize('47', 40)).toBe(47);
    expect(commitDeckSize('60', 40)).toBe(60);
  });

  it('holds the size on hand while the field is empty mid-edit', () => {
    expect(commitDeckSize('', 47)).toBe(47);
    expect(commitDeckSize('x', 47)).toBe(47);
  });

  it('clamps to the bounds rather than storing a deck no rulebook allows', () => {
    expect(commitDeckSize('39', 40)).toBe(40);
    expect(commitDeckSize('0', 40)).toBe(40);
    expect(commitDeckSize('61', 40)).toBe(60);
    expect(commitDeckSize('600', 40)).toBe(60);
  });

  it('accepts each bound itself', () => {
    expect(commitDeckSize(String(DECK_SIZE_MIN), 50)).toBe(DECK_SIZE_MIN);
    expect(commitDeckSize(String(DECK_SIZE_MAX), 50)).toBe(DECK_SIZE_MAX);
  });
});

describe('isHandSize', () => {
  it('is true of the two openings the tool models', () => {
    expect(isHandSize(5)).toBe(true);
    expect(isHandSize(6)).toBe(true);
  });

  it('is false either side of them: there is no hand of 4 or 7', () => {
    expect(isHandSize(4)).toBe(false);
    expect(isHandSize(7)).toBe(false);
    expect(isHandSize(0)).toBe(false);
  });
});

/**
 * What a criterion may be worth (PRD §5.6). The bounds are written out here as
 * everything else in `deck-form` is — the renderer takes no code from `core`
 * (TDD §3) — so the test that matters is that the two copies agree.
 */
describe('commitWeight', () => {
  it('holds the same bounds core does', () => {
    expect(CRITERION_WEIGHT_MAX).toBe(CORE_CRITERION_WEIGHT_MAX);
    expect(CRITERION_WEIGHT_MIN).toBe(1);
  });

  it('reads a whole number', () => {
    expect(commitWeight('7', 1)).toBe(7);
    expect(commitWeight(' 12 ', 1)).toBe(12);
  });

  it('leaves the weight as it was when the field cannot be read', () => {
    expect(commitWeight('', 4)).toBe(4);
    expect(commitWeight('lots', 4)).toBe(4);
    expect(commitWeight('1.5', 4)).toBe(4);
  });

  it('clamps to the bounds: a criterion worth nothing is one that is not there', () => {
    expect(commitWeight('0', 3)).toBe(CRITERION_WEIGHT_MIN);
    expect(commitWeight(String(CRITERION_WEIGHT_MAX + 1), 3)).toBe(CRITERION_WEIGHT_MAX);
  });
});
