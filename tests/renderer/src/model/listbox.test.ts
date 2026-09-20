import { describe, expect, it } from 'vitest';
import {
  activeOptionId,
  clampActive,
  type ListNav,
  moveActive,
  optionId,
} from '../../../../src/renderer/src/model/listbox';

// The keyboard model both comboboxes share (TDD §3): the card picker, which
// replaces a field, and the inline completion, which opens at the caret.

const CLOSED: ListNav = { open: false, active: -1 };

describe('moveActive', () => {
  it('starts at the top going down and at the bottom going up', () => {
    expect(moveActive(CLOSED, 3, 1)).toEqual({ open: true, active: 0 });
    expect(moveActive(CLOSED, 3, -1)).toEqual({ open: true, active: 2 });
  });

  it('steps by one from wherever it is', () => {
    expect(moveActive({ open: true, active: 1 }, 3, 1)).toEqual({ open: true, active: 2 });
    expect(moveActive({ open: true, active: 1 }, 3, -1)).toEqual({ open: true, active: 0 });
  });

  it('stops at either end rather than wrapping', () => {
    expect(moveActive({ open: true, active: 2 }, 3, 1)).toEqual({ open: true, active: 2 });
    expect(moveActive({ open: true, active: 0 }, 3, -1)).toEqual({ open: true, active: 0 });
  });

  it('re-opens a list that Escape closed', () => {
    expect(moveActive({ open: false, active: 1 }, 3, 1)).toEqual({ open: true, active: 2 });
  });

  it('does nothing at all to an empty list', () => {
    expect(moveActive(CLOSED, 0, 1)).toEqual(CLOSED);
    expect(moveActive({ open: true, active: -1 }, 0, -1)).toEqual({ open: true, active: -1 });
  });
});

describe('clampActive', () => {
  it('keeps the active row where it is while the list is long enough', () => {
    expect(clampActive(1, 3)).toBe(1);
  });

  it('pulls it back to the last row of a list that shrank', () => {
    expect(clampActive(5, 3)).toBe(2);
  });

  it('leaves nothing active when nothing was active', () => {
    expect(clampActive(-1, 3)).toBe(-1);
  });

  it('leaves nothing active in an empty list', () => {
    expect(clampActive(0, 0)).toBe(-1);
  });
});

describe('optionId', () => {
  it('is built from the list id, so two comboboxes on a page never collide', () => {
    expect(optionId('pick-l1', 0)).toBe('pick-l1-option-0');
    expect(optionId('complete-c1', 3)).toBe('complete-c1-option-3');
  });
});

describe('activeOptionId', () => {
  it('names the active row', () => {
    expect(activeOptionId('pick-l1', { active: 2 })).toBe('pick-l1-option-2');
  });

  it('is undefined when nothing is active, so the attribute is left off', () => {
    expect(activeOptionId('pick-l1', { active: -1 })).toBeUndefined();
  });
});
