import { describe, expect, it } from 'vitest';
import { statusHeadline, statusRows } from '../../../../src/renderer/src/model/card-status';
import type { CardStatus } from '../../../../src/shared/types';

const READY: CardStatus = {
  state: 'ready',
  workdir: '/Users/me/Applications/ProjectIgnis',
  databases: 5,
  skippedDatabases: 0,
  cards: 12132,
  replacedRows: 821,
  conflicts: 0,
  setnames: 604,
};

const IDLE: CardStatus = {
  state: 'idle',
  workdir: null,
  databases: 0,
  skippedDatabases: 0,
  cards: 0,
  replacedRows: 0,
  conflicts: 0,
  setnames: null,
};

describe('statusHeadline', () => {
  it('says what each state means for the user', () => {
    expect(statusHeadline(IDLE)).toBe('No EDOPro folder chosen yet');
    expect(statusHeadline({ ...IDLE, state: 'loading', workdir: '/w' })).toBe('Loading cards…');
    expect(statusHeadline(READY)).toBe('12,132 cards ready');
    expect(statusHeadline({ ...IDLE, state: 'error', workdir: '/w', error: 'disk on fire' })).toBe(
      'Could not load the cards: disk on fire',
    );
  });

  it('copes with an error that carries no reason', () => {
    expect(statusHeadline({ ...IDLE, state: 'error' })).toBe(
      'Could not load the cards: unknown error',
    );
  });
});

describe('statusRows', () => {
  it('lists state, folder, databases, cards, archetype names and conflicts', () => {
    expect(statusRows(READY)).toEqual([
      ['State', 'ready'],
      ['Folder', '/Users/me/Applications/ProjectIgnis'],
      ['Databases', '5'],
      ['Cards', '12,132'],
      ['Archetype names', '604'],
      ['Conflicts', '0'],
    ]);
  });

  it('mentions skipped databases only when there are some', () => {
    expect(statusRows({ ...READY, skippedDatabases: 2 })).toContainEqual([
      'Databases',
      '5 (2 skipped)',
    ]);
  });

  it('says what no strings.conf costs, rather than show a zero', () => {
    expect(statusRows({ ...READY, setnames: null })).toContainEqual([
      'Archetype names',
      'none — no strings.conf found, so archetype descriptions are unavailable',
    ]);
  });

  it('shows no folder as a dash, and only the state and folder until there is an index', () => {
    expect(statusRows(IDLE)).toEqual([
      ['State', 'idle'],
      ['Folder', '—'],
    ]);
  });
});
