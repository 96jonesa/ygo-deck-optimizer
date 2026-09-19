import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WorkdirHealth } from '../../shared/types';
import { CARD_DATABASE_LOCATIONS, collectCardSources, collectStringsConf } from './loader';

// Is this folder an EDOPro install this tool can use? (TDD §13.) Lifted from
// the sibling's probe, minus its script-root and executable checks: all that
// is needed here is card data. Node only — no Electron.

/**
 * What the loader would find in `dir`. `ok` iff at least one non-empty `.cdb`
 * is there by the loader's own rules (TDD §4.4), so a folder that probes ok is
 * a folder that loads. A missing `strings.conf` is reported, not failed on:
 * everything but archetype descriptions works without one. Never throws.
 */
export function probeWorkdir(dir: string): WorkdirHealth {
  const failed = (problem: string): WorkdirHealth => ({
    ok: false,
    path: dir,
    databases: 0,
    stringsConf: 0,
    problems: [problem],
    notes: [],
  });

  try {
    if (dir === '' || !existsSync(dir)) return failed('the folder does not exist');
    if (!statSync(dir).isDirectory()) return failed('not a folder');

    const notes: string[] = [];
    // The loader skips an empty `cards.cdb` itself; an empty database anywhere
    // else would be opened and found to hold nothing, so it does not count.
    const databases = collectCardSources(dir).filter((source) => statSync(source.path).size > 0);
    const base = path.join(dir, 'cards.cdb');
    if (existsSync(base) && statSync(base).isFile() && statSync(base).size === 0)
      notes.push('cards.cdb is empty and was ignored');

    const problems: string[] = [];
    if (databases.length === 0)
      problems.push(`no card database found: expected ${CARD_DATABASE_LOCATIONS}`);

    const stringsConf = collectStringsConf(dir).length;
    if (stringsConf === 0 && databases.length > 0)
      notes.push('no strings.conf found: archetype names unavailable');

    return {
      ok: databases.length > 0,
      path: dir,
      databases: databases.length,
      stringsConf,
      problems,
      notes,
    };
  } catch (failure) {
    return failed(`the folder cannot be read: ${(failure as Error).message}`);
  }
}

/** Where an install conventionally lives, tried before asking (TDD §13). */
export function candidateWorkdirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') return ['C:\\ProjectIgnis', 'C:\\Games\\ProjectIgnis'];
  return [
    path.posix.join(home, 'ProjectIgnis'),
    path.posix.join(home, 'Applications', 'ProjectIgnis'),
    '/Applications/ProjectIgnis',
  ];
}

/** The first candidate that probes ok, or `null`: then the user is asked. */
export function autodetectWorkdir(
  candidates: readonly string[],
  probe: (dir: string) => WorkdirHealth,
): WorkdirHealth | null {
  for (const candidate of candidates) {
    const health = probe(candidate);
    if (health.ok) return health;
  }
  return null;
}
