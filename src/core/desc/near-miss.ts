import {
  KINDS,
  type Kind,
  MONSTER_FLAGS,
  monsterFlagEntry,
  ST_SUBKIND_VOCABULARY,
} from '../cards/vocabulary';
import {
  type Alternative,
  type Clause,
  canonicalize,
  type Description,
  type Stat,
  type ValueSet,
} from './ast';
import {
  type ArchetypeDims,
  archetypeDimsOf,
  type Box,
  boxIntersect,
  fullBox,
  MONSTER_LAYOUT,
  ST_LAYOUT,
  STAT_LAYOUT,
  type StatSet,
  statIntersect,
  statIsEmpty,
  statSubtract,
  subtractAll,
  toBoxes,
} from './boxes';
import type { DescContext } from './context';
import { type ImpliesContext, implies, intersects, UNIVERSE } from './implies';
import { parse } from './parser';
import { formatArchetype, print } from './print';

/**
 * Near misses (PRD §6.4, TDD §9): a line that is COMPATIBLE with a
 * requirement — some card could be both — but does not imply it, so its cards
 * do not count. This is advice: what the line leaves unsaid, and the text of a
 * line that would count. It is the only use of `intersects`, and nothing that
 * is scored depends on it.
 */

/**
 * Where a near miss fails, in the order they are looked at — the FIRST one is
 * reported. `card` and `named` concern named cards; `kind` … `archetype` are
 * the dimensions of the box model (TDD §6.1); `combination` is a line every
 * dimension of which is covered, only not by any single alternative.
 */
export const NEAR_MISS_DIMENSIONS = [
  'card',
  'named',
  'kind',
  'level',
  'atk',
  'def',
  'attribute',
  'type',
  'flags',
  'subkind',
  'archetype',
  'combination',
] as const;
export type NearMissDimension = (typeof NEAR_MISS_DIMENSIONS)[number];

/**
 * - `unstated`: the line says nothing on the dimension;
 * - `broader`: it says something, but admits values the requirement does not;
 * - `different`: part of the line says something the requirement excludes;
 * - `members`: the line names cards, and not all of them match;
 * - `named`: the requirement names cards, and a generic line never stands for one (TDD §6.2);
 * - `combination`: see `NEAR_MISS_DIMENSIONS`.
 */
export type NearMissReason =
  | 'unstated'
  | 'broader'
  | 'different'
  | 'members'
  | 'named'
  | 'combination';

export interface NearMiss {
  dimension: NearMissDimension;
  reason: NearMissReason;
  /** `Level unstated`, `kind too broad`, `#123 (Name) does not match`. */
  what: string;
  /**
   * Canonical text of a line that WOULD fill the requirement: the line and
   * the requirement taken together, e.g. `FIRE monster` and `level 4 or lower
   * monster` give `level 4 or lower FIRE monster`. Left out when that cannot
   * be written as one description.
   */
  suggestion?: string;
}

export interface NearMissContext {
  /** To print the suggestion, and to check that it reads back. */
  desc: DescContext;
  implies: ImpliesContext;
}

// --- the conjunction of two descriptions ------------------------------------------

function meetValues(
  a: ValueSet<number> | undefined,
  b: ValueSet<number> | undefined,
): ValueSet<number> | undefined | null {
  if (a === undefined || b === undefined) return a ?? b;
  if ('notIn' in a && 'notIn' in b) return { notIn: [...a.notIn, ...b.notIn] };
  const [positive, other] = 'in' in a ? [a, b] : [b as { in: number[] }, a];
  const values = positive.in.filter((value) =>
    'in' in other ? other.in.includes(value) : !other.notIn.includes(value),
  );
  // An empty list would read as "unconstrained": nothing is left, which is a contradiction.
  return values.length === 0 ? null : { in: values };
}

function meetStat(a: Stat | undefined, b: Stat | undefined): Stat | undefined | null {
  if (a === undefined || b === undefined) return a ?? b;
  if (a === '?' || b === '?') return a === b ? '?' : null;
  const min = Math.max(a.min, b.min);
  const max = a.max === null ? b.max : b.max === null ? a.max : Math.min(a.max, b.max);
  return max !== null && max < min ? null : { min, max };
}

function meetLists<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] | undefined {
  const [x, y] = [a?.length ? a : undefined, b?.length ? b : undefined];
  if (x === undefined || y === undefined) return x === undefined ? y && [...y] : [...x];
  return x.filter((value) => y.includes(value));
}

/**
 * One clause that says what both say, or `null` when nothing can be both.
 * The kind is then made explicit wherever the axioms of `boxes.ts` fix it —
 * a Level means `monster`, a sub-kind means the kinds it exists for — and a
 * negation that is vacuous of what is left (`non-tuner` of a Spell) is shed,
 * so that the result is one the grammar can write.
 */
function meetClauses(a: Clause, b: Clause): Clause | null {
  const out: Clause = {};
  const flags = { ...a.flags };
  for (const [flag, want] of Object.entries(b.flags ?? {}) as [keyof typeof flags, boolean][]) {
    if (flags[flag] !== undefined && flags[flag] !== want) return null;
    flags[flag] = want;
  }
  const attributes = meetValues(a.attributes, b.attributes);
  const races = meetValues(a.races, b.races);
  const atk = meetStat(a.atk, b.atk);
  const def = meetStat(a.def, b.def);
  const level = meetLists(a.level, b.level);
  let stSubkinds = meetLists(a.stSubkinds, b.stSubkinds);
  let kinds: readonly Kind[] | undefined = meetLists(a.kinds, b.kinds);
  if (attributes === null || races === null || atk === null || def === null) return null;
  if (level?.length === 0 || stSubkinds?.length === 0 || kinds?.length === 0) return null;

  const monsterOnly =
    level !== undefined ||
    atk !== undefined ||
    def !== undefined ||
    (attributes !== undefined && 'in' in attributes) ||
    (races !== undefined && 'in' in races) ||
    Object.values(flags).some((want) => want);
  if (monsterOnly) {
    if (stSubkinds !== undefined || !(kinds ?? KINDS).includes('monster')) return null;
    kinds = ['monster'];
  }
  if (stSubkinds !== undefined) {
    const listed = ST_SUBKIND_VOCABULARY.filter((entry) => stSubkinds!.includes(entry.subkind));
    kinds = KINDS.filter(
      (kind) =>
        kind !== 'monster' &&
        (kinds ?? KINDS).includes(kind) &&
        listed.some((entry) => entry.kinds.includes(kind)),
    );
    if (kinds.length === 0) return null;
    stSubkinds = listed
      .filter((entry) => entry.kinds.some((kind) => kinds!.includes(kind)))
      .map((entry) => entry.subkind);
  }

  // Of a Spell or Trap every monster negation is true (axiom 2): it says nothing.
  const noMonster = kinds !== undefined && !kinds.includes('monster');
  if (kinds !== undefined) out.kinds = [...kinds];
  if (!noMonster && Object.keys(flags).length > 0) out.flags = flags;
  if (stSubkinds !== undefined) out.stSubkinds = stSubkinds;
  if (attributes !== undefined && !noMonster) out.attributes = attributes;
  if (races !== undefined && !noMonster) out.races = races;
  if (level !== undefined) out.level = level;
  if (atk !== undefined) out.atk = atk;
  if (def !== undefined) out.def = def;
  const archetypes = [...(a.archetypes ?? []), ...(b.archetypes ?? [])];
  if (archetypes.length > 0) out.archetypes = archetypes;
  return out;
}

type Point = Exclude<Alternative, { t: 'clause' }>;

const cardOf = (passcode: number): Description => ({ anyOf: [{ t: 'card', passcode }] });

function codesOf(alt: Point, ctx: ImpliesContext): number[] {
  return alt.t === 'card' ? [alt.passcode] : [...(ctx.groups.get(alt.groupId) ?? [])];
}

/** `alt` whole if every card it names matches `other`; else the ones that do, one by one. */
function pointsWithin(alt: Point, other: Description, ctx: ImpliesContext): Alternative[] {
  const codes = codesOf(alt, ctx);
  const matching = codes.filter((code) => implies(cardOf(code), other, ctx));
  if (matching.length === codes.length && codes.length > 0) return [alt];
  return matching.map((passcode): Alternative => ({ t: 'card', passcode }));
}

/**
 * A description of exactly the cards that match BOTH, or `null` when none
 * can: alternative by alternative — two clauses meet dimension by dimension,
 * and a card or group keeps the cards the other side admits. Canonical, but
 * not necessarily within the grammar; `nearMiss` checks that before it
 * suggests one.
 */
export function conjunction(
  a: Description,
  b: Description,
  ctx: ImpliesContext,
): Description | null {
  const anyOf: Alternative[] = [];
  for (const x of a.anyOf) {
    if (x.t !== 'clause') {
      anyOf.push(...pointsWithin(x, b, ctx));
      continue;
    }
    for (const y of b.anyOf) {
      if (y.t !== 'clause') {
        anyOf.push(...pointsWithin(y, { anyOf: [x] }, ctx));
        continue;
      }
      const clause = meetClauses(x.clause, y.clause);
      if (clause === null) continue;
      const alt: Alternative = { t: 'clause', clause };
      // Two clauses can agree dimension by dimension and still admit no card (axiom 4 aside,
      // `toBoxes` is the judge of that).
      if (toBoxes({ anyOf: [alt] }, archetypeDimsOf({ anyOf: [alt] })).length > 0) anyOf.push(alt);
    }
  }
  return anyOf.length === 0 ? null : canonicalize({ anyOf });
}

/** More alternatives than this is not a line anyone would write. */
const MAX_SUGGESTED_ALTERNATIVES = 6;

function suggestionOf(
  line: Description,
  req: Description,
  ctx: NearMissContext,
): string | undefined {
  const both = conjunction(line, req, ctx.implies);
  if (both === null || both.anyOf.length > MAX_SUGGESTED_ALTERNATIVES) return undefined;
  const text = print(both, ctx.desc);
  // "Expressible" is decided by the grammar itself: the text must read back as a satisfiable
  // refinement of the line that fills the requirement.
  const parsed = parse(text, ctx.desc);
  if (!parsed.ok) return undefined;
  const fits =
    implies(parsed.desc, req, ctx.implies) &&
    implies(parsed.desc, line, ctx.implies) &&
    intersects(parsed.desc, UNIVERSE, ctx.implies);
  return fits ? text : undefined;
}

// --- the first failing dimension ---------------------------------------------------

interface Failing {
  dimension: NearMissDimension;
  reason: NearMissReason;
  label: string;
}

const REASON_WORDS: Partial<Record<NearMissReason, string>> = {
  unstated: 'unstated',
  broader: 'too broad',
  different: 'differs',
};

function reasonOf(isFull: boolean, meets: boolean): NearMissReason {
  return isFull ? 'unstated' : meets ? 'broader' : 'different';
}

/** `held` against the union of `allowed`, for one mask dimension. */
function maskFailure(held: number, allowed: readonly number[], full: number) {
  const union = allowed.reduce((all, mask) => all | mask, 0);
  return (held & ~union) === 0 ? null : reasonOf(held === full, (held & union) !== 0);
}

function statFailure(held: StatSet, allowed: readonly StatSet[], full: StatSet) {
  let outside = held;
  for (const set of allowed) outside = statSubtract(outside, set);
  if (statIsEmpty(outside)) return null;
  const isFull = statIsEmpty(statSubtract(full, held));
  return reasonOf(
    isFull,
    allowed.some((set) => !statIsEmpty(statIntersect(held, set))),
  );
}

/**
 * The first dimension, in the order of `NEAR_MISS_DIMENSIONS`, on which `box`
 * is not contained in `within` — boxes of its own kind — taken together.
 */
function firstFailure(
  box: Box,
  within: readonly Box[],
  dims: ArchetypeDims,
  ctx: NearMissContext,
): Failing | null {
  const full = fullBox(box.kind, dims);
  const mask = (at: number) =>
    maskFailure(
      box.masks[at]!,
      within.map((q) => q.masks[at]!),
      full.masks[at]!,
    );
  const stat = (at: number) =>
    statFailure(
      box.stats[at]!,
      within.map((q) => q.stats[at]!),
      full.stats[at]!,
    );
  const archetypes = (offset: number): Failing | null => {
    for (const [i, code] of dims.entries()) {
      const reason = mask(offset + i);
      if (reason === null) continue;
      const name = formatArchetype(ctx.desc.setnames?.nameOf(code), code);
      return { dimension: 'archetype', reason, label: `archetype ${name}` };
    }
    return null;
  };

  if (box.kind !== 'monster') {
    const reason = mask(ST_LAYOUT.subkind);
    if (reason !== null) return { dimension: 'subkind', reason, label: 'sub-kind' };
    return archetypes(ST_LAYOUT.archetypes);
  }
  const level = mask(MONSTER_LAYOUT.level);
  if (level !== null) return { dimension: 'level', reason: level, label: 'Level' };
  const atk = stat(STAT_LAYOUT.atk);
  if (atk !== null) return { dimension: 'atk', reason: atk, label: 'ATK' };
  const def = stat(STAT_LAYOUT.def);
  if (def !== null) return { dimension: 'def', reason: def, label: 'DEF' };
  const attribute = mask(MONSTER_LAYOUT.attribute);
  if (attribute !== null) return { dimension: 'attribute', reason: attribute, label: 'Attribute' };
  const race = mask(MONSTER_LAYOUT.race);
  if (race !== null) return { dimension: 'type', reason: race, label: 'Type' };
  for (const flag of MONSTER_FLAGS) {
    const reason = mask(MONSTER_LAYOUT.flag(flag));
    if (reason !== null) return { dimension: 'flags', reason, label: monsterFlagEntry(flag).name };
  }
  return archetypes(MONSTER_LAYOUT.archetypes);
}

function clauseFailure(line: Description, req: Description, ctx: NearMissContext): Failing {
  const dims = archetypeDimsOf(line, req);
  const lineBoxes = toBoxes(line, dims);
  const reqBoxes = toBoxes(req, dims);
  const meets = (box: Box) => reqBoxes.filter((q) => boxIntersect(box, q) !== null);
  // Nothing the line describes is described by the requirement: they meet in named cards only.
  if (!lineBoxes.some((box) => meets(box).length > 0))
    return { dimension: 'named', reason: 'named', label: '' };

  const uncovered = lineBoxes.filter((box) => subtractAll([box], reqBoxes).length > 0);
  const reqKinds = new Set(reqBoxes.map((q) => q.kind));
  if (uncovered.some((box) => !reqKinds.has(box.kind))) {
    const lineKinds = new Set(lineBoxes.map((box) => box.kind));
    return {
      dimension: 'kind',
      reason: reasonOf(lineKinds.size === KINDS.length, true),
      label: 'kind',
    };
  }

  let first: Failing | null = null;
  for (const box of uncovered) {
    // What the box meets is what it was meant to fit in; a box that meets nothing differs.
    const met = meets(box);
    const within = met.length > 0 ? met : reqBoxes.filter((q) => q.kind === box.kind);
    const failing = firstFailure(box, within, dims, ctx);
    if (failing === null) continue;
    if (
      first === null ||
      NEAR_MISS_DIMENSIONS.indexOf(failing.dimension) <
        NEAR_MISS_DIMENSIONS.indexOf(first.dimension)
    )
      first = failing;
  }
  return first ?? { dimension: 'combination', reason: 'combination', label: '' };
}

/**
 * What keeps `line` from filling `req`, or `null` when it is not a near miss:
 * it fills it (`implies`), or no card could be both (`!intersects`).
 *
 * The cards the line NAMES are looked at first — the ones that do not match
 * are listed. Otherwise the line's clauses are at fault, and the first
 * dimension on which their boxes are not contained in the requirement's is
 * reported, in the order of `NEAR_MISS_DIMENSIONS`. Containment is judged
 * box by box, each line box against the requirement boxes it meets, taken
 * together; the earliest failure over the line's boxes wins.
 */
export function nearMiss(
  line: Description,
  req: Description,
  ctx: NearMissContext,
): NearMiss | null {
  if (!intersects(line, req, ctx.implies) || implies(line, req, ctx.implies)) return null;

  const strangers = line.anyOf.flatMap((alt) =>
    alt.t === 'clause'
      ? []
      : codesOf(alt, ctx.implies).filter((code) => !implies(cardOf(code), req, ctx.implies)),
  );
  let found: Omit<NearMiss, 'suggestion'>;
  if (strangers.length > 0) {
    const names = [...new Set(strangers)].map((code) => {
      const name = ctx.implies.cards.get(code)?.name;
      return name === undefined ? `#${code}` : `#${code} (${name})`;
    });
    found = {
      dimension: 'card',
      reason: 'members',
      what: `${names.join(', ')} ${names.length === 1 ? 'does' : 'do'} not match`,
    };
  } else {
    const { dimension, reason, label } = clauseFailure(line, req, ctx);
    const what =
      reason === 'named'
        ? 'a generic line never counts as a named card'
        : reason === 'combination'
          ? 'covered by no single alternative'
          : `${label} ${REASON_WORDS[reason]}`;
    found = { dimension, reason, what };
  }
  const suggestion = suggestionOf(line, req, ctx);
  return suggestion === undefined ? found : { ...found, suggestion };
}
