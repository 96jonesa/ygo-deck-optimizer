import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, describe, expect, it } from 'vitest';
import {
  collectCardSources,
  collectStringsConf,
  loadCardIndex,
  loadSetnames,
} from '../../../src/main/edopro/loader';
import { buildCdb } from '../../helpers/fixture-cards';

const SQL = await initSqlJs();
const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A temporary EDOPro-shaped directory holding `files` (relative path → contents). */
function workdirOf(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ygo-loader-'));
  created.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

/** What `collectCardSources` found, relative to the workdir and with `/` separators. */
function relativeSources(workdir: string) {
  return collectCardSources(workdir).map(({ path: file, repository }) => ({
    path: path.relative(workdir, file).split(path.sep).join('/'),
    repository,
  }));
}

function relativeStrings(workdir: string): string[] {
  return collectStringsConf(workdir).map((file) =>
    path.relative(workdir, file).split(path.sep).join('/'),
  );
}

/** A database of one Normal Monster. */
function cdb(id: number, name: string, atk = 0): Uint8Array {
  return buildCdb(SQL, [{ id, name, atk }]);
}

describe('collectCardSources', () => {
  it('lists cards.cdb, then expansions/, then each repository — sorted, repositories labelled', () => {
    const workdir = workdirOf({
      'repositories/zeta/cards.cdb': 'x',
      'repositories/delta/prerelease.cdb': 'x',
      'repositories/delta/cards.delta.cdb': 'x',
      'repositories/delta/nested/deep/extra.cdb': 'x',
      'expansions/b.cdb': 'x',
      'expansions/a.cdb': 'x',
      'expansions/sub/c.cdb': 'x',
      'cards.cdb': 'x',
    });
    expect(relativeSources(workdir)).toEqual([
      { path: 'cards.cdb', repository: undefined },
      { path: 'expansions/a.cdb', repository: undefined },
      { path: 'expansions/b.cdb', repository: undefined },
      { path: 'expansions/sub/c.cdb', repository: undefined },
      { path: 'repositories/delta/cards.delta.cdb', repository: 'delta' },
      { path: 'repositories/delta/nested/deep/extra.cdb', repository: 'delta' },
      { path: 'repositories/delta/prerelease.cdb', repository: 'delta' },
      { path: 'repositories/zeta/cards.cdb', repository: 'zeta' },
    ]);
  });

  it('returns absolute paths under the workdir', () => {
    const workdir = workdirOf({ 'cards.cdb': 'x', 'expansions/a.cdb': 'x' });
    for (const source of collectCardSources(workdir)) {
      expect(path.isAbsolute(source.path)).toBe(true);
      expect(source.path.startsWith(workdir)).toBe(true);
    }
  });

  it('gives no `repository` key at all to cards.cdb and expansions/', () => {
    const workdir = workdirOf({ 'cards.cdb': 'x', 'expansions/a.cdb': 'x' });
    for (const source of collectCardSources(workdir)) expect('repository' in source).toBe(false);
  });

  it('skips an EMPTY cards.cdb, the placeholder some installs ship', () => {
    const workdir = workdirOf({ 'cards.cdb': '', 'expansions/cards.cdb': 'x' });
    expect(relativeSources(workdir)).toEqual([
      { path: 'expansions/cards.cdb', repository: undefined },
    ]);
  });

  it('is fine with missing directories, and with nothing at all', () => {
    expect(relativeSources(workdirOf({ 'cards.cdb': 'x' }))).toEqual([
      { path: 'cards.cdb', repository: undefined },
    ]);
    expect(relativeSources(workdirOf({ 'repositories/delta/a.cdb': 'x' }))).toEqual([
      { path: 'repositories/delta/a.cdb', repository: 'delta' },
    ]);
    expect(collectCardSources(workdirOf({}))).toEqual([]);
    expect(collectCardSources(path.join(workdirOf({}), 'no-such-dir'))).toEqual([]);
  });

  it('takes only .cdb FILES: not other files, not directories named like one, not loose files in repositories/', () => {
    const workdir = workdirOf({
      'expansions/notes.txt': 'x',
      'expansions/cards.cdb.bak': 'x',
      'expansions/folder.cdb/inner.txt': 'x',
      'expansions/folder.cdb/real.cdb': 'x',
      'repositories/stray.cdb': 'x',
      'repositories/lflists/0TCG.lflist.conf': 'x',
    });
    expect(relativeSources(workdir)).toEqual([
      { path: 'expansions/folder.cdb/real.cdb', repository: undefined },
    ]);
  });

  it('sorts by whole relative path, so a subdirectory sorts among the files', () => {
    const workdir = workdirOf({
      'expansions/m.cdb': 'x',
      'expansions/a/z.cdb': 'x',
      'expansions/z/a.cdb': 'x',
    });
    expect(relativeSources(workdir).map((s) => s.path)).toEqual([
      'expansions/a/z.cdb',
      'expansions/m.cdb',
      'expansions/z/a.cdb',
    ]);
  });
});

describe('collectStringsConf', () => {
  it('lists config/, then expansions/, then each repository in sorted order', () => {
    const workdir = workdirOf({
      'repositories/zeta/strings.conf': 'x',
      'repositories/delta/strings.conf': 'x',
      'expansions/strings.conf': 'x',
      'config/strings.conf': 'x',
    });
    expect(relativeStrings(workdir)).toEqual([
      'config/strings.conf',
      'expansions/strings.conf',
      'repositories/delta/strings.conf',
      'repositories/zeta/strings.conf',
    ]);
  });

  it('leaves out the files that are not there, and the translations', () => {
    const workdir = workdirOf({
      'config/languages/Deutsch/strings.conf': 'x',
      'repositories/lflists/0TCG.lflist.conf': 'x',
      'repositories/delta/strings.conf': 'x',
      'repositories/delta/script/strings.conf': 'x',
    });
    expect(relativeStrings(workdir)).toEqual(['repositories/delta/strings.conf']);
    expect(collectStringsConf(workdirOf({}))).toEqual([]);
  });
});

describe('loadCardIndex', () => {
  it('merges in load order: a repository row replaces the base row with the same id', () => {
    const workdir = workdirOf({
      'expansions/cards.cdb': cdb(90000001, 'Base Name', 1000),
      'repositories/delta/cards.delta.cdb': cdb(90000001, 'Delta Name', 2000),
    });
    const index = loadCardIndex(workdir, SQL);
    expect(index.get(90000001)).toMatchObject({ name: 'Delta Name', atk: 2000 });
    expect(index.status).toEqual({
      databases: 2,
      skippedDatabases: 0,
      cards: 1,
      replacedRows: 1,
      conflicts: 0,
    });
  });

  it('lets cards.cdb lose to expansions/, and expansions/ to a repository', () => {
    const workdir = workdirOf({
      'cards.cdb': cdb(90000001, 'From cards.cdb'),
      'expansions/x.cdb': cdb(90000001, 'From expansions'),
    });
    expect(loadCardIndex(workdir, SQL).get(90000001)?.name).toBe('From expansions');
  });

  it('counts a disagreement between two repositories as a conflict, thanks to the labels', () => {
    const workdir = workdirOf({
      'repositories/alpha/cards.cdb': cdb(90000001, 'Alpha Name'),
      'repositories/beta/cards.cdb': cdb(90000001, 'Beta Name'),
    });
    const index = loadCardIndex(workdir, SQL);
    expect(index.get(90000001)?.name).toBe('Beta Name');
    expect(index.status).toMatchObject({ databases: 2, replacedRows: 1, conflicts: 1 });
  });

  it('does not count a repository overriding itself as a conflict', () => {
    const workdir = workdirOf({
      'repositories/alpha/a.cdb': cdb(90000001, 'First'),
      'repositories/alpha/b.cdb': cdb(90000001, 'Second'),
    });
    expect(loadCardIndex(workdir, SQL).status).toMatchObject({ replacedRows: 1, conflicts: 0 });
  });

  it('skips a file that is not a database, and loads the rest', () => {
    const workdir = workdirOf({
      'expansions/broken.cdb': 'this is not sqlite',
      'expansions/cards.cdb': cdb(90000001, 'Survivor'),
    });
    expect(loadCardIndex(workdir, SQL).status).toMatchObject({
      databases: 1,
      skippedDatabases: 1,
      cards: 1,
    });
  });

  it('passes the options through', () => {
    const workdir = workdirOf({
      'expansions/cards.cdb': buildCdb(SQL, [
        { id: 90000001, name: 'Released' },
        { id: 90000002, name: 'Pre-release', ot: 0x101 },
      ]),
    });
    expect(loadCardIndex(workdir, SQL).status.cards).toBe(2);
    expect(loadCardIndex(workdir, SQL, { includePrerelease: false }).status.cards).toBe(1);
  });

  it('is empty for an empty workdir', () => {
    expect(loadCardIndex(workdirOf({}), SQL).status).toMatchObject({ databases: 0, cards: 0 });
  });
});

describe('loadSetnames', () => {
  it('layers the files in order: a repository overrides the base, and withdraws the old name', () => {
    // The real case (TDD §4.5): delta reassigns 0x1066 and 0x2066.
    const workdir = workdirOf({
      'config/strings.conf': '!setname 0x1066 Symphonic Warrior\n!setname 0x2066 Magnet Warrior\n',
      'repositories/delta/strings.conf':
        '!setname 0x1066 Magnet\n!setname 0x2066 Warrior\n!setname 0x3066 Magnet Warrior\n',
    });
    const table = loadSetnames(workdir);
    expect(table?.lookup('Magnet Warrior')).toEqual([0x3066]);
    expect(table?.lookup('Symphonic Warrior')).toEqual([]);
    expect(table?.nameOf(0x1066)).toBe('Magnet');
  });

  it('lets expansions/ override config/, and a repository override both', () => {
    const workdir = workdirOf({
      'config/strings.conf': '!setname 0x1 From config\n',
      'expansions/strings.conf': '!setname 0x1 From expansions\n!setname 0x2 From expansions\n',
      'repositories/delta/strings.conf': '!setname 0x2 From delta\n',
    });
    const table = loadSetnames(workdir);
    expect(table?.nameOf(0x1)).toBe('From expansions');
    expect(table?.nameOf(0x2)).toBe('From delta');
  });

  it('is null when the install has no strings.conf at all', () => {
    expect(loadSetnames(workdirOf({ 'cards.cdb': 'x' }))).toBeNull();
  });
});
