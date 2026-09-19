import type { SqlJsStatic } from 'sql.js';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_EARTH,
  ATTRIBUTE_LIGHT,
  ATTRIBUTE_WATER,
  ATTRIBUTE_WIND,
  RACE_DRAGON,
  RACE_FAIRY,
  RACE_FIEND,
  RACE_SPELLCASTER,
  RACE_WARRIOR,
  RACE_WINGEDBEAST,
  TYPE_COUNTER,
  TYPE_EFFECT,
  TYPE_FIELD,
  TYPE_FUSION,
  TYPE_LINK,
  TYPE_MONSTER,
  TYPE_NORMAL,
  TYPE_PENDULUM,
  TYPE_QUICKPLAY,
  TYPE_RITUAL,
  TYPE_SKILL,
  TYPE_SPELL,
  TYPE_SYNCHRO,
  TYPE_TOKEN,
  TYPE_TRAP,
  TYPE_TUNER,
  TYPE_XYZ,
} from '../../src/core/cards/constants';

/**
 * Synthetic card rows and a builder that turns them into a real `.cdb` image
 * with sql.js (TDD §15.2) — reviewable in a diff, unlike a binary fixture.
 *
 * A numeric column is a `number`, or a `string` holding an SQL integer literal
 * that is spliced into the INSERT verbatim. The string form exists for the
 * 64-bit columns: `0x8fed2066106600dd` is above 2^53 and has bit 63 set, so it
 * must never pass through a JS number on its way into the database.
 */
export type SqlInt = number | string;

export interface FixtureRow {
  id: number;
  name: string;
  /** `false` omits the `texts` row, so the inner join drops the card. */
  texts?: boolean;
  ot?: SqlInt;
  alias?: SqlInt;
  setcode?: SqlInt;
  type?: SqlInt;
  atk?: SqlInt;
  def?: SqlInt;
  /** Raw column: `(lscale << 24) | (rscale << 16) | level`; see `rawLevel`. */
  level?: SqlInt;
  race?: SqlInt;
  attribute?: SqlInt;
}

/** The raw `level` column of a Pendulum row, per `gframe/data_manager.cpp:146-153`. */
export function rawLevel(level: number, lscale: number, rscale: number): number {
  return ((lscale << 24) | (rscale << 16) | level) >>> 0;
}

const SQL_INT = /^(?:0x[0-9a-fA-F]{1,16}|-?[0-9]+)$/;

function sqlInt(value: SqlInt): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`not a safe integer: ${value}`);
    return String(value);
  }
  if (!SQL_INT.test(value)) throw new Error(`not an SQL integer literal: ${value}`);
  return value;
}

// The schema of BabelCDB's cards.cdb, verbatim (`sqlite3 cards.cdb .schema`).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "datas" (
    "id"        INTEGER,
    "ot"        INTEGER,
    "alias"     INTEGER,
    "setcode"   INTEGER,
    "type"      INTEGER,
    "atk"       INTEGER,
    "def"       INTEGER,
    "level"     INTEGER,
    "race"      INTEGER,
    "attribute" INTEGER,
    "category"  INTEGER,
    PRIMARY KEY("id")
);
CREATE TABLE IF NOT EXISTS "texts" (
    "id"    INTEGER,
    "name"  TEXT,
    "desc"  TEXT,
    "str1"  TEXT, "str2"  TEXT, "str3"  TEXT, "str4"  TEXT,
    "str5"  TEXT, "str6"  TEXT, "str7"  TEXT, "str8"  TEXT,
    "str9"  TEXT, "str10" TEXT, "str11" TEXT, "str12" TEXT,
    "str13" TEXT, "str14" TEXT, "str15" TEXT, "str16" TEXT,
    PRIMARY KEY("id")
);`;

/** Build a database image holding `rows`. Defaults make an ordinary OCG/TCG Normal Monster. */
export function buildCdb(SQL: SqlJsStatic, rows: readonly FixtureRow[]): Uint8Array {
  const db = new SQL.Database();
  try {
    db.run(SCHEMA);
    for (const row of rows) {
      const columns = [
        row.id,
        row.ot ?? 0x3,
        row.alias ?? 0,
        row.setcode ?? 0,
        row.type ?? TYPE_MONSTER | TYPE_NORMAL,
        row.atk ?? 0,
        row.def ?? 0,
        row.level ?? 4,
        row.race ?? RACE_WARRIOR,
        row.attribute ?? ATTRIBUTE_EARTH,
        0,
      ];
      db.run(`INSERT INTO datas VALUES (${columns.map(sqlInt).join(', ')})`);
      if (row.texts !== false)
        db.run('INSERT INTO texts (id, name, desc) VALUES (?, ?, ?)', [row.id, row.name, '']);
    }
    return db.export();
  } finally {
    db.close();
  }
}

/** Codes of the fixture rows, named for the trap each one sets (TDD §15.1 "Row decoding"). */
export const CODE = {
  vanillaDragon: 90000010,
  tunerFairy: 90000020,
  quickSpell: 90000030,
  counterTrap: 90000040,
  ritualSoldier: 90000050,
  asymmetricPendulum: 90000060,
  fourSetcodes: 90000070,
  gappedSetcodes: 90000080,
  nearAltArt: 90000011,
  unknownAtk: 90000090,
  linkMonster: 90000100,
  linkSpell: 90000110,
  xyzMonster: 90000120,
  fusionMonster: 90000130,
  synchroMonster: 90000140,
  farAltArt: 90500020,
  sameNameDifferentCard: 90500050,
  harpy: 90000150,
  treatedAsHarpy: 90500150,
  sea: 90000160,
  treatedAsSea: 90500160,
  orphanAlias: 90000170,
  missingTarget: 90999999,
  token: 90000180,
  prerelease: 90000190,
  rush: 90000200,
  anime: 90000210,
  noTexts: 90000220,
  highRace: 90000230,
  skill: 90000240,
  noKind: 90000250,
  spellAndTrap: 90000260,
  scopeZero: 90000270,
  negativeLevel: 90000280,
} as const;

export const FIXTURE_ROWS: readonly FixtureRow[] = [
  // --- ordinary cards -------------------------------------------------------
  {
    id: CODE.vanillaDragon,
    name: 'Synthetic Vanilla Dragon',
    setcode: 0xdd,
    atk: 3000,
    def: 2500,
    level: 8,
    race: RACE_DRAGON,
    attribute: ATTRIBUTE_LIGHT,
  },
  {
    id: CODE.tunerFairy,
    name: 'Synthetic Tuner Fairy',
    type: TYPE_MONSTER | TYPE_EFFECT | TYPE_TUNER,
    atk: 0,
    def: 1800,
    level: 3,
    race: RACE_FAIRY,
    attribute: ATTRIBUTE_LIGHT,
  },
  {
    id: CODE.quickSpell,
    name: 'Synthetic Quick Spell',
    type: TYPE_SPELL | TYPE_QUICKPLAY,
    level: 0,
    race: 0,
    attribute: 0,
  },
  {
    id: CODE.counterTrap,
    name: 'Synthetic Counter Trap',
    type: TYPE_TRAP | TYPE_COUNTER,
    level: 0,
    race: 0,
    attribute: 0,
  },
  {
    id: CODE.ritualSoldier,
    name: 'Synthetic Ritual Soldier',
    type: TYPE_MONSTER | TYPE_EFFECT | TYPE_RITUAL,
    setcode: 0x10cf,
    atk: 3000,
    def: 2500,
    level: 8,
    attribute: ATTRIBUTE_EARTH,
  },

  // --- §4.1 decoding traps --------------------------------------------------
  // Asymmetric scales: every real Pendulum row is symmetric, so only a
  // synthetic row can catch a left/right swap.
  {
    id: CODE.asymmetricPendulum,
    name: 'Synthetic Lopsided Pendulum',
    type: TYPE_MONSTER | TYPE_EFFECT | TYPE_PENDULUM,
    level: rawLevel(4, 8, 3),
    atk: 1800,
    def: 600,
    race: RACE_SPELLCASTER,
    attribute: ATTRIBUTE_DARK,
  },
  // Four codes, the top one with bit 15 set, so the int64 has bit 63 set and
  // is far above 2^53: slots are 0x00dd, 0x1066, 0x2066, 0x8fed.
  {
    id: CODE.fourSetcodes,
    name: 'Synthetic Four-Archetype Monster',
    setcode: '0x8fed2066106600dd',
  },
  // Zero slots are skipped, not terminators: slots are 0x0abc, 0, 0x1234, 0.
  {
    id: CODE.gappedSetcodes,
    name: 'Synthetic Gapped Archetype Monster',
    setcode: '0x0000123400000abc',
  },
  // "?" ATK and DEF are stored as -2.
  {
    id: CODE.unknownAtk,
    name: 'Synthetic Unknowable Fiend',
    type: TYPE_MONSTER | TYPE_EFFECT,
    atk: -2,
    def: -2,
    level: 10,
    race: RACE_FIEND,
    attribute: ATTRIBUTE_DARK,
  },
  // `def` holds link markers (0xa5 = 165 would satisfy "DEF 200 or less");
  // `level` holds the Link Rating.
  {
    id: CODE.linkMonster,
    name: 'Synthetic Link Monster',
    type: TYPE_MONSTER | TYPE_EFFECT | TYPE_LINK,
    atk: 1500,
    def: 0xa5,
    level: 2,
  },
  // Link is gated on Monster: a Link Spell is a Main Deck card.
  {
    id: CODE.linkSpell,
    name: 'Synthetic Link Spell',
    type: TYPE_SPELL | TYPE_LINK,
    def: 0x28,
    level: 0,
    race: 0,
    attribute: 0,
  },
  // `level` holds the Rank (4 would satisfy "level 4").
  {
    id: CODE.xyzMonster,
    name: 'Synthetic Xyz Monster',
    type: TYPE_MONSTER | TYPE_EFFECT | TYPE_XYZ,
    level: 4,
  },
  {
    id: CODE.fusionMonster,
    name: 'Synthetic Fusion Monster',
    type: TYPE_MONSTER | TYPE_EFFECT | TYPE_FUSION,
    level: 6,
  },
  {
    id: CODE.synchroMonster,
    name: 'Synthetic Synchro Monster',
    type: TYPE_MONSTER | TYPE_EFFECT | TYPE_SYNCHRO,
    level: 7,
  },
  // Race bits 62 and 63 on an otherwise official card, plus RACE_SPELLCASTER.
  { id: CODE.highRace, name: 'Synthetic High-Race Monster', race: '0xc000000000000002' },
  // Bit 31 of the raw level set: the client reads a negative int and negates.
  { id: CODE.negativeLevel, name: 'Synthetic Negative-Level Monster', level: '0x80000003' },

  // --- §4.3 the three meanings of alias --------------------------------------
  // Alternate artwork within ±10, carrying setcode 0 although its target has one.
  {
    id: CODE.nearAltArt,
    alias: CODE.vanillaDragon,
    name: 'Synthetic Vanilla Dragon',
    setcode: 0,
    atk: 3000,
    def: 2500,
    level: 8,
    race: RACE_DRAGON,
    attribute: ATTRIBUTE_LIGHT,
  },
  // Alternate artwork the ±10 window misses: same name (up to case), identical stats.
  {
    id: CODE.farAltArt,
    alias: CODE.tunerFairy,
    name: 'SYNTHETIC Tuner Fairy',
    type: TYPE_MONSTER | TYPE_EFFECT | TYPE_TUNER,
    atk: 0,
    def: 1800,
    level: 3,
    race: RACE_FAIRY,
    attribute: ATTRIBUTE_LIGHT,
  },
  // Same name, different card (cf. Black Luster Soldier 10000100 → 5405694).
  {
    id: CODE.sameNameDifferentCard,
    alias: CODE.ritualSoldier,
    name: 'Synthetic Ritual Soldier',
    ot: 0x1,
    type: TYPE_MONSTER | TYPE_NORMAL,
    setcode: 0,
    atk: 3000,
    def: 2500,
    level: 8,
    attribute: ATTRIBUTE_EARTH,
  },
  // "Always treated as", with its own stats and its own extra setcode
  // (cf. Cyber Harpie Lady 80316585 → 76812113).
  {
    id: CODE.harpy,
    name: 'Synthetic Harpy',
    setcode: 0x64,
    atk: 1300,
    def: 1400,
    race: RACE_WINGEDBEAST,
    attribute: ATTRIBUTE_WIND,
  },
  {
    id: CODE.treatedAsHarpy,
    alias: CODE.harpy,
    name: 'Synthetic Cyber Harpy',
    type: TYPE_MONSTER | TYPE_EFFECT,
    setcode: 0x640093,
    atk: 1800,
    def: 1300,
    race: RACE_WINGEDBEAST,
    attribute: ATTRIBUTE_WIND,
  },
  // "Always treated as" with identical stats: only the name keeps it distinct
  // (cf. A Legendary Ocean 295517 → Umi 22702055).
  {
    id: CODE.sea,
    name: 'Synthetic Sea',
    type: TYPE_SPELL | TYPE_FIELD,
    level: 0,
    race: 0,
    attribute: 0,
  },
  {
    id: CODE.treatedAsSea,
    alias: CODE.sea,
    name: 'Synthetic Legendary Ocean',
    type: TYPE_SPELL | TYPE_FIELD,
    level: 0,
    race: 0,
    attribute: 0,
  },
  // Alias target absent from every database.
  {
    id: CODE.orphanAlias,
    alias: CODE.missingTarget,
    name: 'Synthetic Orphan',
    attribute: ATTRIBUTE_WATER,
  },

  // --- §4.2 rows outside the population ---------------------------------------
  {
    id: CODE.token,
    name: 'Synthetic Token',
    type: TYPE_MONSTER | TYPE_NORMAL | TYPE_TOKEN,
    level: 1,
  },
  { id: CODE.rush, name: 'Synthetic Rush Yokai', ot: 0x200, race: '0x4000000000000000' },
  { id: CODE.anime, name: 'Synthetic Anime Monster', ot: 0x4 },
  { id: CODE.noTexts, name: 'Synthetic Nameless Monster', texts: false },
  { id: CODE.skill, name: 'Synthetic Skill', type: TYPE_SKILL, level: 0 },
  { id: CODE.noKind, name: 'Synthetic Kindless Row', type: 0 },
  { id: CODE.spellAndTrap, name: 'Synthetic Spell-Trap', type: TYPE_SPELL | TYPE_TRAP },
  { id: CODE.scopeZero, name: 'Synthetic Scopeless Monster', ot: 0 },

  // --- §4.2 pre-release: in by default, out by setting ------------------------
  { id: CODE.prerelease, name: 'Synthetic Pre-release Monster', ot: 0x101 },
];

/** Codes the default index must hold, i.e. `FIXTURE_ROWS` minus every excluded or collapsed row. */
export const POPULATION: readonly number[] = [
  CODE.vanillaDragon,
  CODE.tunerFairy,
  CODE.quickSpell,
  CODE.counterTrap,
  CODE.ritualSoldier,
  CODE.asymmetricPendulum,
  CODE.fourSetcodes,
  CODE.gappedSetcodes,
  CODE.unknownAtk,
  CODE.linkSpell,
  CODE.highRace,
  CODE.negativeLevel,
  CODE.sameNameDifferentCard,
  CODE.harpy,
  CODE.treatedAsHarpy,
  CODE.sea,
  CODE.treatedAsSea,
  CODE.orphanAlias,
  CODE.prerelease,
];
