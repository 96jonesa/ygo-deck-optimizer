import {
  KINDS,
  type Kind,
  MONSTER_FLAGS,
  type MonsterFlag,
  ST_SUBKINDS,
  type StSubkind,
} from '../cards/vocabulary';

export type { Kind, MonsterFlag, StSubkind };

/** An `ATTRIBUTE_*` bit value. */
export type Attribute = number;
/** An official `RACE_*` bit value. */
export type Race = number;
/** A sorted, de-duplicated list of integers. */
export type IntSet = number[];

/** The Level domain: `level N or lower` is `LEVEL_MIN..N`, `or higher` is `N..LEVEL_MAX`. */
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 13;

/** A setcode is 16 bits: a 12-bit archetype and a 4-bit sub-archetype mask (TDD §4.1). */
export const SETCODE_MAX = 0xffff;

/**
 * An ATK or DEF constraint: `'?'`, or an inclusive range in which `max: null`
 * is unbounded (never `Infinity` — the AST is JSON). An exact value is
 * `min === max`. A range never contains `?` (TDD §6.1 axiom 5).
 */
export type Stat = '?' | { min: number; max: number | null };

/** Either "any of these bits" or "none of these bits"; never both. */
export type ValueSet<T extends number> = { in: T[] } | { notIn: T[] };

/**
 * One conjunction of constraints (TDD §5.2). A faithful record of what was
 * written: the parser adds no game-rule axioms, so `level 4` has no `kinds`.
 * An omitted field is unconstrained, and so is an empty list.
 *
 * The clauses the text grammar can express — the image of `parse`, and the
 * domain on which `parse(print(d))` equals `d` — satisfy, beyond the types:
 * - `stSubkinds` comes with `kinds`, a non-empty subset of spell/trap for
 *   which every listed sub-kind exists (`counter` needs `trap`);
 * - `flags.normal` / `flags.ritual` set to `true` need `kinds: ['monster']`,
 *   or no `kinds` plus a positive monster-only constraint (Level, ATK, DEF,
 *   `in` Attributes or Types, a required flag other than those two) —
 *   otherwise the word would have read as the Spell/Trap sub-kind, or as
 *   "normal what?";
 * - `flags.normal` / `flags.ritual` set to `false` need no `kinds`, or
 *   `kinds` that include `monster`;
 * - `level` within `LEVEL_MIN..LEVEL_MAX`; stats with `0 <= min <= max`;
 *   archetypes within `1..SETCODE_MAX`.
 */
export interface Clause {
  /** Omitted = any kind. */
  kinds?: Kind[];
  /** `true` = required, `false` = "non-". */
  flags?: Partial<Record<MonsterFlag, boolean>>;
  /** Any one of these. */
  stSubkinds?: StSubkind[];
  attributes?: ValueSet<Attribute>;
  races?: ValueSet<Race>;
  level?: IntSet;
  atk?: Stat;
  def?: Stat;
  /** Setcodes, ALL required. */
  archetypes?: number[];
}

export type Alternative =
  | { t: 'card'; passcode: number }
  | { t: 'group'; groupId: string }
  | { t: 'clause'; clause: Clause };

/** A card matches when it matches any alternative; at least one. */
export type Description = { anyOf: Alternative[] };

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** The members of `values`, once each, in the order of `order`. */
function inOrder<T>(order: readonly T[], values: readonly T[]): T[] {
  return order.filter((value) => values.includes(value));
}

function canonicalValueSet<T extends number>(set: ValueSet<T>): ValueSet<T> | undefined {
  const values = sortedUnique('in' in set ? set.in : set.notIn) as T[];
  if (values.length === 0) return undefined;
  return 'in' in set ? { in: values } : { notIn: values };
}

function canonicalStat(stat: Stat): Stat {
  return stat === '?' ? '?' : { min: stat.min, max: stat.max };
}

function canonicalClause(clause: Clause): Clause {
  const out: Clause = {};
  const kinds = inOrder(KINDS, clause.kinds ?? []);
  if (kinds.length > 0) out.kinds = kinds;

  const flags: Partial<Record<MonsterFlag, boolean>> = {};
  for (const flag of MONSTER_FLAGS) {
    const want = clause.flags?.[flag];
    if (want !== undefined) flags[flag] = want;
  }
  if (Object.keys(flags).length > 0) out.flags = flags;

  const stSubkinds = inOrder(ST_SUBKINDS, clause.stSubkinds ?? []);
  if (stSubkinds.length > 0) out.stSubkinds = stSubkinds;

  const attributes = clause.attributes && canonicalValueSet(clause.attributes);
  if (attributes) out.attributes = attributes;
  const races = clause.races && canonicalValueSet(clause.races);
  if (races) out.races = races;

  const level = sortedUnique(clause.level ?? []);
  if (level.length > 0) out.level = level;
  if (clause.atk !== undefined) out.atk = canonicalStat(clause.atk);
  if (clause.def !== undefined) out.def = canonicalStat(clause.def);

  const archetypes = sortedUnique(clause.archetypes ?? []);
  if (archetypes.length > 0) out.archetypes = archetypes;
  return out;
}

function canonicalAlternative(alt: Alternative): Alternative {
  switch (alt.t) {
    case 'card':
      return { t: 'card', passcode: alt.passcode };
    case 'group':
      return { t: 'group', groupId: alt.groupId };
    case 'clause':
      return { t: 'clause', clause: canonicalClause(alt.clause) };
  }
}

/**
 * The canonical form, on which structural equality is meaningful: lists
 * sorted and de-duplicated (kinds, flags and sub-kinds in vocabulary order,
 * numbers ascending), empty fields omitted, keys in one fixed order — so
 * `JSON.stringify` of two canonical descriptions agrees exactly when they
 * do — and duplicate alternatives dropped. Alternatives KEEP their written
 * order: `A or B` and `B or A` match the same cards but are not equal, and
 * the parse echo reads back in the order the user wrote.
 *
 * Purely structural: nothing is validated and no game rule is applied.
 */
export function canonicalize(desc: Description): Description {
  const seen = new Set<string>();
  const anyOf: Alternative[] = [];
  for (const alt of desc.anyOf) {
    const canonical = canonicalAlternative(alt);
    const key = JSON.stringify(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    anyOf.push(canonical);
  }
  return { anyOf };
}
