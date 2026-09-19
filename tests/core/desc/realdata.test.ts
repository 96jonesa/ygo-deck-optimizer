import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { type CardDatabaseSource, CardIndex } from '../../../src/core/cards/index';
import type { CardRecord } from '../../../src/core/cards/record';
import { SetnameTable } from '../../../src/core/cards/setnames';
import type { DescContext } from '../../../src/core/desc/context';
import { matcher } from '../../../src/core/desc/evaluate';
import { parse } from '../../../src/core/desc/parser';
import { print } from '../../../src/core/desc/print';

// Opt-in integration test against a real EDOPro install (TDD §15.1); skipped in CI.
//   EDOPRO_WORKDIR=/path/to/ProjectIgnis npm test
// The install can be any version, so counts are reported, not pinned.
const EDOPRO_WORKDIR = process.env.EDOPRO_WORKDIR;

/** Every `.cdb` under `dir`, recursively, in sorted path order. */
function cdbsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.cdb'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** TDD §4.4 load order: `cards.cdb`, then `expansions/`, then each repository, labelled. */
function databaseSources(workdir: string): CardDatabaseSource[] {
  const base = path.join(workdir, 'cards.cdb');
  const sources: CardDatabaseSource[] = [];
  if (existsSync(base) && statSync(base).size > 0) sources.push({ bytes: readFileSync(base) });
  for (const file of cdbsUnder(path.join(workdir, 'expansions')))
    sources.push({ bytes: readFileSync(file) });
  const repositories = path.join(workdir, 'repositories');
  for (const repository of existsSync(repositories) ? readdirSync(repositories).sort() : [])
    for (const file of cdbsUnder(path.join(repositories, repository)))
      sources.push({ bytes: readFileSync(file), repository });
  return sources;
}

/** TDD §4.5 order: config/, then expansions/, then each repository, sorted. */
function stringsConfLayers(workdir: string): string[] {
  const repositories = path.join(workdir, 'repositories');
  const files = [
    path.join(workdir, 'config', 'strings.conf'),
    path.join(workdir, 'expansions', 'strings.conf'),
    ...(existsSync(repositories) ? readdirSync(repositories) : [])
      .sort()
      .map((name) => path.join(repositories, name, 'strings.conf')),
  ];
  return files.filter((file) => existsSync(file)).map((file) => readFileSync(file, 'utf8'));
}

describe.skipIf(!EDOPRO_WORKDIR)('descriptions against a real EDOPro install', async () => {
  const SQL = await initSqlJs();
  const index = EDOPRO_WORKDIR
    ? CardIndex.fromDatabases(SQL, databaseSources(EDOPRO_WORKDIR))
    : CardIndex.empty();
  const ctx: DescContext = {
    cards: index,
    setnames: SetnameTable.fromLayers(EDOPRO_WORKDIR ? stringsConfLayers(EDOPRO_WORKDIR) : []),
    groups: { idOf: () => undefined, nameOf: () => undefined },
  };
  const counts: Record<string, number> = {};

  function matched(text: string): CardRecord[] {
    const result = parse(text, ctx);
    if (!result.ok) throw new Error(`${text}: ${result.message}`);
    const cards = [...index.all()].filter(matcher(result.desc, new Map()));
    counts[text] = cards.length;
    return cards;
  }

  /** `text` matches exactly the cards that pass `check`, and there are some. */
  function expectMatchesExactly(text: string, check: (card: CardRecord) => boolean) {
    const cards = matched(text);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((card) => !check(card)).map((card) => card.name)).toEqual([]);
    expect(cards.length).toBe(index.count(check));
  }

  // The obvious field checks, written with literals rather than the vocabulary under test.
  const isMonster = (card: CardRecord) => (card.type & 0x1) !== 0;
  const isFireBeastWarrior = (card: CardRecord) =>
    isMonster(card) && (card.attribute & 0x04) !== 0 && (card.race & 0x8000) !== 0;
  const SUBKIND_BITS = 0x10000 | 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x80;

  it('loads a card pool and a setname table', () => {
    expect(index.status.cards).toBeGreaterThan(10000);
    expect(ctx.setnames!.lookup('Sky Striker')).toHaveLength(1);
  });

  it('matches `level 4 monster` against exactly the Level 4 monsters', () => {
    expectMatchesExactly('level 4 monster', (card) => isMonster(card) && card.level === 4);
  });

  it('matches `FIRE Beast-Warrior monster` against exactly those', () => {
    expectMatchesExactly('FIRE Beast-Warrior monster', isFireBeastWarrior);
  });

  // The three-qualifier conjunction. No Level 7 FIRE Beast-Warrior has been printed (the real
  // levels are 1-6, 8 and 9), so that level checks agreement on "none" and Level 8 on "some".
  it('matches `level N FIRE beast-warrior monster` against exactly those', () => {
    const none = matched('level 7 FIRE beast-warrior monster');
    expect(none.length).toBe(index.count((card) => isFireBeastWarrior(card) && card.level === 7));
    expectMatchesExactly(
      'level 8 FIRE beast-warrior monster',
      (card) => isFireBeastWarrior(card) && card.level === 8,
    );
  });

  it('matches `normal spell` against exactly the Spells with no sub-kind bit', () => {
    expectMatchesExactly(
      'normal spell',
      (card) => (card.type & 0x2) !== 0 && (card.type & SUBKIND_BITS) === 0,
    );
  });

  it('matches `counter trap` against exactly the Counter Traps', () => {
    expectMatchesExactly(
      'counter trap',
      (card) => (card.type & 0x4) !== 0 && (card.type & 0x100000) !== 0,
    );
  });

  it('never matches a "?" ATK with `ATK 1500 or less`', () => {
    const cards = matched('ATK 1500 or less');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((card) => card.atk < 0)).toEqual([]);
    expect(index.count((card) => isMonster(card) && card.atk < 0)).toBeGreaterThan(0);
    expect(matched('ATK ?').length).toBe(index.count((card) => isMonster(card) && card.atk === -2));
  });

  it('resolves "Sky Striker" and matches its cards', () => {
    const cards = matched('"Sky Striker"');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.map((card) => card.name)).toContain('Sky Striker Ace - Raye');
  });

  it('rejects the ambiguous "Warrior", naming 0x66 and 0x2066', () => {
    const result = parse('"Warrior" monster', ctx);
    expect(result).toMatchObject({ ok: false, span: { start: 0, end: 9 } });
    expect(!result.ok && result.message).toContain('"Warrior":0x66');
    expect(!result.ok && result.message).toContain('"Warrior":0x2066');
  });

  it('accepts "Warrior":0x2066, and prints it back the same', () => {
    const result = parse('"Warrior":0x2066 monster', ctx);
    expect(result).toEqual({
      ok: true,
      desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'], archetypes: [0x2066] } }] },
    });
    expect(result.ok && print(result.desc, ctx)).toBe('"Warrior":0x2066 monster');
    expect(matched('"Warrior":0x2066 monster').length).toBeGreaterThan(0);
  });

  it('round-trips the canonical name of every archetype in the table that can be written', () => {
    const unwritable: number[] = [];
    for (let code = 1; code <= 0xffff; code++) {
      if (ctx.setnames!.nameOf(code) === undefined) continue;
      const desc = { anyOf: [{ t: 'clause' as const, clause: { archetypes: [code] } }] };
      const text = print(desc, ctx);
      if (text.startsWith('"?"')) unwritable.push(code);
      expect(parse(text, ctx), text).toEqual({ ok: true, desc });
    }
    counts['archetype names that cannot be written'] = unwritable.length;
    expect(unwritable.length).toBeLessThan(5);
  });

  it('reports the match counts', () => {
    console.info(`match counts over ${index.status.cards} cards:`, counts);
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(10);
  });
});
