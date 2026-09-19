import { describe, expect, it } from 'vitest';
import {
  activeHit,
  activeOptionId,
  EMPTY_PICKER,
  hitLabel,
  optionId,
  type PickerState,
  pickerRows,
  pickerStatus,
  reducePicker,
} from '../../../../src/renderer/src/model/picker';
import type { CardHit } from '../../../../src/shared/types';

function hit(passcode: number, name: string, typeline: string): CardHit {
  return { passcode, name, typeline };
}

const ASH = hit(
  14558127,
  'Ash Blossom & Joyous Spring',
  'Level 3 · FIRE · Zombie · Tuner Effect Monster',
);
const MAXX = hit(23434538, 'Maxx "C"', 'Level 2 · EARTH · Beast · Effect Monster');
const DROLL = hit(94145021, 'Droll & Lock Bird', 'Level 1 · WIND · Winged Beast · Effect Monster');

/** The two Black Luster Soldiers: one name, two cards, told apart by the typeline alone. */
const BLS_RITUAL = hit(
  5405694,
  'Black Luster Soldier',
  'Level 8 · EARTH · Warrior · Ritual Monster',
);
const BLS_NORMAL = hit(
  72989439,
  'Black Luster Soldier',
  'Level 7 · EARTH · Warrior · Normal Monster',
);

/** Typed `query`, answered with `hits`: the state a picker is in with its list open. */
function showing(query: string, hits: CardHit[], active = -1): PickerState {
  const typed = reducePicker(EMPTY_PICKER, { type: 'query', query });
  const answered = reducePicker(typed, { type: 'hits', query, hits });
  return active < 0 ? answered : { ...answered, active };
}

describe('reducePicker', () => {
  describe('query', () => {
    it('opens the list and forgets which row was active', () => {
      const state = reducePicker(showing('ash', [ASH, MAXX], 1), { type: 'query', query: 'ashe' });
      expect(state.query).toBe('ashe');
      expect(state.open).toBe(true);
      expect(state.active).toBe(-1);
    });

    it('keeps the previous hits, so the list does not blink between two keystrokes', () => {
      const state = reducePicker(showing('ash', [ASH]), { type: 'query', query: 'ash ' });
      expect(state.hits).toEqual([ASH]);
      // …but says they answer the older query, so they are not read as this one's.
      expect(state.answered).toBe('ash');
    });

    it('closes the list when the query is emptied', () => {
      const state = reducePicker(showing('ash', [ASH]), { type: 'query', query: '' });
      expect(state.open).toBe(false);
    });
  });

  describe('hits', () => {
    it('shows the answer to the query that is typed', () => {
      const state = reducePicker(showing('', []), { type: 'query', query: 'ash' });
      const answered = reducePicker(state, { type: 'hits', query: 'ash', hits: [ASH] });
      expect(answered.hits).toEqual([ASH]);
      expect(answered.answered).toBe('ash');
    });

    it('drops the answer to a query that is no longer typed', () => {
      const typing = reducePicker(showing('ash', [ASH]), { type: 'query', query: 'maxx' });
      const stale = reducePicker(typing, { type: 'hits', query: 'ash', hits: [ASH, MAXX] });
      expect(stale).toBe(typing);
    });

    it('pulls the active row back inside a shorter list', () => {
      const three = showing('a', [ASH, MAXX, DROLL], 2);
      const one = reducePicker(reducePicker(three, { type: 'query', query: 'ash' }), {
        type: 'hits',
        query: 'ash',
        hits: [ASH],
      });
      expect(one.active).toBe(-1);
    });

    it('leaves nothing active when the answer is empty', () => {
      const state = reducePicker(showing('zzz', [ASH], 0), {
        type: 'hits',
        query: 'zzz',
        hits: [],
      });
      expect(state.active).toBe(-1);
    });
  });

  describe('move', () => {
    it('starts at the first row on the way down', () => {
      expect(reducePicker(showing('a', [ASH, MAXX]), { type: 'move', by: 1 }).active).toBe(0);
    });

    it('starts at the last row on the way up, as a combobox does with nothing selected', () => {
      expect(reducePicker(showing('a', [ASH, MAXX, DROLL]), { type: 'move', by: -1 }).active).toBe(
        2,
      );
    });

    it('steps down one row', () => {
      expect(
        reducePicker(showing('a', [ASH, MAXX, DROLL], 0), { type: 'move', by: 1 }).active,
      ).toBe(1);
    });

    it('stops at the last row instead of running past it', () => {
      const last = showing('a', [ASH, MAXX], 1);
      expect(reducePicker(last, { type: 'move', by: 1 }).active).toBe(1);
    });

    it('stops at the first row instead of running past it', () => {
      const first = showing('a', [ASH, MAXX], 0);
      expect(reducePicker(first, { type: 'move', by: -1 }).active).toBe(0);
    });

    it('re-opens a closed list that still has hits', () => {
      const closed = reducePicker(showing('ash', [ASH, MAXX]), { type: 'close' });
      const moved = reducePicker(closed, { type: 'move', by: 1 });
      expect(moved.open).toBe(true);
      expect(moved.active).toBe(0);
    });

    it('does nothing with no hits to move through', () => {
      const empty = showing('zzz', []);
      expect(reducePicker(empty, { type: 'move', by: 1 })).toBe(empty);
    });
  });

  describe('close', () => {
    it('closes the list and leaves no row active', () => {
      const state = reducePicker(showing('ash', [ASH, MAXX], 1), { type: 'close' });
      expect(state.open).toBe(false);
      expect(state.active).toBe(-1);
      // The query survives the first Escape: only the popup is dismissed.
      expect(state.query).toBe('ash');
    });
  });

  describe('reset', () => {
    it('empties the picker, so the next search starts clean', () => {
      expect(reducePicker(showing('ash', [ASH, MAXX], 1), { type: 'reset' })).toEqual(EMPTY_PICKER);
    });
  });
});

describe('pickerStatus', () => {
  it('says the index is not ready whatever is typed', () => {
    for (const state of ['idle', 'loading', 'error'] as const)
      expect(pickerStatus(showing('ash', [ASH]), state)).toBe('not-ready');
  });

  it('distinguishes an empty query from no matches', () => {
    expect(pickerStatus(EMPTY_PICKER, 'ready')).toBe('empty-query');
    expect(pickerStatus(showing('zzzz', []), 'ready')).toBe('no-matches');
  });

  it('treats whitespace as an empty query', () => {
    expect(pickerStatus(showing('   ', []), 'ready')).toBe('empty-query');
  });

  it('waits for the answer rather than claiming no matches', () => {
    const typing = reducePicker(showing('ash', [ASH]), { type: 'query', query: 'ashx' });
    expect(pickerStatus(typing, 'ready')).toBe('searching');
  });

  it('shows results once they answer what is typed', () => {
    expect(pickerStatus(showing('ash', [ASH]), 'ready')).toBe('results');
  });
});

describe('activeHit', () => {
  it('is the row Enter would pick', () => {
    expect(activeHit(showing('a', [ASH, MAXX], 1))).toEqual(MAXX);
  });

  it('is nothing when no row is active', () => {
    expect(activeHit(showing('a', [ASH, MAXX]))).toBeNull();
  });
});

describe('optionId', () => {
  it('is unique per picker and per row, so two pickers can share a page', () => {
    expect(optionId('line-3', 2)).not.toBe(optionId('line-4', 2));
    expect(optionId('line-3', 2)).not.toBe(optionId('line-3', 3));
  });
});

describe('activeOptionId', () => {
  it('names the active row for aria-activedescendant', () => {
    expect(activeOptionId('p', showing('a', [ASH, MAXX], 1))).toBe(optionId('p', 1));
  });

  it('is undefined with no active row, so the attribute is left off', () => {
    expect(activeOptionId('p', showing('a', [ASH, MAXX]))).toBeUndefined();
  });
});

describe('pickerRows', () => {
  it('marks the rows whose name alone does not identify the card', () => {
    const rows = pickerRows([BLS_RITUAL, BLS_NORMAL, ASH]);
    expect(rows.map((row) => row.ambiguous)).toEqual([true, true, false]);
  });

  it('keeps both namesakes, each with its own typeline', () => {
    const rows = pickerRows([BLS_RITUAL, BLS_NORMAL]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.hit.typeline)).toEqual([
      'Level 8 · EARTH · Warrior · Ritual Monster',
      'Level 7 · EARTH · Warrior · Normal Monster',
    ]);
  });

  it('keeps the order the search gave', () => {
    expect(pickerRows([MAXX, ASH, DROLL]).map((row) => row.hit.passcode)).toEqual([
      MAXX.passcode,
      ASH.passcode,
      DROLL.passcode,
    ]);
  });
});

describe('hitLabel', () => {
  it('carries the typeline, the only thing telling two namesakes apart', () => {
    expect(hitLabel(BLS_RITUAL)).not.toBe(hitLabel(BLS_NORMAL));
    expect(hitLabel(BLS_RITUAL)).toContain('Level 8 · EARTH · Warrior · Ritual Monster');
    expect(hitLabel(BLS_RITUAL)).toContain('Black Luster Soldier');
  });
});

describe('typing, then picking', () => {
  it('walks down twice and picks the second row', () => {
    let state = showing('black luster soldier', [BLS_RITUAL, BLS_NORMAL]);
    state = reducePicker(state, { type: 'move', by: 1 });
    state = reducePicker(state, { type: 'move', by: 1 });
    expect(activeHit(state)).toEqual(BLS_NORMAL);
    expect(reducePicker(state, { type: 'reset' })).toEqual(EMPTY_PICKER);
  });

  it('cannot pick a row from a list that has closed', () => {
    const closed = reducePicker(showing('ash', [ASH], 0), { type: 'close' });
    expect(activeHit(closed)).toBeNull();
  });

  it('never shows an answer that a newer keystroke has overtaken', () => {
    // Two searches in flight; the slower one answers the older query, and loses.
    let state = reducePicker(EMPTY_PICKER, { type: 'query', query: 'as' });
    state = reducePicker(state, { type: 'query', query: 'ash' });
    state = reducePicker(state, { type: 'hits', query: 'ash', hits: [ASH] });
    state = reducePicker(state, { type: 'hits', query: 'as', hits: [MAXX, DROLL] });
    expect(state.hits).toEqual([ASH]);
    expect(pickerStatus(state, 'ready')).toBe('results');
  });
});
