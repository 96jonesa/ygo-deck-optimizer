import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autodetectWorkdir, candidateWorkdirs, probeWorkdir } from '../../../src/main/edopro/probe';
import type { WorkdirHealth } from '../../../src/shared/types';
import { tempDirs } from '../../helpers/workdir';

const temp = tempDirs('ygo-probe-');

function health(dir: string, ok: boolean): WorkdirHealth {
  return {
    ok,
    path: dir,
    databases: ok ? 1 : 0,
    stringsConf: 0,
    problems: ok ? [] : ['nothing here'],
    notes: [],
  };
}

describe('probeWorkdir', () => {
  it('accepts a full install: databases and strings.conf layers counted, nothing to say', () => {
    const dir = temp.workdir({
      'cards.cdb': 'x',
      'expansions/a.cdb': 'x',
      'repositories/delta/cards.delta.cdb': 'x',
      'config/strings.conf': '!setname 0x1 A',
      'repositories/delta/strings.conf': '!setname 0x2 B',
    });
    expect(probeWorkdir(dir)).toEqual({
      ok: true,
      path: dir,
      databases: 3,
      stringsConf: 2,
      problems: [],
      notes: [],
    });
  });

  it('needs nothing but one non-empty database — no scripts, no executable', () => {
    const probed = probeWorkdir(temp.workdir({ 'repositories/delta/deep/cards.cdb': 'x' }));
    expect(probed.ok).toBe(true);
    expect(probed.databases).toBe(1);
    expect(probed.problems).toEqual([]);
  });

  it('is not ok with zero databases, and says what it looked for', () => {
    const probed = probeWorkdir(temp.workdir({ 'config/strings.conf': '!setname 0x1 A' }));
    expect(probed.ok).toBe(false);
    expect(probed.databases).toBe(0);
    expect(probed.problems).toHaveLength(1);
    expect(probed.problems[0]).toContain('no card database');
    expect(probed.problems[0]).toContain('cards.cdb');
  });

  it('reports a missing strings.conf as a NOTE, not a failure', () => {
    const probed = probeWorkdir(temp.workdir({ 'cards.cdb': 'x' }));
    expect(probed.ok).toBe(true);
    expect(probed.stringsConf).toBe(0);
    expect(probed.problems).toEqual([]);
    expect(probed.notes).toHaveLength(1);
    expect(probed.notes[0]).toContain('archetype names unavailable');
  });

  it('ignores an empty cards.cdb placeholder, with a note, when another database exists', () => {
    const probed = probeWorkdir(
      temp.workdir({
        'cards.cdb': '',
        'expansions/cards.cdb': 'x',
        'config/strings.conf': '!setname 0x1 A',
      }),
    );
    expect(probed.ok).toBe(true);
    expect(probed.databases).toBe(1);
    expect(probed.notes).toEqual(['cards.cdb is empty and was ignored']);
  });

  it('does not count an EMPTY database anywhere: only empty ones is not ok', () => {
    const probed = probeWorkdir(temp.workdir({ 'cards.cdb': '', 'expansions/empty.cdb': '' }));
    expect(probed.ok).toBe(false);
    expect(probed.databases).toBe(0);
  });

  it('fails for a directory that does not exist', () => {
    const dir = path.join(temp.dir(), 'nope');
    const probed = probeWorkdir(dir);
    expect(probed).toEqual({
      ok: false,
      path: dir,
      databases: 0,
      stringsConf: 0,
      problems: ['the folder does not exist'],
      notes: [],
    });
  });

  it('fails for a file', () => {
    const dir = temp.workdir({ 'cards.cdb': 'x' });
    const probed = probeWorkdir(path.join(dir, 'cards.cdb'));
    expect(probed.ok).toBe(false);
    expect(probed.problems).toEqual(['not a folder']);
  });

  it('fails, without throwing, for an empty path', () => {
    expect(probeWorkdir('').ok).toBe(false);
  });
});

describe('candidateWorkdirs', () => {
  it('tries the drive roots on Windows', () => {
    expect(candidateWorkdirs('win32', 'C:\\Users\\a')).toEqual([
      'C:\\ProjectIgnis',
      'C:\\Games\\ProjectIgnis',
    ]);
  });

  it('tries the home folder, ~/Applications and /Applications on macOS, in that order', () => {
    expect(candidateWorkdirs('darwin', '/Users/a')).toEqual([
      '/Users/a/ProjectIgnis',
      '/Users/a/Applications/ProjectIgnis',
      '/Applications/ProjectIgnis',
    ]);
  });

  it('treats every other platform as macOS', () => {
    expect(candidateWorkdirs('linux', '/home/a')).toEqual(candidateWorkdirs('darwin', '/home/a'));
  });
});

describe('autodetectWorkdir', () => {
  it('returns the health of the FIRST candidate that probes ok', () => {
    const probed: string[] = [];
    const found = autodetectWorkdir(['/a', '/b', '/c'], (dir) => {
      probed.push(dir);
      return health(dir, dir !== '/a');
    });
    expect(found).toEqual(health('/b', true));
    expect(probed).toEqual(['/a', '/b']);
  });

  it('returns null when no candidate is an install', () => {
    expect(autodetectWorkdir(['/a', '/b'], (dir) => health(dir, false))).toBeNull();
    expect(autodetectWorkdir([], (dir) => health(dir, true))).toBeNull();
  });

  it('finds a real directory with the real probe', () => {
    const install = temp.workdir({ 'cards.cdb': 'x' });
    const found = autodetectWorkdir([temp.dir(), install], probeWorkdir);
    expect(found?.path).toBe(install);
  });
});
