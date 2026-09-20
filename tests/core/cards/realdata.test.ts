import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../../src/core/cards/index';
import { isMonster, matchSetcode } from '../../../src/core/cards/record';
import { SetnameTable } from '../../../src/core/cards/setnames';
import { ATTRIBUTE_VOCABULARY, RACE_VOCABULARY } from '../../../src/core/cards/vocabulary';
import { collectStringsConf } from '../../../src/main/edopro/loader';

// Opt-in integration tests against real data (TDD §15.1). Skipped in CI; run
// locally before touching core/cards:
//   BABELCDB_PATH=/path/to/BabelCDB/cards.cdb   (facts pinned to BabelCDB@47fc046)
//   EDOPRO_WORKDIR=/path/to/ProjectIgnis        (a real install, any version)
const BABELCDB_PATH = process.env.BABELCDB_PATH;
const EDOPRO_WORKDIR = process.env.EDOPRO_WORKDIR;

function popcount(value: number): number {
  let n = 0;
  for (let v = value >>> 0; v !== 0; v &= v - 1) n++;
  return n;
}

describe.skipIf(!BABELCDB_PATH)('BabelCDB@47fc046 cards.cdb', async () => {
  const SQL = await initSqlJs();
  const index = BABELCDB_PATH
    ? CardIndex.fromDatabases(SQL, [{ bytes: readFileSync(BABELCDB_PATH) }])
    : CardIndex.empty();

  it('loads the one database without skipping or conflicts', () => {
    expect(index.status).toMatchObject({
      databases: 1,
      skippedDatabases: 0,
      replacedRows: 0,
      conflicts: 0,
    });
  });

  // 12,252 Main Deck eligible official rows (TDD §4.2), minus the 273 of them
  // that are alternate artwork within ±10 of their target, minus the 2 far
  // reprints (Dark Magician 36996508, Polymerization 27847700).
  it('holds 11,977 cards', () => {
    expect(index.status.cards).toBe(12252 - 273 - 2);
  });

  // cards.cdb itself holds no pre-release row; those live in prerelease-*.cdb
  // beside it. Expected counts were computed independently of CardIndex (a
  // Python merge of the same files in the same sorted order).
  it('gains 114 cards from the prerelease-*.cdb layers, and loses them again by setting', () => {
    const dir = path.dirname(BABELCDB_PATH!);
    const layers = readdirSync(dir)
      .filter((name) => /^prerelease-.*\.cdb$/.test(name))
      .sort()
      .map((name) => ({ bytes: readFileSync(path.join(dir, name)) }));
    const databases = [{ bytes: readFileSync(BABELCDB_PATH!) }, ...layers];
    expect(layers).toHaveLength(7);

    const withPrerelease = CardIndex.fromDatabases(SQL, databases);
    expect(withPrerelease.status).toEqual({
      databases: 8,
      skippedDatabases: 0,
      cards: 12091,
      replacedRows: 0,
      conflicts: 0,
    });
    const released = CardIndex.fromDatabases(SQL, databases, { includePrerelease: false });
    expect(released.status.cards).toBe(11977);
  });

  it('gives every monster exactly one race bit and one attribute bit', () => {
    const monsters = [...index.all()].filter((card) => isMonster(card.type));
    expect(monsters.length).toBeGreaterThan(6000);
    const offenders = monsters.filter(
      (card) => popcount(card.race) + popcount(card.raceHi) !== 1 || popcount(card.attribute) !== 1,
    );
    expect(offenders.map((card) => card.name)).toEqual([]);
  });

  it('keeps every numeric field an integer below 2^32, and every level within 0-12', () => {
    const offenders = [...index.all()].filter((card) => {
      const { name: _name, setcodes, ...numeric } = card;
      const values = [...Object.values(numeric), ...setcodes];
      const sane = values.every((value) => Number.isInteger(value) && Math.abs(value) < 2 ** 32);
      return !sane || card.level < 0 || card.level > 12;
    });
    expect(offenders.map((card) => card.name)).toEqual([]);
  });

  it('decodes Odd-Eyes Pendulum Dragon as level 7, scales 4 and 4', () => {
    expect(index.get(16178681)).toMatchObject({
      name: 'Odd-Eyes Pendulum Dragon',
      level: 7,
      lscale: 4,
      rscale: 4,
    });
  });

  it('decodes the "?" ATK of Tragoedia as -2', () => {
    expect(index.get(98777036)).toMatchObject({ name: 'Tragoedia', atk: -2, def: -2 });
  });

  it('collapses the two far alternate artworks the ±10 window misses', () => {
    expect(index.get(36996508)).toBeUndefined();
    expect(index.get(27847700)).toBeUndefined();
    expect(index.get(46986414)?.name).toBe('Dark Magician');
    expect(index.get(24094653)?.name).toBe('Polymerization');
    expect(index.search('Dark Magician').filter((c) => c.name === 'Dark Magician')).toHaveLength(1);
  });

  it('finds the cards a player actually types three letters of', () => {
    // Ranking regression guards, on the real pool rather than a fixture: both
    // of these were wrong under one of the two obvious ranking rules.
    expect(index.search('ash')[0]?.name).toBe('Ash Blossom & Joyous Spring');
    expect(index.search('pot')[0]?.name).toBe('Pot of Greed');
    expect(index.search('maxx')[0]?.name).toBe('Maxx "C"');
    expect(index.search('nibiru')[0]?.name).toBe('Nibiru, the Primal Being');
    expect(index.search('called by')[0]?.name).toBe('Called by the Grave');
  });

  it('keeps Black Luster Soldier 10000100 as its own record, limited with the Ritual', () => {
    expect(index.get(10000100)).toMatchObject({ name: 'Black Luster Soldier', limitCode: 5405694 });
    expect(index.get(5405694)).toMatchObject({ name: 'Black Luster Soldier', limitCode: 5405694 });
  });

  it('keeps Harpie Lady 1 as a distinct card limited with Harpie Lady', () => {
    const hits = index.search('Harpie Lady 1').filter((card) => card.name === 'Harpie Lady 1');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ limitCode: 76812113 });
    expect(hits[0]!.code).not.toBe(76812113);
  });

  it('reads setcodes: Blue-Eyes White Dragon is a "Blue-Eyes" card', () => {
    const card = index.get(89631139)!;
    expect(card.setcodes.length).toBeGreaterThan(0);
    expect(card.setcodes.some((code) => matchSetcode(0xdd, code))).toBe(true);
  });

  it('points the limitCode of every kept alias at a card that is itself in the index', () => {
    const aliased = [...index.all()].filter((card) => card.limitCode !== card.code);
    expect(aliased).toHaveLength(13);
    expect(aliased.filter((card) => index.get(card.limitCode) === undefined)).toEqual([]);
  });
});

describe.skipIf(!EDOPRO_WORKDIR)('a real EDOPro install', () => {
  // TDD §4.5 order: config/, then expansions/, then each repository, sorted.
  const layers = EDOPRO_WORKDIR
    ? collectStringsConf(EDOPRO_WORKDIR).map((file) => readFileSync(file, 'utf8'))
    : [];
  const table = SetnameTable.fromLayers(layers);

  it('finds a base strings.conf and at least one repository layer', () => {
    expect(layers.length).toBeGreaterThanOrEqual(2);
    expect(table.size).toBeGreaterThan(500);
  });

  it('resolves "Magnet Warrior" through the layers to 0x3066', () => {
    expect(table.lookup('Magnet Warrior')).toEqual([0x3066]);
  });

  it('would resolve "Magnet Warrior" to the wrong code from the base file alone', () => {
    expect(SetnameTable.fromLayers(layers.slice(0, 1)).lookup('Magnet Warrior')).toEqual([0x2066]);
  });

  it('gives 0x46 the alternates Polymerization and Fusion', () => {
    expect(table.alternatesOf(0x46)).toEqual(['Polymerization', 'Fusion']);
    expect(table.lookup('Polymerization')).toContain(0x46);
    expect(table.lookup('Fusion')).toContain(0x46);
  });

  // What inline completion is for (PRD §5.2). `"Warrior"` is a PARSE ERROR on
  // this install — the delta layer gives the name to 0x2066 as well as 0x66 —
  // so a completion that did not carry the code would offer a dead end.
  describe('search', () => {
    it('offers both setcodes of "Warrior", each written so the parser takes it', () => {
      expect(table.lookup('Warrior')).toEqual([0x66, 0x2066]);
      expect(table.search('Warrior').slice(0, 2)).toEqual([
        { code: 0x66, name: 'Warrior', ambiguous: true },
        { code: 0x2066, name: 'Warrior', ambiguous: true },
      ]);
    });

    it('finds the two Sky Striker setcodes from a half-typed name, longest last', () => {
      expect(table.search('Sky Strik')).toEqual([
        { code: 0x115, name: 'Sky Striker', ambiguous: false },
        { code: 0x1115, name: 'Sky Striker Ace', ambiguous: false },
      ]);
    });

    it('finds an alternate spelling, not only the display name', () => {
      expect(table.nameOf(0x46)).toBe('Polymerization');
      expect(table.search('Fusio').map((hit) => [hit.name, hit.code])).toContainEqual([
        'Fusion',
        0x46,
      ]);
    });

    it('never offers a row whose name it would then refuse to resolve', () => {
      for (const query of ['a', 'e', 'ma', 'dark', 'war', 'blue'])
        for (const hit of table.search(query, 50))
          expect(table.lookup(hit.name)).toContain(hit.code);
    });

    it('answers a picker-sized query in well under a millisecond', () => {
      const started = performance.now();
      for (let i = 0; i < 200; i++) table.search('dark m');
      expect((performance.now() - started) / 200).toBeLessThan(1);
    });
  });

  it("agrees with the client's own race and attribute strings", () => {
    // `!system 1020+i` names race bit i; `!system 1010+i` names attribute bit i.
    const system = new Map<number, string>();
    for (const line of layers[0]!.split('\n')) {
      const m = /^!system (\d+) (.*?)\r?$/.exec(line);
      if (m) system.set(Number(m[1]), m[2]!);
    }
    for (const entry of RACE_VOCABULARY)
      expect(entry.name).toBe(system.get(1020 + Math.log2(entry.bit)));
    for (const entry of ATTRIBUTE_VOCABULARY)
      expect(entry.name).toBe(system.get(1010 + Math.log2(entry.bit)));
  });
});
