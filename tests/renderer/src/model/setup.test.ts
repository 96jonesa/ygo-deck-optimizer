import { describe, expect, it } from 'vitest';
import { probeReadout, setupFailure, setupStage } from '../../../../src/renderer/src/model/setup';
import type { CardStatus, WorkdirHealth } from '../../../../src/shared/types';

function status(over: Partial<CardStatus> = {}): CardStatus {
  return {
    state: 'ready',
    workdir: '/edopro',
    databases: 20,
    skippedDatabases: 0,
    cards: 12132,
    replacedRows: 821,
    conflicts: 0,
    setnames: 805,
    ...over,
  };
}

function health(over: Partial<WorkdirHealth> = {}): WorkdirHealth {
  return {
    ok: true,
    path: '/edopro',
    databases: 20,
    stringsConf: 1,
    problems: [],
    notes: [],
    ...over,
  };
}

describe('setupStage', () => {
  it('waits while the first status has not arrived', () => {
    expect(setupStage(null)).toBe('loading');
  });

  it('waits while the cards load', () => {
    expect(setupStage(status({ state: 'loading', cards: 0 }))).toBe('loading');
  });

  it('is ready once there is an index', () => {
    expect(setupStage(status())).toBe('ready');
  });

  it('asks for a folder when none is set', () => {
    expect(setupStage(status({ state: 'idle', workdir: null, cards: 0 }))).toBe('choose');
  });

  it('asks for a folder when the load failed without one', () => {
    expect(
      setupStage(status({ state: 'error', workdir: null, cards: 0, error: 'no folder' })),
    ).toBe('choose');
  });

  it('reports the failure of a folder that IS set, rather than asking again', () => {
    const gone = status({ state: 'error', cards: 0, error: 'ENOENT: no such file or directory' });
    expect(setupStage(gone)).toBe('error');
  });
});

describe('setupFailure', () => {
  it('names the folder that failed and says what went wrong', () => {
    const lines = setupFailure(
      status({ state: 'error', workdir: '/gone', cards: 0, error: 'ENOENT: no such file' }),
    );
    expect(lines.join(' ')).toContain('/gone');
    expect(lines.join(' ')).toContain('ENOENT: no such file');
  });

  it('says something even when the failure carried no message', () => {
    const lines = setupFailure(status({ state: 'error', workdir: '/gone', cards: 0 }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).not.toContain('undefined');
  });

  it('has nothing to say about a state that did not fail', () => {
    expect(setupFailure(status())).toEqual([]);
  });
});

describe('probeReadout', () => {
  it('counts what a usable folder holds', () => {
    const readout = probeReadout(health({ databases: 20, stringsConf: 2 }));
    expect(readout.ok).toBe(true);
    expect(readout.headline).toContain('/edopro');
    expect(readout.headline).toContain('20');
  });

  it('keeps a missing strings.conf a note, not a problem: the folder is still usable', () => {
    const readout = probeReadout(
      health({ stringsConf: 0, notes: ['no strings.conf found: archetype names unavailable'] }),
    );
    expect(readout.ok).toBe(true);
    expect(readout.problems).toEqual([]);
    expect(readout.notes).toEqual(['no strings.conf found: archetype names unavailable']);
  });

  it('reports the problems of a folder that cannot be used', () => {
    const readout = probeReadout(
      health({ ok: false, databases: 0, problems: ['no card database found: expected cards.cdb'] }),
    );
    expect(readout.ok).toBe(false);
    expect(readout.problems).toEqual(['no card database found: expected cards.cdb']);
    expect(readout.headline).toContain('/edopro');
  });

  it('keeps problems and notes apart when a folder has both', () => {
    const readout = probeReadout(
      health({ ok: false, problems: ['no card database found'], notes: ['cards.cdb is empty'] }),
    );
    expect(readout.problems).toEqual(['no card database found']);
    expect(readout.notes).toEqual(['cards.cdb is empty']);
  });
});
