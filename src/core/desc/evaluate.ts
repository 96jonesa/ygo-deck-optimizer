import { TYPE_LINK, TYPE_MONSTER, TYPE_XYZ } from '../cards/constants';
import { type CardRecord, matchSetcode } from '../cards/record';
import {
  kindEntry,
  monsterFlagEntry,
  ST_SUBKIND_BITS,
  type StSubkindEntry,
  stSubkindEntry,
} from '../cards/vocabulary';
import type { Alternative, Clause, Description, MonsterFlag, Stat, ValueSet } from './ast';

/** Group id → passcodes of its members. */
export type Groups = ReadonlyMap<string, ReadonlySet<number>>;

type Test = (card: CardRecord) => boolean;

/** EDOPro stores a `?` ATK or DEF as -2 (TDD §4.1); there is no named constant. */
const UNKNOWN_STAT = -2;

function mask(bits: readonly number[]): number {
  return bits.reduce((all, bit) => all | bit, 0);
}

function isMonster(card: CardRecord): boolean {
  return (card.type & TYPE_MONSTER) !== 0;
}

/**
 * A monster-only dimension (TDD §6.1): requiring a value is false of a Spell
 * or Trap (axiom 1), and excluding values is true of one (axiom 2).
 */
function valueSetTest(set: ValueSet<number>, field: (card: CardRecord) => number): Test | null {
  const positive = 'in' in set;
  const bits = mask(positive ? set.in : set.notIn);
  if (bits === 0) return null;
  return positive
    ? (card) => isMonster(card) && (field(card) & bits) !== 0
    : (card) => !isMonster(card) || (field(card) & bits) === 0;
}

function flagTest(flag: MonsterFlag, want: boolean): Test {
  const { bit } = monsterFlagEntry(flag);
  return want
    ? (card) => isMonster(card) && (card.type & bit) !== 0
    : (card) => !isMonster(card) || (card.type & bit) === 0;
}

/** Whether a card that IS a Spell or Trap of one of the entry's kinds has the sub-kind. */
function hasSubkind(entry: StSubkindEntry, card: CardRecord): boolean {
  if (!entry.kinds.some((kind) => (card.type & kindEntry(kind).bit) !== 0)) return false;
  // "normal" has no bit: it is the absence of every sub-kind bit.
  return entry.bit === 0 ? (card.type & ST_SUBKIND_BITS) === 0 : (card.type & entry.bit) !== 0;
}

/**
 * A numeric range never matches a negative stored value — `?` is -2, and
 * `ATK 1500 or less` must not return Tragoedia — and `'?'` matches exactly it.
 */
function statTest(stat: Stat, field: (card: CardRecord) => number): Test {
  if (stat === '?') return (card) => field(card) === UNKNOWN_STAT;
  const { min, max } = stat;
  return (card) => {
    const value = field(card);
    return value >= 0 && value >= min && (max === null || value <= max);
  };
}

function clauseTests(clause: Clause): Test[] {
  const tests: Test[] = [];
  if (clause.kinds !== undefined && clause.kinds.length > 0) {
    const bits = mask(clause.kinds.map((kind) => kindEntry(kind).bit));
    tests.push((card) => (card.type & bits) !== 0);
  }
  for (const [flag, want] of Object.entries(clause.flags ?? {}) as [MonsterFlag, boolean][])
    tests.push(flagTest(flag, want));
  if (clause.stSubkinds !== undefined && clause.stSubkinds.length > 0) {
    const entries = clause.stSubkinds.map(stSubkindEntry);
    tests.push((card) => entries.some((entry) => hasSubkind(entry, card)));
  }
  const attributes = clause.attributes && valueSetTest(clause.attributes, (card) => card.attribute);
  if (attributes) tests.push(attributes);
  const races = clause.races && valueSetTest(clause.races, (card) => card.race);
  if (races) tests.push(races);
  if (clause.level !== undefined && clause.level.length > 0) {
    const levels = new Set(clause.level);
    // The `level` column of an Xyz or Link monster is its Rank or Link Rating (TDD §4.1).
    tests.push(
      (card) =>
        isMonster(card) && (card.type & (TYPE_XYZ | TYPE_LINK)) === 0 && levels.has(card.level),
    );
  }
  if (clause.atk !== undefined) {
    const atk = statTest(clause.atk, (card) => card.atk);
    tests.push((card) => isMonster(card) && atk(card));
  }
  if (clause.def !== undefined) {
    const def = statTest(clause.def, (card) => card.def);
    // The `def` column of a Link monster is its link-marker mask (TDD §4.1).
    tests.push((card) => isMonster(card) && (card.type & TYPE_LINK) === 0 && def(card));
  }
  for (const query of clause.archetypes ?? [])
    tests.push((card) => card.setcodes.some((code) => matchSetcode(query, code)));
  return tests;
}

function alternativeTest(alt: Alternative, groups: Groups): Test {
  switch (alt.t) {
    case 'card':
      return (card) => card.code === alt.passcode;
    case 'group':
      return (card) => groups.get(alt.groupId)?.has(card.code) === true;
    case 'clause': {
      const tests = clauseTests(alt.clause);
      return (card) => tests.every((test) => test(card));
    }
  }
}

/**
 * `desc` compiled to a predicate, for evaluating one description against many
 * cards (the match count and samples of the parse echo).
 */
export function matcher(desc: Description, groups: Groups): (card: CardRecord) => boolean {
  const alternatives = desc.anyOf.map((alt) => alternativeTest(alt, groups));
  return (card) => alternatives.some((test) => test(card));
}

/**
 * The obvious field test of a description against one concrete card (TDD
 * §5.3). Level, ATK, DEF, Attribute, Type and the monster flags exist only on
 * monsters; Level is undefined for Xyz and Link monsters and DEF for Link
 * monsters. Archetype membership is the core's set-card comparison, query
 * first. A group the map does not hold has no members.
 */
export function evaluate(desc: Description, card: CardRecord, groups: Groups): boolean {
  return matcher(desc, groups)(card);
}
