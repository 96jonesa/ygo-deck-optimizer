import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { type CardDatabaseSource, CardIndex } from '../../../src/core/cards/index';
import type { CardRecord } from '../../../src/core/cards/record';
import { SetnameTable } from '../../../src/core/cards/setnames';
import type { DescContext } from '../../../src/core/desc/context';
import { type Groups, matcher } from '../../../src/core/desc/evaluate';
import { type ImpliesContext, implies, intersects } from '../../../src/core/desc/implies';
import { parse } from '../../../src/core/desc/parser';
import { print } from '../../../src/core/desc/print';
import { same } from '../../helpers/assert';
import { type GenPool, genClause, genDescription } from '../../helpers/gen-desc';
import { weaken } from '../../helpers/implies-oracle';
import { seededRng } from '../../helpers/prng';

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

// Loaded once for every suite below; empty when the variable is unset and the suites skip.
const index = EDOPRO_WORKDIR
  ? CardIndex.fromDatabases(await initSqlJs(), databaseSources(EDOPRO_WORKDIR))
  : CardIndex.empty();
const ctx: DescContext = {
  cards: index,
  setnames: SetnameTable.fromLayers(EDOPRO_WORKDIR ? stringsConfLayers(EDOPRO_WORKDIR) : []),
  groups: { idOf: () => undefined, nameOf: () => undefined },
};

describe.skipIf(!EDOPRO_WORKDIR)('descriptions against a real EDOPro install', () => {
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

// TDD §15.1, Implication (1): soundness against the database. Whatever `implies` claims,
// no card of the real pool may contradict — a contradiction is a bug in an axiom (TDD §6.3).
describe.skipIf(!EDOPRO_WORKDIR)('implication against a real EDOPro install', () => {
  const cards = [...index.all()];
  const rng = seededRng(0x1a9c0020);
  const passcodes = rng.subset(cards, 1, 400).map((card) => card.code);
  const groups: Groups = new Map(
    ['g-a', 'g-b', 'g-c', 'g-d'].map((id) => [id, new Set(rng.subset(passcodes, 1, 8))]),
  );
  const pool: GenPool = {
    passcodes,
    groupIds: [...groups.keys()],
    // Setcodes real cards carry, sub-archetypes and their bases both, so that axiom 4 is exercised.
    setcodes: [...new Set(cards.flatMap((card) => card.setcodes))]
      .filter((code) => code > 0xfff || rng.chance(0.05))
      .flatMap((code) => [code, code & 0xfff])
      .slice(0, 300),
  };
  const implyCtx: ImpliesContext = { cards: index, groups };
  const report: Record<string, number> = {};

  it('holds the assumptions the box model makes of every card (boxes.ts)', () => {
    const SPELL = 0x2;
    const TRAP = 0x4;
    const COUNTER = 0x100000;
    const SPELL_ONLY_SUBKINDS = 0x10000 | 0x40000 | 0x80000 | 0x80;
    const bits = (n: number) => n.toString(2).replaceAll('0', '').length;
    const offenders = cards.filter((card) => {
      if ((card.type & SPELL) !== 0) return (card.type & COUNTER) !== 0;
      if ((card.type & TRAP) !== 0) return (card.type & SPELL_ONLY_SUBKINDS) !== 0;
      return (
        bits(card.attribute) > 1 ||
        bits(card.race & 0x3ffffff) > 1 ||
        (card.atk < 0 && card.atk !== -2) ||
        (card.def < 0 && card.def !== -2)
      );
    });
    expect(offenders.map((card) => card.name)).toEqual([]);
  });

  it('never claims an implication that a real card contradicts, over 4,000 pairs', () => {
    let holds = 0;
    let witnessed = 0;
    let checks = 0;
    for (let i = 0; i < 4000; i++) {
      const L = genDescription(rng, pool);
      const q = rng.chance(0.7)
        ? weaken(rng, L, (r) => genClause(r, pool))
        : genDescription(rng, pool);
      if (!implies(L, q, implyCtx)) continue;
      holds++;
      const inL = matcher(L, groups);
      const inQ = matcher(q, groups);
      let matched = 0;
      for (const card of cards) {
        if (!inL(card)) continue;
        matched++;
        same(inQ(card), true, () => `${card.name} matches L and not q: ${JSON.stringify([L, q])}`);
      }
      checks += matched;
      if (matched > 0) witnessed++;
    }
    Object.assign(report, {
      'pairs generated': 4000,
      'true implications': holds,
      'of which some real card matches L': witnessed,
      'card-level checks (card matches L, so must match q)': checks,
    });
    expect(holds).toBeGreaterThan(1000);
    expect(witnessed).toBeGreaterThan(500);
  });

  it('never misses an overlap that a real card witnesses, over 1,000 pairs', () => {
    let witnessed = 0;
    for (let i = 0; i < 1000; i++) {
      const L = genDescription(rng, pool);
      const q = rng.chance(0.5)
        ? weaken(rng, L, (r) => genClause(r, pool))
        : genDescription(rng, pool);
      const inL = matcher(L, groups);
      const inQ = matcher(q, groups);
      if (!cards.some((card) => inL(card) && inQ(card))) continue;
      witnessed++;
      same(intersects(L, q, implyCtx), true, () => JSON.stringify([L, q]));
    }
    report['overlaps witnessed by a real card'] = witnessed;
    expect(witnessed).toBeGreaterThan(200);
  });

  it('reports what was exercised', () => {
    console.info(`implication soundness over ${cards.length} cards:`, report);
    expect(Object.keys(report).length).toBeGreaterThanOrEqual(5);
  });
});
