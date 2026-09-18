import {
  SCOPE_OCG,
  SCOPE_OFFICIAL,
  SCOPE_TCG,
  TYPE_ACTION,
  TYPE_FUSION,
  TYPE_LINK,
  TYPE_MONSTER,
  TYPE_SKILL,
  TYPE_SPELL,
  TYPE_SYNCHRO,
  TYPE_TOKEN,
  TYPE_TRAP,
  TYPE_XYZ,
} from './constants';

/**
 * One card as the engine sees it (TDD §4.6). Every numeric field is below
 * 2^32: the 64-bit columns are unpacked in SQL by `CardIndex`, so plain
 * `(x & BIT) !== 0` tests are exact.
 */
export interface CardRecord {
  code: number;
  name: string;
  /** EDOPro's 3-copy key, `alias ? alias : code` (`gframe/deck_manager.cpp:192`). */
  limitCode: number;
  ot: number;
  type: number;
  /** `-2` is "?". */
  atk: number;
  /** `-2` is "?". For `TYPE_LINK` this holds the link-marker mask, not DEF. */
  def: number;
  /** Level, Rank or Link Rating — told apart only by `TYPE_XYZ` / `TYPE_LINK`. */
  level: number;
  lscale: number;
  rscale: number;
  /** `race & 0xffffffff`; test against `RACE_*`. */
  race: number;
  /** `race >> 32`; test against `RACE_HI_*`. */
  raceHi: number;
  attribute: number;
  /** Non-zero 16-bit codes, already resolved through the alias. */
  setcodes: number[];
}

export function isMonster(type: number): boolean {
  return (type & TYPE_MONSTER) !== 0;
}

export function isSpell(type: number): boolean {
  return (type & TYPE_SPELL) !== 0;
}

export function isTrap(type: number): boolean {
  return (type & TYPE_TRAP) !== 0;
}

export function isToken(type: number): boolean {
  return (type & TYPE_TOKEN) !== 0;
}

/**
 * Extra Deck per `gframe/deck_manager.cpp:220`: Fusion, Synchro or Xyz on any
 * row, but Link only together with Monster — the source gates Link on Monster
 * and not the others (Link Spells exist). Ritual and Pendulum are Main Deck.
 */
export function isExtraDeck(type: number): boolean {
  if ((type & (TYPE_FUSION | TYPE_SYNCHRO | TYPE_XYZ)) !== 0) return true;
  return (type & TYPE_LINK) !== 0 && (type & TYPE_MONSTER) !== 0;
}

/** The type half of the population rule (TDD §4.2); scope is `isOfficialScope`. */
export function isMainDeckEligible(type: number): boolean {
  const kinds = Number(isMonster(type)) + Number(isSpell(type)) + Number(isTrap(type));
  if (kinds !== 1) return false;
  if ((type & (TYPE_TOKEN | TYPE_SKILL | TYPE_ACTION)) !== 0) return false;
  return !isExtraDeck(type);
}

/**
 * `ot` is a bitmask with gaps, so "official" is "non-zero and nothing outside
 * the allowed flags" rather than an equality. Pre-release cards (`0x101`,
 * `0x102`) are official by EDOPro's own `SCOPE_OFFICIAL` and included by default.
 */
export function isOfficialScope(ot: number, includePrerelease = true): boolean {
  const allowed = includePrerelease ? SCOPE_OFFICIAL : SCOPE_OCG | SCOPE_TCG;
  return ot !== 0 && (ot & allowed) === ot;
}

/**
 * The core's set-card rule (`ocgcore/card.h:185-187`), **query first**: low 12
 * bits equal, and the card's high nibble a superset of the query's — the
 * nibble is a bitmask of sub-archetypes, so `0x3066` is matched by a `0x3066`
 * card but not by a `0x1066` one, while query `0x1066` matches both.
 */
export function matchSetcode(query: number, cardCode: number): boolean {
  return (query & 0xfff) === (cardCode & 0xfff) && (query & cardCode) === query;
}
