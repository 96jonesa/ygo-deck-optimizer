import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  RACE_HI_YOKAI,
  RACE_SPELLCASTER,
  TYPE_LINK,
  TYPE_MONSTER,
  TYPE_NORMAL,
  TYPE_SPELL,
} from '../../../src/core/cards/constants';
import { CardIndex } from '../../../src/core/cards/index';
import { isMonster, isSpell } from '../../../src/core/cards/record';
import {
  buildCdb,
  CODE,
  FIXTURE_ROWS,
  type FixtureRow,
  POPULATION,
} from '../../helpers/fixture-cards';

const SQL = await initSqlJs();
const fixture = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, FIXTURE_ROWS) }]);

/** An index over unlabelled databases (as `cards.cdb` and `expansions/` are), in load order. */
function indexOf(...databases: FixtureRow[][]): CardIndex {
  return CardIndex.fromDatabases(
    SQL,
    databases.map((rows) => ({ bytes: buildCdb(SQL, rows) })),
  );
}

/** An index over `[repository, rows]` databases in load order; `undefined` is the base install. */
function layered(...databases: [string | undefined, FixtureRow[]][]): CardIndex {
  return CardIndex.fromDatabases(
    SQL,
    databases.map(([repository, rows]) => ({ bytes: buildCdb(SQL, rows), repository })),
  );
}

function named(...names: string[]): FixtureRow[] {
  return names.map((name, i) => ({ id: 1000 + i * 100, name }));
}

describe('CardIndex', () => {
  it('holds exactly the expected population of the fixture', () => {
    const codes = [...fixture.all()].map((card) => card.code).sort((a, b) => a - b);
    expect(codes).toEqual([...POPULATION].sort((a, b) => a - b));
    expect(fixture.status.cards).toBe(POPULATION.length);
  });

  describe('row decoding', () => {
    it('decodes an ordinary monster', () => {
      expect(fixture.get(CODE.vanillaDragon)).toEqual({
        code: CODE.vanillaDragon,
        name: 'Synthetic Vanilla Dragon',
        limitCode: CODE.vanillaDragon,
        ot: 0x3,
        type: TYPE_MONSTER | TYPE_NORMAL,
        atk: 3000,
        def: 2500,
        level: 8,
        lscale: 0,
        rscale: 0,
        race: 0x2000,
        raceHi: 0,
        attribute: 0x10,
        setcodes: [0xdd],
      });
    });

    it('reads the left scale from bits 24-31 and the right scale from bits 16-23', () => {
      expect(fixture.get(CODE.asymmetricPendulum)).toMatchObject({
        level: 4,
        lscale: 8,
        rscale: 3,
      });
    });

    it('unpacks four setcodes from an int64 with bit 63 set, without rounding', () => {
      expect(fixture.get(CODE.fourSetcodes)?.setcodes).toEqual([0xdd, 0x1066, 0x2066, 0x8fed]);
    });

    it('skips zero setcode slots instead of stopping at them', () => {
      expect(fixture.get(CODE.gappedSetcodes)?.setcodes).toEqual([0xabc, 0x1234]);
    });

    it('gives a card without setcodes an empty list', () => {
      expect(fixture.get(CODE.tunerFairy)?.setcodes).toEqual([]);
    });

    it('keeps "?" ATK and DEF as -2', () => {
      expect(fixture.get(CODE.unknownAtk)).toMatchObject({ atk: -2, def: -2 });
    });

    it('splits race into a low and a high 32-bit half, both non-negative', () => {
      const card = fixture.get(CODE.highRace)!;
      expect(card.race).toBe(RACE_SPELLCASTER);
      expect(card.raceHi).toBe(0xc0000000);
      expect((card.raceHi & RACE_HI_YOKAI) !== 0).toBe(true);
    });

    it('leaves the link-marker mask of a Link Spell in def', () => {
      expect(fixture.get(CODE.linkSpell)).toMatchObject({
        type: TYPE_SPELL | TYPE_LINK,
        def: 0x28,
      });
    });

    it('negates the level of a row whose raw level has bit 31 set, as the client does', () => {
      expect(fixture.get(CODE.negativeLevel)).toMatchObject({ level: -3, lscale: 0x80, rscale: 0 });
    });

    it('keeps every numeric field an integer below 2^32', () => {
      for (const card of fixture.all()) {
        const { name: _name, setcodes, ...numeric } = card;
        for (const value of [...Object.values(numeric), ...setcodes]) {
          expect(Number.isInteger(value)).toBe(true);
          expect(Math.abs(value)).toBeLessThan(2 ** 32);
        }
      }
    });
  });

  describe('population filter', () => {
    it.each([
      ['a Link monster', CODE.linkMonster],
      ['an Xyz monster', CODE.xyzMonster],
      ['a Fusion monster', CODE.fusionMonster],
      ['a Synchro monster', CODE.synchroMonster],
      ['a token', CODE.token],
      ['a skill', CODE.skill],
      ['a row that is none of Monster, Spell, Trap', CODE.noKind],
      ['a row that is both Spell and Trap', CODE.spellAndTrap],
      ['a Rush card, whose race bit is above 2^32', CODE.rush],
      ['an anime card', CODE.anime],
      ['a row with scope 0', CODE.scopeZero],
      ['a row with no texts entry', CODE.noTexts],
    ])('excludes %s', (_, code) => {
      expect(fixture.get(code)).toBeUndefined();
    });

    it('includes Ritual and Pendulum monsters, and a Link Spell', () => {
      expect(fixture.get(CODE.ritualSoldier)).toBeDefined();
      expect(fixture.get(CODE.asymmetricPendulum)).toBeDefined();
      expect(fixture.get(CODE.linkSpell)).toBeDefined();
    });

    it('includes pre-release cards by default', () => {
      expect(fixture.get(CODE.prerelease)?.ot).toBe(0x101);
    });

    it('excludes pre-release cards, and nothing else, when includePrerelease is false', () => {
      const released = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, FIXTURE_ROWS) }], {
        includePrerelease: false,
      });
      expect(released.get(CODE.prerelease)).toBeUndefined();
      expect(released.status.cards).toBe(POPULATION.length - 1);
    });
  });

  describe('alias handling', () => {
    it('collapses alternate artwork within 10 of its target', () => {
      expect(fixture.get(CODE.nearAltArt)).toBeUndefined();
      expect(fixture.get(CODE.vanillaDragon)).toMatchObject({
        limitCode: CODE.vanillaDragon,
        setcodes: [0xdd],
      });
    });

    it('collapses far alternate artwork: same normalized name, identical stats', () => {
      expect(fixture.get(CODE.farAltArt)).toBeUndefined();
      expect(fixture.get(CODE.tunerFairy)).toBeDefined();
      expect(fixture.search('synthetic tuner fairy')).toHaveLength(1);
    });

    it('keeps a same-name-different-card alias as its own record, limited with its target', () => {
      const card = fixture.get(CODE.sameNameDifferentCard)!;
      expect(card).toMatchObject({
        name: 'Synthetic Ritual Soldier',
        type: TYPE_MONSTER | TYPE_NORMAL,
        ot: 0x1,
        limitCode: CODE.ritualSoldier,
      });
      expect(fixture.get(CODE.ritualSoldier)?.limitCode).toBe(CODE.ritualSoldier);
      expect(fixture.search('Synthetic Ritual Soldier').map((c) => c.code)).toEqual([
        CODE.ritualSoldier,
        CODE.sameNameDifferentCard,
      ]);
    });

    it('keeps a "treated as" alias with its own stats and limitCode = alias', () => {
      expect(fixture.get(CODE.treatedAsHarpy)).toMatchObject({
        name: 'Synthetic Cyber Harpy',
        atk: 1800,
        def: 1300,
        limitCode: CODE.harpy,
      });
    });

    it('keeps a "treated as" alias whose stats equal its target, since the name differs', () => {
      expect(fixture.get(CODE.treatedAsSea)).toMatchObject({
        name: 'Synthetic Legendary Ocean',
        limitCode: CODE.sea,
      });
    });

    it('reads the setcodes of a kept alias from its target, not from its own row', () => {
      expect(fixture.get(CODE.sameNameDifferentCard)?.setcodes).toEqual([0x10cf]);
      expect(fixture.get(CODE.treatedAsHarpy)?.setcodes).toEqual([0x64]);
    });

    it('keeps a row whose alias target is missing, under its own code', () => {
      expect(fixture.get(CODE.orphanAlias)).toMatchObject({
        name: 'Synthetic Orphan',
        limitCode: CODE.orphanAlias,
      });
    });

    it('keeps its own setcodes when the alias target is missing', () => {
      const index = indexOf([{ id: 500, alias: 999999, name: 'Orphan', setcode: 0x1066 }]);
      expect(index.get(500)?.setcodes).toEqual([0x1066]);
    });

    it('resolves an alias whose target lives in another database', () => {
      const index = indexOf(
        [{ id: 100, name: 'Target', setcode: 0x64 }],
        [{ id: 500, alias: 100, name: 'Treated As Target' }],
      );
      expect(index.get(500)).toMatchObject({ limitCode: 100, setcodes: [0x64] });
    });

    it('decides collapse before the population filter, so a reprint never surfaces alone', () => {
      // The reprint is released, its target is pre-release only.
      const rows: FixtureRow[] = [
        { id: 100, name: 'Early Card', ot: 0x100 },
        { id: 101, alias: 100, name: 'Early Card', ot: 0x3 },
      ];
      const index = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, rows) }], {
        includePrerelease: false,
      });
      expect(index.status.cards).toBe(0);
    });

    it('collapses an ineligible reprint of an eligible target', () => {
      const index = indexOf([
        { id: 100, name: 'Released Card' },
        { id: 101, alias: 100, name: 'Released Card', ot: 0x4 },
      ]);
      expect([...index.all()].map((card) => card.code)).toEqual([100]);
    });

    it('treats a self-alias as no alias', () => {
      const index = indexOf([{ id: 100, alias: 100, name: 'Narcissus' }]);
      expect(index.get(100)?.limitCode).toBe(100);
    });
  });

  describe('load order', () => {
    it('lets a later database replace an earlier row with the same id', () => {
      const index = indexOf(
        [{ id: 100, name: 'Old Name', atk: 1000 }],
        [{ id: 100, name: 'New Name', atk: 2000 }],
      );
      expect(index.status.cards).toBe(1);
      expect(index.get(100)).toMatchObject({ name: 'New Name', atk: 2000 });
      expect(index.search('old')).toEqual([]);
    });

    it('replaces the whole row, not field by field', () => {
      const index = indexOf(
        [{ id: 100, name: 'Card', setcode: 0x1066, atk: 1000 }],
        [{ id: 100, name: 'Card', atk: 1000 }],
      );
      expect(index.get(100)?.setcodes).toEqual([]);
    });

    it('lets a later database move a row out of the population', () => {
      const index = indexOf([{ id: 100, name: 'Card' }], [{ id: 100, name: 'Card', ot: 0x4 }]);
      expect(index.get(100)).toBeUndefined();
    });

    it('counts an id as replaced only when the later row differs', () => {
      const index = indexOf(
        [
          { id: 100, name: 'Same' },
          { id: 200, name: 'Changed', atk: 1000 },
          { id: 300, name: 'Only Here' },
        ],
        [
          { id: 100, name: 'Same' },
          { id: 200, name: 'Changed', atk: 1500 },
        ],
      );
      expect(index.status.replacedRows).toBe(1);
    });

    it.each<[string, Partial<FixtureRow>]>([
      ['name', { name: 'Renamed' }],
      ['ot', { ot: 0x1 }],
      ['alias', { alias: 7 }],
      ['setcode', { setcode: 0x1066 }],
      ['type', { type: TYPE_SPELL }],
      ['def', { def: 1 }],
      ['scale', { level: 0x01010004 }],
      ['high race half', { race: '0x4000000000000001' }],
      ['attribute', { attribute: 0x20 }],
    ])('sees a differing %s as a different row', (_, change) => {
      const base: FixtureRow = { id: 100, name: 'Card' };
      expect(indexOf([base], [{ ...base, ...change }]).status.replacedRows).toBe(1);
      expect(layered(['a', [base]], ['b', [{ ...base, ...change }]]).status.conflicts).toBe(1);
    });

    it('counts an id once however many databases replace it', () => {
      const index = indexOf(
        [{ id: 100, name: 'Card', atk: 1 }],
        [{ id: 100, name: 'Card', atk: 2 }],
        [{ id: 100, name: 'Card', atk: 3 }],
      );
      expect(index.status.replacedRows).toBe(1);
      expect(index.get(100)?.atk).toBe(3);
    });
  });

  describe('repository conflicts', () => {
    const old: FixtureRow = { id: 100, name: 'Card', atk: 1000 };
    const updated: FixtureRow = { id: 100, name: 'Card', atk: 2000 };

    it('does not count a repository overriding the base install', () => {
      const index = layered([undefined, [old]], ['delta', [updated]]);
      expect(index.status).toMatchObject({ replacedRows: 1, conflicts: 0 });
      expect(index.get(100)?.atk).toBe(2000);
    });

    it('never counts unlabelled databases, however they disagree', () => {
      expect(indexOf([old], [updated]).status).toMatchObject({ replacedRows: 1, conflicts: 0 });
    });

    it('counts an id on which two repositories disagree', () => {
      const index = layered(['alpha', [old]], ['beta', [updated]]);
      expect(index.status).toMatchObject({ replacedRows: 1, conflicts: 1 });
    });

    it('does not count two repositories carrying identical rows', () => {
      const index = layered(['alpha', [old]], ['beta', [old]]);
      expect(index.status).toMatchObject({ replacedRows: 0, conflicts: 0 });
    });

    it('does not count a repository overriding itself', () => {
      const index = layered(['delta', [old]], ['delta', [updated]]);
      expect(index.status).toMatchObject({ replacedRows: 1, conflicts: 0 });
    });

    it('sees a disagreement between repositories even when the base install loads between them', () => {
      const index = layered(['alpha', [old]], [undefined, [old]], ['beta', [updated]]);
      expect(index.status.conflicts).toBe(1);
    });

    it('judges a repository by its last row: an internal update that ends in agreement is no conflict', () => {
      // alpha ends on `updated`, as beta does, so the merged row is `updated`
      // whichever repository loads last.
      const index = layered(['alpha', [old]], ['alpha', [updated]], ['beta', [updated]]);
      expect(index.status).toMatchObject({ replacedRows: 1, conflicts: 0 });
    });

    it('judges a repository by its last row: an internal update that ends in disagreement is a conflict', () => {
      const index = layered(['beta', [updated]], ['alpha', [updated]], ['alpha', [old]]);
      expect(index.status.conflicts).toBe(1);
    });

    it('counts an id once however many repositories disagree about it', () => {
      const index = layered(
        ['alpha', [{ ...old, atk: 1 }]],
        ['beta', [{ ...old, atk: 2 }]],
        ['gamma', [{ ...old, atk: 3 }]],
      );
      expect(index.status.conflicts).toBe(1);
    });

    it('counts conflicting ids, not conflicting repositories', () => {
      const other: FixtureRow = { id: 200, name: 'Other', atk: 1 };
      const index = layered(
        ['alpha', [old, other, { id: 300, name: 'Agreed' }]],
        ['beta', [updated, { ...other, atk: 2 }, { id: 300, name: 'Agreed' }]],
      );
      expect(index.status.conflicts).toBe(2);
    });

    it('still counts a conflict on a row outside the population', () => {
      const index = layered(['alpha', [{ ...old, ot: 0x4 }]], ['beta', [{ ...updated, ot: 0x4 }]]);
      expect(index.status).toMatchObject({ cards: 0, conflicts: 1 });
    });
  });

  describe('fromDatabases', () => {
    it('accepts an empty list of databases', () => {
      expect(CardIndex.fromDatabases(SQL, []).status).toEqual({
        databases: 0,
        skippedDatabases: 0,
        cards: 0,
        replacedRows: 0,
        conflicts: 0,
      });
    });

    it('skips bytes that are not a database, and loads the rest', () => {
      const garbage = new TextEncoder().encode('not sqlite');
      const index = CardIndex.fromDatabases(SQL, [
        { bytes: garbage },
        { bytes: buildCdb(SQL, named('Alpha')) },
        { bytes: garbage, repository: 'broken' },
      ]);
      expect(index.status).toEqual({
        databases: 1,
        skippedDatabases: 2,
        cards: 1,
        replacedRows: 0,
        conflicts: 0,
      });
    });

    it('skips a database without the datas and texts tables', () => {
      const db = new SQL.Database();
      db.run('CREATE TABLE unrelated (id INTEGER)');
      const bytes = db.export();
      db.close();
      const index = CardIndex.fromDatabases(SQL, [{ bytes }]);
      expect(index.status).toMatchObject({ databases: 0, skippedDatabases: 1, cards: 0 });
    });

    it('skips an empty file', () => {
      const index = CardIndex.fromDatabases(SQL, [{ bytes: new Uint8Array(0) }]);
      expect(index.status).toMatchObject({ databases: 0, skippedDatabases: 1 });
    });

    it('loads a database whose tables are empty', () => {
      expect(indexOf([]).status).toMatchObject({ databases: 1, skippedDatabases: 0, cards: 0 });
    });

    it('closes every database it opens, including one that fails to query', () => {
      const closed: string[] = [];
      const engine = {
        Database: class {
          private readonly label: string;
          constructor(data: Uint8Array) {
            this.label = String(data[0]);
          }
          exec(): { values: unknown[][] }[] {
            if (this.label === '2') throw new Error('malformed');
            return [];
          }
          close(): void {
            closed.push(this.label);
          }
        },
      };
      const index = CardIndex.fromDatabases(engine, [
        { bytes: Uint8Array.of(1) },
        { bytes: Uint8Array.of(2) },
        { bytes: Uint8Array.of(3) },
      ]);
      expect(closed).toEqual(['1', '2', '3']);
      expect(index.status).toMatchObject({ databases: 2, skippedDatabases: 1 });
    });

    it('tolerates NULL and non-numeric columns, reading them as 0', () => {
      const db = new SQL.Database();
      db.run(
        'CREATE TABLE datas (id, ot, alias, setcode, type, atk, def, level, race, attribute, category)',
      );
      db.run('CREATE TABLE texts (id, name, "desc")');
      db.run(
        "INSERT INTO datas VALUES (100, 3, NULL, NULL, 1, NULL, 'abc', NULL, NULL, NULL, NULL)",
      );
      db.run("INSERT INTO texts VALUES (100, 'Sparse Row', '')");
      const bytes = db.export();
      db.close();
      expect(CardIndex.fromDatabases(SQL, [{ bytes }]).get(100)).toMatchObject({
        name: 'Sparse Row',
        limitCode: 100,
        atk: 0,
        def: 0,
        level: 0,
        race: 0,
        setcodes: [],
      });
    });
  });

  describe('empty', () => {
    it('holds nothing and reports zero databases', () => {
      const index = CardIndex.empty();
      expect(index.status).toEqual({
        databases: 0,
        skippedDatabases: 0,
        cards: 0,
        replacedRows: 0,
        conflicts: 0,
      });
      expect([...index.all()]).toEqual([]);
      expect(index.search('a')).toEqual([]);
      expect(index.get(1)).toBeUndefined();
    });
  });

  describe('get', () => {
    it('returns the record with that code', () => {
      expect(fixture.get(CODE.quickSpell)?.name).toBe('Synthetic Quick Spell');
    });

    it('returns undefined for an unknown code', () => {
      expect(fixture.get(1)).toBeUndefined();
      expect(fixture.get(CODE.missingTarget)).toBeUndefined();
    });
  });

  describe('findByName', () => {
    it('returns the record whose whole name matches', () => {
      expect(fixture.findByName('Synthetic Harpy').map((card) => card.code)).toEqual([CODE.harpy]);
    });

    it('is diacritic- and case-insensitive, and ignores surrounding whitespace', () => {
      const index = indexOf(named('Élégant Égotiste', 'Elegant'));
      expect(index.findByName('  elegant egotiste ').map((card) => card.name)).toEqual([
        'Élégant Égotiste',
      ]);
      expect(index.findByName('ÉLEGANT').map((card) => card.name)).toEqual(['Elegant']);
    });

    it('does not match a prefix, a substring, or a longer name', () => {
      expect(fixture.findByName('Synthetic Harp')).toEqual([]);
      expect(fixture.findByName('Harpy')).toEqual([]);
      expect(fixture.findByName('Synthetic Harpy Lady')).toEqual([]);
      expect(fixture.findByName('')).toEqual([]);
    });

    it('returns every card that shares the name, by code', () => {
      expect(fixture.findByName('synthetic ritual soldier').map((card) => card.code)).toEqual([
        CODE.ritualSoldier,
        CODE.sameNameDifferentCard,
      ]);
    });

    it('returns a collapsed alternate artwork once, as its target', () => {
      expect(fixture.findByName('Synthetic Vanilla Dragon').map((card) => card.code)).toEqual([
        CODE.vanillaDragon,
      ]);
    });

    it('finds names at either end of the alphabet', () => {
      const index = indexOf(named('Aardvark', 'Mole', 'Zebra'));
      expect(index.findByName('aardvark')).toHaveLength(1);
      expect(index.findByName('zebra')).toHaveLength(1);
      expect(index.findByName('zebras')).toEqual([]);
      expect(CardIndex.empty().findByName('zebra')).toEqual([]);
    });

    it('finds only cards in the population', () => {
      expect(fixture.findByName('Synthetic Token')).toEqual([]);
    });
  });

  describe('search', () => {
    it('finds cards by substring', () => {
      const index = indexOf([
        { id: 14558127, name: 'Ash Blossom & Joyous Spring' },
        { id: 23434538, name: 'Maxx "C"' },
      ]);
      expect(index.search('blossom').map((card) => card.code)).toEqual([14558127]);
    });

    it('ranks prefix matches above substring matches', () => {
      const index = indexOf(named('Crystal Wing Dragon', 'Wing Requital', 'A Wing'));
      expect(index.search('wing').map((card) => card.name)).toEqual([
        'Wing Requital',
        'A Wing',
        'Crystal Wing Dragon',
      ]);
    });

    it('breaks ties within a class by name length, then by name', () => {
      const index = indexOf(
        named('Wing C', 'Wing B', 'Wing', 'Wing Aa', 'X Wing B', 'X Wing A', 'Z Wing'),
      );
      expect(index.search('wing').map((card) => card.name)).toEqual([
        'Wing',
        'Wing B',
        'Wing C',
        'Wing Aa',
        'Z Wing',
        'X Wing A',
        'X Wing B',
      ]);
    });

    it('lists a name that both starts with and later repeats the query once', () => {
      const index = indexOf(named('Wing Wing'));
      expect(index.search('wing')).toHaveLength(1);
    });

    it('is diacritic- and case-insensitive, in the query and in the name', () => {
      const index = indexOf(named('Doré the Émissary'));
      expect(index.search('dore the em')).toHaveLength(1);
      expect(index.search('DORÉ')).toHaveLength(1);
      expect(index.search('émis')).toHaveLength(1);
    });

    it('ignores surrounding whitespace in the query', () => {
      expect(indexOf(named('Alpha')).search('  alp ')).toHaveLength(1);
    });

    it('returns nothing for a blank query', () => {
      const index = indexOf(named('Alpha'));
      expect(index.search('')).toEqual([]);
      expect(index.search('  ')).toEqual([]);
    });

    it('returns nothing when nothing matches', () => {
      expect(indexOf(named('Alpha')).search('omega')).toEqual([]);
    });

    it('defaults to 20 results', () => {
      const index = indexOf(named(...Array.from({ length: 30 }, (_, i) => `Clone ${i}`)));
      expect(index.search('clone')).toHaveLength(20);
    });

    it('returns the best prefix matches when there are more than the limit', () => {
      const index = indexOf(named('Wing Ccc', 'Wing Bb', 'Wing A', 'Wing', 'A Wing'));
      expect(index.search('wing', 3).map((card) => card.name)).toEqual([
        'Wing',
        'Wing A',
        'Wing Bb',
      ]);
    });

    it('fills up to the limit with the best substring matches', () => {
      const index = indexOf(named('Wing', 'Long X Wing', 'A Wing', 'The Wing'));
      expect(index.search('wing', 3).map((card) => card.name)).toEqual([
        'Wing',
        'A Wing',
        'The Wing',
      ]);
    });

    it('finds the prefix range at either end of the alphabet', () => {
      const index = indexOf(named('Aardvark', 'Mongoose', 'Zebra', 'Zebra Finch'));
      expect(index.search('aard').map((card) => card.name)).toEqual(['Aardvark']);
      expect(index.search('zebra').map((card) => card.name)).toEqual(['Zebra', 'Zebra Finch']);
      expect(index.search('zz')).toEqual([]);
    });

    it('returns nothing for a non-positive limit', () => {
      expect(indexOf(named('Alpha')).search('alpha', 0)).toEqual([]);
    });

    it('searches only the population', () => {
      expect(fixture.search('Synthetic Token')).toEqual([]);
      expect(fixture.search('Synthetic Link').map((card) => card.code)).toEqual([CODE.linkSpell]);
    });
  });

  describe('all', () => {
    it('iterates every record alphabetically by normalized name', () => {
      const index = indexOf(named('beta', 'Émile', 'Alpha', 'delta'));
      expect([...index.all()].map((card) => card.name)).toEqual([
        'Alpha',
        'beta',
        'delta',
        'Émile',
      ]);
    });

    it('can be iterated more than once', () => {
      expect([...fixture.all()]).toHaveLength(POPULATION.length);
      expect([...fixture.all()]).toHaveLength(POPULATION.length);
    });
  });

  describe('count', () => {
    it('counts the records satisfying the predicate', () => {
      expect(fixture.count((card) => isSpell(card.type))).toBe(4);
      expect(fixture.count(() => true)).toBe(POPULATION.length);
      expect(fixture.count(() => false)).toBe(0);
    });
  });

  describe('sample', () => {
    it('returns the first n matches in all() order', () => {
      const monsters = [...fixture.all()].filter((card) => isMonster(card.type));
      expect(fixture.sample((card) => isMonster(card.type), 3)).toEqual(monsters.slice(0, 3));
    });

    it('returns every match when there are fewer than n', () => {
      expect(fixture.sample((card) => isSpell(card.type), 100)).toHaveLength(4);
    });

    it('returns nothing for n = 0', () => {
      expect(fixture.sample(() => true, 0)).toEqual([]);
    });
  });

  describe('status', () => {
    it('reports loaded and skipped databases, cards, replaced rows and conflicts', () => {
      expect(fixture.status).toEqual({
        databases: 1,
        skippedDatabases: 0,
        cards: POPULATION.length,
        replacedRows: 0,
        conflicts: 0,
      });
    });
  });
});
