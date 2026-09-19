import {
  ATTRIBUTE_VOCABULARY,
  type Kind,
  MONSTER_FLAGS,
  type MonsterFlag,
  RACE_VOCABULARY,
  ST_SUBKIND_VOCABULARY,
} from '../../src/core/cards/vocabulary';
import {
  type Alternative,
  type Clause,
  canonicalize,
  type Description,
  LEVEL_MAX,
  LEVEL_MIN,
  type Stat,
  type ValueSet,
} from '../../src/core/desc/ast';
import type { Rng } from './prng';

/** What generated card, group and archetype references are drawn from. */
export interface GenPool {
  passcodes: readonly number[];
  groupIds: readonly string[];
  setcodes: readonly number[];
}

const ATTRIBUTES = ATTRIBUTE_VOCABULARY.map((entry) => entry.bit);
const RACES = RACE_VOCABULARY.map((entry) => entry.bit);
const CONTEXTUAL_FLAGS: readonly MonsterFlag[] = ['normal', 'ritual'];
const PLAIN_FLAGS = MONSTER_FLAGS.filter((flag) => !CONTEXTUAL_FLAGS.includes(flag));
const KIND_CHOICES: readonly (Kind[] | undefined)[] = [
  undefined,
  undefined,
  undefined,
  ['monster'],
  ['monster'],
  ['spell'],
  ['trap'],
  ['spell', 'trap'],
  ['monster', 'spell'],
  ['monster', 'trap'],
  ['monster', 'spell', 'trap'],
];

function range(low: number, high: number): number[] {
  return Array.from({ length: high - low + 1 }, (_, i) => low + i);
}

function genValueSet(rng: Rng, bits: readonly number[]): ValueSet<number> {
  const values = rng.subset(bits, 1, 3);
  return rng.chance(0.3) ? { notIn: values } : { in: values };
}

/** Every shape `formatLevel` tells apart: single, from the bottom, to the top, a run, scattered. */
function genLevel(rng: Rng): number[] {
  const a = rng.int(LEVEL_MIN, LEVEL_MAX);
  const b = rng.int(LEVEL_MIN, LEVEL_MAX);
  switch (rng.int(0, 4)) {
    case 0:
      return [a];
    case 1:
      return range(LEVEL_MIN, a);
    case 2:
      return range(a, LEVEL_MAX);
    case 3:
      return range(Math.min(a, b), Math.max(a, b));
    default:
      return rng.subset(range(LEVEL_MIN, LEVEL_MAX), 1, 5);
  }
}

function genStat(rng: Rng): Stat {
  const a = rng.chance(0.2) ? 0 : rng.int(0, 50) * 100;
  const b = a + rng.int(0, 30) * 100;
  switch (rng.int(0, 4)) {
    case 0:
      return '?';
    case 1:
      return { min: a, max: a };
    case 2:
      return { min: 0, max: a };
    case 3:
      return { min: a, max: null };
    default:
      return { min: a, max: b };
  }
}

/**
 * A clause inside the image of `parse` — the invariants documented on
 * `Clause` — so that `parse(print(clause))` is expected to give it back.
 * Deliberately NOT restricted to satisfiable clauses: `level 4 spell` is a
 * faithful record of something a user can write.
 */
export function genClause(rng: Rng, pool: GenPool): Clause {
  const clause: Clause = {};
  const kinds = rng.pick(KIND_CHOICES);
  if (kinds) clause.kinds = [...kinds];

  if (kinds && !kinds.includes('monster') && rng.chance(0.6)) {
    const exists = ST_SUBKIND_VOCABULARY.filter((e) => e.kinds.some((k) => kinds.includes(k)));
    clause.stSubkinds = rng.subset(exists, 1, 3).map((entry) => entry.subkind);
  }

  if (rng.chance(0.35)) clause.level = genLevel(rng);
  if (rng.chance(0.25)) clause.atk = genStat(rng);
  if (rng.chance(0.2)) clause.def = genStat(rng);
  if (rng.chance(0.35)) clause.attributes = genValueSet(rng, ATTRIBUTES);
  if (rng.chance(0.35)) clause.races = genValueSet(rng, RACES);

  const flags: Partial<Record<MonsterFlag, boolean>> = {};
  for (const flag of PLAIN_FLAGS) if (rng.chance(0.12)) flags[flag] = rng.chance(0.5);

  // `normal` and `ritual` read as the monster flag only where the text says "monster".
  const saysMonster =
    clause.level !== undefined ||
    clause.atk !== undefined ||
    clause.def !== undefined ||
    (clause.attributes !== undefined && 'in' in clause.attributes) ||
    (clause.races !== undefined && 'in' in clause.races) ||
    Object.values(flags).some((want) => want);
  const monsterOnly = kinds?.length === 1 && kinds[0] === 'monster';
  const allowed: boolean[] = [];
  if (monsterOnly || (!kinds && saysMonster)) allowed.push(true);
  if (!kinds || kinds.includes('monster')) allowed.push(false);
  for (const flag of CONTEXTUAL_FLAGS)
    if (allowed.length > 0 && rng.chance(0.25)) flags[flag] = rng.pick(allowed);
  if (Object.keys(flags).length > 0) clause.flags = flags;

  if (rng.chance(0.3)) clause.archetypes = rng.subset(pool.setcodes, 1, 2);
  return clause;
}

export function genAlternative(rng: Rng, pool: GenPool): Alternative {
  const roll = rng.next();
  if (roll < 0.15) return { t: 'card', passcode: rng.pick(pool.passcodes) };
  if (roll < 0.3) return { t: 'group', groupId: rng.pick(pool.groupIds) };
  return { t: 'clause', clause: genClause(rng, pool) };
}

/** A canonical description of one to three alternatives. */
export function genDescription(rng: Rng, pool: GenPool): Description {
  const anyOf = Array.from({ length: rng.int(1, 3) }, () => genAlternative(rng, pool));
  return canonicalize({ anyOf });
}
