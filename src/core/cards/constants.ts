/**
 * EDOPro / ocgcore bit constants for the `datas` columns (TDD §4, Appendix A).
 *
 * Transcribed WHOLE and mechanically — a generator greps the `#define`s and
 * emits this text; no value was typed by hand or taken from the TDD appendix:
 *
 * | Table                          | Source file                  | Lines  | Commit                                                    |
 * | ------------------------------ | ---------------------------- | ------ | --------------------------------------------------------- |
 * | TYPE_* (core)                  | ocgcore/ocgapi_constants.h   | 33-58  | edo9300/ygopro-core@46779fbe40e6a9bd8967f5dc6a03f4eaa6550d57 |
 * | ATTRIBUTE_*                    | ocgcore/ocgapi_constants.h   | 61-68  | same                                                      |
 * | RACE_*                         | ocgcore/ocgapi_constants.h   | 71-105 | same                                                      |
 * | SCOPE_*                        | gframe/data_manager.h        | 21-34  | edo9300/edopro@30935e847165a9ef0e547fb51a43f36168fab7c7   |
 * | TYPE_SKILL, TYPE_ACTION        | gframe/data_manager.h        | 36-37  | same                                                      |
 *
 * Literals keep the header's own spelling (`0x01`, not `0x1`).
 *
 * 64-bit values: `race` is a `uint64_t` and `RACE_YOKAI` is bit 62, which no JS
 * number can hold exactly alongside 32-bit bitwise operators. The card reader
 * splits the column in SQL (`race & 0xffffffff` → `CardRecord.race`,
 * `race >> 32` → `CardRecord.raceHi`), and the tables split the same way:
 * `RACE_*` are tested against `race`, `RACE_HI_*` (the header value `>> 32`)
 * against `raceHi`. `RACE_GALAXY` (`0x80000000`) is a correct positive literal,
 * but `race & RACE_GALAXY` is negative in JS — always test `(x & BIT) !== 0`.
 *
 * Deliberately not transcribed: the composite macros (`ATTRIBUTE_ALL`,
 * `RACE_MAX`, `RACE_ALL`, `SCOPE_OCG_TCG`) and `LINK_MARKER_*`, whose literals
 * in the same header are octal (`0010` = 8) and which nothing here needs.
 * `TYPE_PLUS`/`TYPE_MINUS`/`TYPE_ARMOR` exist only in CardScripts' `constant.lua`.
 */

// GENERATED-BEGIN (gen-constants.mjs; do not edit by hand)
// ocgcore @ 46779fbe40e6a9bd8967f5dc6a03f4eaa6550d57
// edopro  @ 30935e847165a9ef0e547fb51a43f36168fab7c7

// TYPE_* (core) — ocgcore/ocgapi_constants.h:33-58
export const TYPE_MONSTER = 0x1;
export const TYPE_SPELL = 0x2;
export const TYPE_TRAP = 0x4;
export const TYPE_NORMAL = 0x10;
export const TYPE_EFFECT = 0x20;
export const TYPE_FUSION = 0x40;
export const TYPE_RITUAL = 0x80;
export const TYPE_TRAPMONSTER = 0x100;
export const TYPE_SPIRIT = 0x200;
export const TYPE_UNION = 0x400;
export const TYPE_GEMINI = 0x800;
export const TYPE_TUNER = 0x1000;
export const TYPE_SYNCHRO = 0x2000;
export const TYPE_TOKEN = 0x4000;
export const TYPE_MAXIMUM = 0x8000;
export const TYPE_QUICKPLAY = 0x10000;
export const TYPE_CONTINUOUS = 0x20000;
export const TYPE_EQUIP = 0x40000;
export const TYPE_FIELD = 0x80000;
export const TYPE_COUNTER = 0x100000;
export const TYPE_FLIP = 0x200000;
export const TYPE_TOON = 0x400000;
export const TYPE_XYZ = 0x800000;
export const TYPE_PENDULUM = 0x1000000;
export const TYPE_SPSUMMON = 0x2000000;
export const TYPE_LINK = 0x4000000;

/** Every core `TYPE_*`, in header order. */
export const CORE_TYPES = {
  TYPE_MONSTER,
  TYPE_SPELL,
  TYPE_TRAP,
  TYPE_NORMAL,
  TYPE_EFFECT,
  TYPE_FUSION,
  TYPE_RITUAL,
  TYPE_TRAPMONSTER,
  TYPE_SPIRIT,
  TYPE_UNION,
  TYPE_GEMINI,
  TYPE_TUNER,
  TYPE_SYNCHRO,
  TYPE_TOKEN,
  TYPE_MAXIMUM,
  TYPE_QUICKPLAY,
  TYPE_CONTINUOUS,
  TYPE_EQUIP,
  TYPE_FIELD,
  TYPE_COUNTER,
  TYPE_FLIP,
  TYPE_TOON,
  TYPE_XYZ,
  TYPE_PENDULUM,
  TYPE_SPSUMMON,
  TYPE_LINK,
} as const;

// TYPE_* (client-only) — gframe/data_manager.h:36-37
export const TYPE_SKILL = 0x8000000;
export const TYPE_ACTION = 0x10000000;

/** The `TYPE_*` bits the client defines on top of the core table. */
export const CLIENT_TYPES = {
  TYPE_SKILL,
  TYPE_ACTION,
} as const;

// ATTRIBUTE_* — ocgcore/ocgapi_constants.h:61-68
// Composite macros not transcribed: ATTRIBUTE_ALL.
export const ATTRIBUTE_EARTH = 0x01;
export const ATTRIBUTE_WATER = 0x02;
export const ATTRIBUTE_FIRE = 0x04;
export const ATTRIBUTE_WIND = 0x08;
export const ATTRIBUTE_LIGHT = 0x10;
export const ATTRIBUTE_DARK = 0x20;
export const ATTRIBUTE_DIVINE = 0x40;

/** Every `ATTRIBUTE_*`, in header order. */
export const ATTRIBUTES = {
  ATTRIBUTE_EARTH,
  ATTRIBUTE_WATER,
  ATTRIBUTE_FIRE,
  ATTRIBUTE_WIND,
  ATTRIBUTE_LIGHT,
  ATTRIBUTE_DARK,
  ATTRIBUTE_DIVINE,
} as const;

// RACE_* — ocgcore/ocgapi_constants.h:71-105
// Composite macros not transcribed: RACE_MAX, RACE_ALL.
export const RACE_WARRIOR = 0x1;
export const RACE_SPELLCASTER = 0x2;
export const RACE_FAIRY = 0x4;
export const RACE_FIEND = 0x8;
export const RACE_ZOMBIE = 0x10;
export const RACE_MACHINE = 0x20;
export const RACE_AQUA = 0x40;
export const RACE_PYRO = 0x80;
export const RACE_ROCK = 0x100;
export const RACE_WINGEDBEAST = 0x200;
export const RACE_PLANT = 0x400;
export const RACE_INSECT = 0x800;
export const RACE_THUNDER = 0x1000;
export const RACE_DRAGON = 0x2000;
export const RACE_BEAST = 0x4000;
export const RACE_BEASTWARRIOR = 0x8000;
export const RACE_DINOSAUR = 0x10000;
export const RACE_FISH = 0x20000;
export const RACE_SEASERPENT = 0x40000;
export const RACE_REPTILE = 0x80000;
export const RACE_PSYCHIC = 0x100000;
export const RACE_DIVINE = 0x200000;
export const RACE_CREATORGOD = 0x400000;
export const RACE_WYRM = 0x800000;
export const RACE_CYBERSE = 0x1000000;
export const RACE_ILLUSION = 0x2000000;
export const RACE_CYBORG = 0x4000000;
export const RACE_MAGICALKNIGHT = 0x8000000;
export const RACE_HIGHDRAGON = 0x10000000;
export const RACE_OMEGAPSYCHIC = 0x20000000;
export const RACE_CELESTIALWARRIOR = 0x40000000;
export const RACE_GALAXY = 0x80000000;

/** Every `RACE_*` below 2^32 (the `race & 0xffffffff` half), in header order. */
export const RACES = {
  RACE_WARRIOR,
  RACE_SPELLCASTER,
  RACE_FAIRY,
  RACE_FIEND,
  RACE_ZOMBIE,
  RACE_MACHINE,
  RACE_AQUA,
  RACE_PYRO,
  RACE_ROCK,
  RACE_WINGEDBEAST,
  RACE_PLANT,
  RACE_INSECT,
  RACE_THUNDER,
  RACE_DRAGON,
  RACE_BEAST,
  RACE_BEASTWARRIOR,
  RACE_DINOSAUR,
  RACE_FISH,
  RACE_SEASERPENT,
  RACE_REPTILE,
  RACE_PSYCHIC,
  RACE_DIVINE,
  RACE_CREATORGOD,
  RACE_WYRM,
  RACE_CYBERSE,
  RACE_ILLUSION,
  RACE_CYBORG,
  RACE_MAGICALKNIGHT,
  RACE_HIGHDRAGON,
  RACE_OMEGAPSYCHIC,
  RACE_CELESTIALWARRIOR,
  RACE_GALAXY,
} as const;

// RACE_YOKAI 0x4000000000000000 (ocgcore/ocgapi_constants.h:103) >> 32
export const RACE_HI_YOKAI = 0x40000000;

/** Bits 32-63 of the same column, as seen after the SQL split `x >> 32`. */
export const RACES_HI = {
  RACE_HI_YOKAI,
} as const;

// SCOPE_* (the `ot` column) — gframe/data_manager.h:21-34
// Composite macros not transcribed: SCOPE_OCG_TCG.
export const SCOPE_OCG = 0x1;
export const SCOPE_TCG = 0x2;
export const SCOPE_ANIME = 0x4;
export const SCOPE_ILLEGAL = 0x8;
export const SCOPE_VIDEO_GAME = 0x10;
export const SCOPE_CUSTOM = 0x20;
export const SCOPE_SPEED = 0x40;
export const SCOPE_PRERELEASE = 0x100;
export const SCOPE_RUSH = 0x200;
export const SCOPE_LEGEND = 0x400;
export const SCOPE_HIDDEN = 0x1000;

/** Every `SCOPE_*` flag, in header order. */
export const SCOPES = {
  SCOPE_OCG,
  SCOPE_TCG,
  SCOPE_ANIME,
  SCOPE_ILLEGAL,
  SCOPE_VIDEO_GAME,
  SCOPE_CUSTOM,
  SCOPE_SPEED,
  SCOPE_PRERELEASE,
  SCOPE_RUSH,
  SCOPE_LEGEND,
  SCOPE_HIDDEN,
} as const;

// SCOPE_OFFICIAL — gframe/data_manager.h:34, defined from its parts as the header does.
export const SCOPE_OFFICIAL = SCOPE_OCG | SCOPE_TCG | SCOPE_PRERELEASE;

// GENERATED-END

// Hand-written below this line.

/**
 * The official Types are `RACE_WARRIOR` … `RACE_ILLUSION`, bits 0-25;
 * `RACE_CYBORG` onward are Rush or unofficial. No C header says so (the C
 * `RACE_ALL` covers all of them); the source is CardScripts' `constant.lua:89`,
 * `RACE_ALL = 0x3ffffff --Official races, from RACE_WARRIOR to RACE_ILLUSION`
 * (ProjectIgnis/CardScripts@9d1d01091f060d02cc9304f7a4efab96c186f113).
 */
export const OFFICIAL_RACE_MASK = 0x3ffffff;

/** The `RACES` entries inside `OFFICIAL_RACE_MASK`, in header order. */
export const OFFICIAL_RACES: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(RACES).filter(([, bit]) => (bit & OFFICIAL_RACE_MASK) !== 0),
);
