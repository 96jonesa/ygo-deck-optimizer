import { describe, expect, it } from 'vitest';
import { editField, fieldOf, syncField } from '../../../../src/renderer/src/model/field';

describe('fieldOf', () => {
  it('starts holding what it was given, with nothing typed over it', () => {
    expect(fieldOf('monster')).toEqual({ draft: 'monster', seen: 'monster' });
  });
});

describe('editField', () => {
  it('takes the keystroke without waiting for anything', () => {
    expect(editField(fieldOf('monster'), 'monsterx').draft).toBe('monsterx');
  });

  it('leaves `seen` alone, so a later re-render does not undo the keystroke', () => {
    expect(editField(fieldOf('monster'), 'monsterx').seen).toBe('monster');
  });
});

describe('syncField', () => {
  it('gives back the same state when the value outside has not moved', () => {
    const state = editField(fieldOf('monster'), 'monst');
    expect(syncField(state, 'monster')).toBe(state);
  });

  it('adopts a value that changed outside — Load example, Clear, a reorder', () => {
    const state = editField(fieldOf('monster'), 'monst');
    expect(syncField(state, 'spell')).toEqual({ draft: 'spell', seen: 'spell' });
  });

  it('does not fight the typing it caused itself', () => {
    // The field tells the store, the store comes back with the same text: the
    // draft must survive, or every keystroke would be undone by its own echo.
    const typed = editField(fieldOf('monster'), 'monsterx');
    expect(syncField(typed, 'monster').draft).toBe('monsterx');
    expect(syncField(typed, 'monsterx')).toEqual({ draft: 'monsterx', seen: 'monsterx' });
  });

  it('adopts an outside value equal to what is typed, so the next change is seen', () => {
    const typed = editField(fieldOf(''), 'monster');
    const synced = syncField(typed, 'monster');
    expect(syncField(synced, '')).toEqual({ draft: '', seen: '' });
  });
});
