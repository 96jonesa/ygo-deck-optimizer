import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CardIndex, type CardIndexOptions, type SqlEngine } from '../../core/cards/index';
import { SetnameTable } from '../../core/cards/setnames';

// The filesystem walk over an EDOPro install (TDD §4.4-4.5, §16). Node only —
// no Electron — so the CLI harness and the tests use it as the app does.

/** Where `collectCardSources` looks, for the message that says it found nothing. */
export const CARD_DATABASE_LOCATIONS = 'cards.cdb, expansions/*.cdb or repositories/*/*.cdb';

/** One `.cdb` file of an install, in load order. */
export interface CardSourceFile {
  /** Absolute. */
  path: string;
  /** The `repositories/<name>/` the file is under; absent for `cards.cdb` and `expansions/`. */
  repository?: string;
}

function isDirectory(dir: string): boolean {
  return existsSync(dir) && statSync(dir).isDirectory();
}

function subdirectoriesOf(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every `.cdb` file under `dir`, recursively, sorted by its path relative to
 * `dir` — with `/` separators whatever the platform, so that the same install
 * loads in the same order everywhere.
 */
function cdbsUnder(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cdb'))
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort()
    .map((relative) => path.join(dir, relative));
}

/**
 * The install's card databases in load order (TDD §4.4): a non-empty
 * `cards.cdb`, then `expansions/` recursively, then each repository
 * recursively, repositories in sorted order and labelled with their name —
 * the label is what lets `CardIndex` tell a conflict between two repositories
 * from a delta doing its job. Later rows replace earlier ones.
 */
export function collectCardSources(workdir: string): CardSourceFile[] {
  const sources: CardSourceFile[] = [];
  const base = path.join(workdir, 'cards.cdb');
  // Some installs ship `cards.cdb` as an empty placeholder.
  if (existsSync(base) && statSync(base).isFile() && statSync(base).size > 0)
    sources.push({ path: base });
  for (const file of cdbsUnder(path.join(workdir, 'expansions'))) sources.push({ path: file });
  const repositories = path.join(workdir, 'repositories');
  for (const repository of subdirectoriesOf(repositories))
    for (const file of cdbsUnder(path.join(repositories, repository)))
      sources.push({ path: file, repository });
  return sources;
}

/**
 * The install's `strings.conf` files in EDOPro's layering order (TDD §4.5):
 * `config/`, then `expansions/`, then each repository's own, a later file
 * overriding a same-key entry. Only the files that exist.
 */
export function collectStringsConf(workdir: string): string[] {
  const repositories = path.join(workdir, 'repositories');
  return [
    path.join(workdir, 'config', 'strings.conf'),
    path.join(workdir, 'expansions', 'strings.conf'),
    ...subdirectoriesOf(repositories).map((name) => path.join(repositories, name, 'strings.conf')),
  ].filter((file) => existsSync(file) && statSync(file).isFile());
}

/** The card index of an install; `SQL` is an initialised sql.js (`await initSqlJs()`). */
export function loadCardIndex(
  workdir: string,
  SQL: SqlEngine,
  opts: CardIndexOptions = {},
): CardIndex {
  const sources = collectCardSources(workdir).map(({ path: file, repository }) =>
    repository === undefined
      ? { bytes: readFileSync(file) }
      : { bytes: readFileSync(file), repository },
  );
  return CardIndex.fromDatabases(SQL, sources, opts);
}

/** The install's archetype names, or `null` when it has no `strings.conf` at all (TDD §4.5). */
export function loadSetnames(workdir: string): SetnameTable | null {
  const files = collectStringsConf(workdir);
  if (files.length === 0) return null;
  return SetnameTable.fromLayers(files.map((file) => readFileSync(file, 'utf8')));
}
