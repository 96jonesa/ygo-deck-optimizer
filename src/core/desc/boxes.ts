import { matchSetcode } from '../cards/record';
import {
  ATTRIBUTE_VOCABULARY,
  KINDS,
  type Kind,
  MONSTER_FLAGS,
  type MonsterFlag,
  RACE_VOCABULARY,
  ST_SUBKIND_VOCABULARY,
  type StSubkind,
  type VocabularyEntry,
} from '../cards/vocabulary';
import {
  type Clause,
  type Description,
  LEVEL_MAX,
  LEVEL_MIN,
  type Stat,
  type ValueSet,
} from './ast';

/**
 * The model behind `implies` (TDD §6.1): a Main Deck card is exactly one of
 * three kinds, and the universe is the DISJOINT UNION of three product spaces.
 *
 * | Kind | Dimensions |
 * | --- | --- |
 * | monster | one boolean per `MonsterFlag` × Attribute × Type × Level × ATK × DEF × archetypes |
 * | spell | sub-kind (normal, quick-play, continuous, equip, field, ritual) × archetypes |
 * | trap | sub-kind (normal, continuous, counter) × archetypes |
 *
 * A box is a product of per-dimension allowed sets within one kind; a clause
 * normalizes to at most three boxes and a description to a finite union of
 * them. `toBoxes` is where the game-rule axioms live, and they are the only
 * ones: nothing relates one flag to another (Normal and Effect are not
 * assumed exclusive), so a missed implication is possible and a wrong one is
 * not.
 *
 * What the model assumes of a card, all true of every official card:
 * - at most one Attribute bit and at most one official Type bit. A card with
 *   none is a value of its own — NONE, OTHER — so that `non-FIRE monster` does
 *   not imply the list of the other six Attributes. Level has an OTHER value
 *   likewise, for a Level outside `LEVEL_MIN..LEVEL_MAX`;
 * - ATK and DEF are a non-negative integer or `?`;
 * - a Spell or Trap has one of its kind's sub-kinds (Normal being the absence
 *   of every sub-kind bit), i.e. no Spell is marked Counter;
 * - any set of setcodes may occur together. The real limit of four per card
 *   is ignored, which can only lose an implication from a description that
 *   requires five unrelated archetypes at once.
 * Descriptions are assumed to be within the AST's documented domain; a value
 * outside the vocabulary (an unofficial Type bit, Level 14) matches no card of
 * the model.
 */

// --- ATK and DEF: integer intervals plus the point "?" ---------------------------

/** Inclusive; `max: null` is unbounded. */
export interface StatRange {
  min: number;
  max: number | null;
}

/**
 * A set of ATK or DEF values: non-negative integers as sorted, disjoint,
 * non-adjacent ranges, plus the distinguished point `?`, which no range
 * contains (axiom 5).
 */
export interface StatSet {
  ranges: readonly StatRange[];
  unknown: boolean;
}

export const STAT_ALL: StatSet = { ranges: [{ min: 0, max: null }], unknown: true };
export const STAT_NONE: StatSet = { ranges: [], unknown: false };

function upper(range: StatRange): number {
  return range.max ?? Number.POSITIVE_INFINITY;
}

function rangeOf(min: number, max: number): StatRange {
  return { min, max: max === Number.POSITIVE_INFINITY ? null : max };
}

export function statSetOf(stat: Stat): StatSet {
  if (stat === '?') return { ranges: [], unknown: true };
  const min = Math.max(0, stat.min);
  if (stat.max !== null && stat.max < min) return STAT_NONE;
  return { ranges: [{ min, max: stat.max }], unknown: false };
}

export function statIsEmpty(set: StatSet): boolean {
  return !set.unknown && set.ranges.length === 0;
}

export function statIntersect(a: StatSet, b: StatSet): StatSet {
  const ranges: StatRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.ranges.length && j < b.ranges.length) {
    const x = a.ranges[i]!;
    const y = b.ranges[j]!;
    const min = Math.max(x.min, y.min);
    const max = Math.min(upper(x), upper(y));
    if (min <= max) ranges.push(rangeOf(min, max));
    // Whichever ends first cannot meet anything further along the other list.
    if (upper(x) < upper(y)) i++;
    else j++;
  }
  return { ranges, unknown: a.unknown && b.unknown };
}

/** `a \ b`. Over integers, `[a,b]` minus `[c,d]` leaves `[a,c-1]` and `[d+1,b]`. */
export function statSubtract(a: StatSet, b: StatSet): StatSet {
  const ranges: StatRange[] = [];
  for (const range of a.ranges) {
    // What is left of `range` to examine starts at `min`; `null` once nothing is.
    let min: number | null = range.min;
    const max = upper(range);
    for (const cut of b.ranges) {
      if (upper(cut) < min) continue;
      if (cut.min > max) break;
      if (cut.min > min) ranges.push(rangeOf(min, cut.min - 1));
      if (cut.max === null || cut.max >= max) {
        min = null;
        break;
      }
      min = cut.max + 1;
    }
    if (min !== null) ranges.push(rangeOf(min, max));
  }
  return { ranges, unknown: a.unknown && !b.unknown };
}

// --- discrete dimensions: one bitmask of allowed values each -----------------------

/** A boolean dimension — a monster flag or an archetype — as a mask over {false, true}. */
export const BOOL_FALSE = 0b01;
export const BOOL_TRUE = 0b10;
export const BOOL_ANY = 0b11;

/** Attribute: bit `i` is `ATTRIBUTE_VOCABULARY[i]`, and one more for a card with no Attribute. */
export const ATTRIBUTE_NONE = 1 << ATTRIBUTE_VOCABULARY.length;
const ATTRIBUTE_ANY = ATTRIBUTE_NONE * 2 - 1;

/** Type: bit `i` is `RACE_VOCABULARY[i]`, and one more for no Type or an unofficial one. */
export const RACE_OTHER = 1 << RACE_VOCABULARY.length;
const RACE_ANY = RACE_OTHER * 2 - 1;

/** Level: bit `n - LEVEL_MIN` is Level `n`, and one more for a Level outside the domain. */
export const LEVEL_OTHER = 1 << (LEVEL_MAX - LEVEL_MIN + 1);
const LEVEL_ANY = LEVEL_OTHER * 2 - 1;

/** The sub-kinds that exist for a kind, in vocabulary order; bit `i` of the mask is entry `i`. */
export const SUBKINDS_OF: Readonly<Record<'spell' | 'trap', readonly StSubkind[]>> = {
  spell: ST_SUBKIND_VOCABULARY.filter((e) => e.kinds.includes('spell')).map((e) => e.subkind),
  trap: ST_SUBKIND_VOCABULARY.filter((e) => e.kinds.includes('trap')).map((e) => e.subkind),
};

/**
 * Where each discrete dimension of a monster box sits in `Box.masks`; the
 * archetype dimensions follow from `archetypes` on. A Spell or Trap box has
 * its sub-kind at `ST_LAYOUT.subkind` and its archetypes from
 * `ST_LAYOUT.archetypes` on.
 */
export const MONSTER_LAYOUT = {
  flag: (flag: MonsterFlag): number => MONSTER_FLAGS.indexOf(flag),
  attribute: MONSTER_FLAGS.length,
  race: MONSTER_FLAGS.length + 1,
  level: MONSTER_FLAGS.length + 2,
  archetypes: MONSTER_FLAGS.length + 3,
} as const;
export const ST_LAYOUT = { subkind: 0, archetypes: 1 } as const;

/** The monster dimensions of `Box.stats`. */
export const STAT_LAYOUT = { atk: 0, def: 1 } as const;

/**
 * The archetype dimensions of one comparison: the setcodes either description
 * mentions, ascending. Dimensions are per comparison because the archetypes
 * nobody mentions cannot affect the answer.
 */
export type ArchetypeDims = readonly number[];

export function archetypeDimsOf(...descs: Description[]): ArchetypeDims {
  const codes = new Set<number>();
  for (const desc of descs)
    for (const alt of desc.anyOf)
      if (alt.t === 'clause') for (const code of alt.clause.archetypes ?? []) codes.add(code);
  return [...codes].sort((a, b) => a - b);
}

/**
 * A non-empty product of allowed sets within one kind. `masks` holds the
 * discrete dimensions in the kind's layout order, `stats` holds ATK and DEF
 * for a monster and nothing otherwise.
 */
export interface Box {
  kind: Kind;
  masks: number[];
  stats: StatSet[];
}

function archetypeOffset(kind: Kind): number {
  return kind === 'monster' ? MONSTER_LAYOUT.archetypes : ST_LAYOUT.archetypes;
}

/** The whole space of one kind. */
export function fullBox(kind: Kind, dims: ArchetypeDims): Box {
  const archetypes = dims.map(() => BOOL_ANY);
  if (kind === 'monster')
    return {
      kind,
      masks: [
        ...MONSTER_FLAGS.map(() => BOOL_ANY),
        ATTRIBUTE_ANY,
        RACE_ANY,
        LEVEL_ANY,
        ...archetypes,
      ],
      stats: [STAT_ALL, STAT_ALL],
    };
  return { kind, masks: [(1 << SUBKINDS_OF[kind].length) - 1, ...archetypes], stats: [] };
}

export function boxIsEmpty(box: Box): boolean {
  return box.masks.some((mask) => mask === 0) || box.stats.some(statIsEmpty);
}

/** `a ∩ b`, or `null` when they share no card — boxes of different kinds never do. */
export function boxIntersect(a: Box, b: Box): Box | null {
  if (a.kind !== b.kind) return null;
  const box: Box = {
    kind: a.kind,
    masks: a.masks.map((mask, i) => mask & b.masks[i]!),
    stats: a.stats.map((set, i) => statIntersect(set, b.stats[i]!)),
  };
  return boxIsEmpty(box) ? null : box;
}

/**
 * `a \ b` as pairwise disjoint boxes, at most one per dimension (TDD §6.2):
 * peel off the part of `a` outside `b` along the first dimension, restrict
 * `a` to `b`'s slice on it, and continue along the next. What is left after
 * the last dimension lies inside `b` and is dropped.
 */
export function boxSubtract(a: Box, b: Box): Box[] {
  if (boxIntersect(a, b) === null) return [a];
  const pieces: Box[] = [];
  const rest: Box = { kind: a.kind, masks: [...a.masks], stats: [...a.stats] };
  for (let i = 0; i < rest.masks.length; i++) {
    const outside = rest.masks[i]! & ~b.masks[i]!;
    if (outside !== 0) {
      const masks = [...rest.masks];
      masks[i] = outside;
      pieces.push({ kind: a.kind, masks, stats: [...rest.stats] });
    }
    rest.masks[i] = rest.masks[i]! & b.masks[i]!;
  }
  for (let i = 0; i < rest.stats.length; i++) {
    const outside = statSubtract(rest.stats[i]!, b.stats[i]!);
    if (!statIsEmpty(outside)) {
      const stats = [...rest.stats];
      stats[i] = outside;
      pieces.push({ kind: a.kind, masks: [...rest.masks], stats });
    }
    rest.stats[i] = statIntersect(rest.stats[i]!, b.stats[i]!);
  }
  return pieces;
}

/** `boxes \ minus`: every box of `minus` subtracted in turn from the working set. */
export function subtractAll(boxes: readonly Box[], minus: readonly Box[]): Box[] {
  let working = [...boxes];
  for (const cut of minus) {
    if (working.length === 0) break;
    working = working.flatMap((box) => boxSubtract(box, cut));
  }
  return working;
}

/**
 * Axiom 4. Query `sub` refines query `base` when every card `sub` matches,
 * `base` matches too — `matchSetcode(base, sub)`, the set-card rule with the
 * finer query standing in for the card's code. A box that requires `sub`
 * therefore requires `base`. Returns `null` when that empties the box.
 *
 * Boxes must be saturated BEFORE subtraction: the raw box of
 * `"Magnet Warrior":0x3066` still admits "not 0x1066", which no card is, and
 * subtracting `"Magnet":0x1066` would leave that phantom slice behind.
 * Saturating the left side alone is enough, because the right side's boxes
 * only ever REQUIRE archetypes: the least card of a saturated box (its
 * required archetypes and nothing else) is a real one, and if any point of
 * the box escapes the right side, so does that card.
 */
export function saturate(box: Box, dims: ArchetypeDims): Box | null {
  const offset = archetypeOffset(box.kind);
  const masks = [...box.masks];
  for (let i = 0; i < dims.length; i++) {
    if (box.masks[offset + i] !== BOOL_TRUE) continue;
    for (let j = 0; j < dims.length; j++)
      if (matchSetcode(dims[j]!, dims[i]!)) masks[offset + j] = masks[offset + j]! & BOOL_TRUE;
  }
  const saturated = { kind: box.kind, masks, stats: box.stats };
  return boxIsEmpty(saturated) ? null : saturated;
}

function bitsOf(values: readonly number[]): number {
  return values.reduce((all, bit) => all | bit, 0);
}

/** The vocabulary entries `bits` names, as a mask over their positions. */
function vocabularyMask(table: readonly VocabularyEntry[], bits: number): number {
  return table.reduce((mask, entry, i) => ((bits & entry.bit) !== 0 ? mask | (1 << i) : mask), 0);
}

/** `null` when the list constrains nothing — an empty list, as in `evaluate`. */
function valueSetMask(
  set: ValueSet<number> | undefined,
  table: readonly VocabularyEntry[],
  any: number,
): { positive: boolean; mask: number } | null {
  if (set === undefined) return null;
  const positive = 'in' in set;
  const bits = bitsOf(positive ? set.in : set.notIn);
  if (bits === 0) return null;
  const named = vocabularyMask(table, bits);
  // A negated list keeps NONE / OTHER: a card with no Attribute is a non-FIRE one.
  return { positive, mask: positive ? named : any & ~named };
}

function levelMask(level: readonly number[]): number {
  return level.reduce(
    (mask, n) => (n >= LEVEL_MIN && n <= LEVEL_MAX ? mask | (1 << (n - LEVEL_MIN)) : mask),
    0,
  );
}

/** The boxes of one clause: at most one per kind, none that is empty. */
function clauseBoxes(clause: Clause, dims: ArchetypeDims): Box[] {
  const monster = fullBox('monster', dims);
  // Axiom 1: a POSITIVE constraint on a monster-only dimension is false of every Spell and
  // Trap. Axiom 2: a NEGATIVE one is true of them, so it leaves their boxes full.
  let monsterOnly = false;

  for (const [flag, want] of Object.entries(clause.flags ?? {}) as [MonsterFlag, boolean][]) {
    monster.masks[MONSTER_LAYOUT.flag(flag)] = want ? BOOL_TRUE : BOOL_FALSE;
    if (want) monsterOnly = true;
  }
  const attributes = valueSetMask(clause.attributes, ATTRIBUTE_VOCABULARY, ATTRIBUTE_ANY);
  if (attributes) {
    monster.masks[MONSTER_LAYOUT.attribute] = attributes.mask;
    if (attributes.positive) monsterOnly = true;
  }
  const races = valueSetMask(clause.races, RACE_VOCABULARY, RACE_ANY);
  if (races) {
    monster.masks[MONSTER_LAYOUT.race] = races.mask;
    if (races.positive) monsterOnly = true;
  }
  if (clause.level !== undefined && clause.level.length > 0) {
    monster.masks[MONSTER_LAYOUT.level] = levelMask(clause.level);
    monsterOnly = true;
  }
  if (clause.atk !== undefined) {
    monster.stats[STAT_LAYOUT.atk] = statSetOf(clause.atk);
    monsterOnly = true;
  }
  if (clause.def !== undefined) {
    monster.stats[STAT_LAYOUT.def] = statSetOf(clause.def);
    monsterOnly = true;
  }

  const subkinds = clause.stSubkinds ?? [];
  const kinds = clause.kinds !== undefined && clause.kinds.length > 0 ? clause.kinds : KINDS;
  const boxes: Box[] = [];
  for (const kind of KINDS) {
    if (!kinds.includes(kind)) continue;
    let box: Box;
    if (kind === 'monster') {
      // Axiom 3: a sub-kind constraint is false of every monster.
      if (subkinds.length > 0) continue;
      box = monster;
    } else {
      if (monsterOnly) continue;
      box = fullBox(kind, dims);
      // Axiom 3, second half: only the listed sub-kinds that exist for this kind remain.
      if (subkinds.length > 0)
        box.masks[ST_LAYOUT.subkind] = SUBKINDS_OF[kind].reduce(
          (mask, subkind, i) => (subkinds.includes(subkind) ? mask | (1 << i) : mask),
          0,
        );
    }
    for (const code of clause.archetypes ?? []) {
      const i = dims.indexOf(code);
      if (i < 0) throw new Error(`archetype 0x${code.toString(16)} is not among the dimensions`);
      box.masks[archetypeOffset(kind) + i] = BOOL_TRUE;
    }
    const saturated = saturate(box, dims);
    if (saturated !== null) boxes.push(saturated);
  }
  return boxes;
}

/**
 * The union of boxes a description's CLAUSE alternatives denote, axioms
 * applied and archetypes saturated. Cards and groups are points, not boxes
 * (TDD §6.2), and are skipped. `dims` must hold every archetype the
 * description mentions — `archetypeDimsOf` of both sides of the comparison.
 */
export function toBoxes(desc: Description, dims: ArchetypeDims): Box[] {
  return desc.anyOf.flatMap((alt) => (alt.t === 'clause' ? clauseBoxes(alt.clause, dims) : []));
}
