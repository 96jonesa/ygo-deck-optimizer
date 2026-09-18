import {
  ATTRIBUTE_EARTH,
  ATTRIBUTE_FIRE,
  ATTRIBUTE_WATER,
  RACE_CYBORG,
  RACE_DRAGON,
  RACE_SPELLCASTER,
  RACE_WARRIOR,
  TYPE_MONSTER,
  TYPE_SPELL,
  TYPE_TRAP,
} from '../../src/core/cards/constants';
import type { CardRecord } from '../../src/core/cards/record';
import {
  ATTRIBUTE_VOCABULARY,
  KINDS,
  type Kind,
  type MonsterFlag,
  monsterFlagEntry,
  RACE_VOCABULARY,
  ST_SUBKIND_VOCABULARY,
  ST_SUBKINDS,
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
import { matcher } from '../../src/core/desc/evaluate';
import { cardRecord } from './desc-context';
import type { Rng } from './prng';

/**
 * The semantic oracle for `implies` (TDD §15.1): `evaluate` is the meaning of
 * a description, so `L ⇒ q` holds iff no card matches `L` without matching
 * `q`. "No card" ranges over every card the model of TDD §6.1 admits, which is
 * infinite — so `universeFor` builds, per pair, a finite universe with a
 * representative of every cell of the partition the pair can induce.
 *
 * Why the universe is cell-complete. A clause is a conjunction of atoms, and
 * (reading `evaluate.ts`) each atom reads the card's kind plus exactly ONE
 * other field: one flag bit, the attribute, the race, the level, ATK, DEF, the
 * sub-kind bits, or the setcodes. Two cards of the same kind that agree on the
 * truth of every atom the pair mentions are therefore indistinguishable to
 * both descriptions, so it is enough to take, per field, one value for every
 * distinct truth-vector over that field's atoms ("signature") and then the
 * full PRODUCT of those representatives across fields. Per field, the
 * candidates the signatures are taken over are exhaustive for the model:
 * - Attribute: each of the 7 bits, and 0 (no attribute). Type: each of the 26
 *   official bits, 0, and an unofficial bit. Level: every integer
 *   LEVEL_MIN..LEVEL_MAX and one above. One value per card — the model's
 *   stated assumption.
 * - ATK / DEF: `?`, 0, and e-1, e, e+1 for every range endpoint e the pair
 *   mentions. A range atom is constant between consecutive endpoints, so
 *   every interval the endpoints cut the integers into holds a candidate,
 *   including the unbounded one above the largest.
 * - Flags: every combination of the flags the pair mentions.
 * - Sub-kinds: all six Spell and all three Trap values, never de-duplicated.
 * - Archetypes: a card is a SET of codes and matches a query when any one code
 *   does, so its signature is the union of its codes' signatures. Every
 *   single code that can match anything shares its low 12 bits with a
 *   mentioned query, and those are enumerated over all 16 high nibbles; the
 *   card configurations are then all unions of the distinct single-code
 *   signatures, plus the card with no codes.
 * The signatures are computed with `evaluate` itself, not re-derived here.
 * `fullDimension` lets a test leave one field un-de-duplicated to check that
 * the de-duplication never changes a verdict.
 */

const NO_GROUPS = new Map<string, ReadonlySet<number>>();

const ATTRIBUTE_BITS = ATTRIBUTE_VOCABULARY.map((entry) => entry.bit);
const RACE_BITS = RACE_VOCABULARY.map((entry) => entry.bit);
const ATTRIBUTE_CANDIDATES: readonly number[] = [0, ...ATTRIBUTE_BITS];
const RACE_CANDIDATES: readonly number[] = [0, RACE_CYBORG, ...RACE_BITS];
const LEVEL_CANDIDATES: readonly number[] = Array.from(
  { length: LEVEL_MAX - LEVEL_MIN + 2 },
  (_, i) => LEVEL_MIN + i,
);
const UNKNOWN_STAT = -2;

const SPELL_TYPES = ST_SUBKIND_VOCABULARY.filter((e) => e.kinds.includes('spell')).map(
  (e) => TYPE_SPELL | e.bit,
);
const TRAP_TYPES = ST_SUBKIND_VOCABULARY.filter((e) => e.kinds.includes('trap')).map(
  (e) => TYPE_TRAP | e.bit,
);

export type MonsterField = 'attribute' | 'race' | 'level' | 'atk' | 'def' | 'setcodes';

function clauseDesc(clause: Clause): Description {
  return { anyOf: [{ t: 'clause', clause }] };
}

function clausesOf(...descs: Description[]): Clause[] {
  return descs.flatMap((desc) =>
    desc.anyOf.flatMap((alt) => (alt.t === 'clause' ? [alt.clause] : [])),
  );
}

/** The first candidate of every distinct truth-vector over `atoms`, judged by `evaluate`. */
function representatives<T>(
  candidates: readonly T[],
  atoms: readonly Clause[],
  probe: (value: T) => CardRecord,
  keepAll = false,
): T[] {
  if (keepAll) return [...candidates];
  const tests = atoms.map((atom) => matcher(clauseDesc(atom), NO_GROUPS));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of candidates) {
    const card = probe(value);
    const signature = tests.map((test) => (test(card) ? '1' : '0')).join('');
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(value);
  }
  return out;
}

function statCandidates(stats: readonly Stat[]): number[] {
  const values = new Set<number>([UNKNOWN_STAT, 0]);
  for (const stat of stats) {
    if (stat === '?') continue;
    for (const endpoint of [stat.min, stat.max])
      if (endpoint !== null)
        for (const value of [endpoint - 1, endpoint, endpoint + 1])
          if (value >= 0) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Every setcode list a card can carry, up to which of `queries` it matches. */
function setcodeCandidates(queries: readonly number[]): number[][] {
  const singles: number[] = [];
  for (const base of new Set(queries.map((query) => query & 0xfff)))
    for (let nibble = 0; nibble < 16; nibble++) {
      const code = (nibble << 12) | base;
      if (code !== 0) singles.push(code);
    }
  const atoms = queries.map((query) => ({ archetypes: [query] }));
  const distinct = representatives(singles, atoms, (code) => cardRecord({ setcodes: [code] }));
  let unions: number[][] = [[]];
  for (const code of distinct) unions = [...unions, ...unions.map((codes) => [...codes, code])];
  return unions;
}

export interface UniverseOptions {
  /** Keep every candidate of this field instead of one per signature. */
  fullDimension?: MonsterField;
}

/** A cell-complete universe for the pair (see the file comment); clause alternatives only. */
export function universeFor(
  L: Description,
  q: Description,
  opts: UniverseOptions = {},
): CardRecord[] {
  const clauses = clausesOf(L, q);
  const pick = <K extends keyof Clause>(key: K): Clause[] =>
    clauses.flatMap((clause) => (clause[key] !== undefined ? [{ [key]: clause[key] }] : []));
  const full = (field: MonsterField) => opts.fullDimension === field;

  const flags = [...new Set(clauses.flatMap((c) => Object.keys(c.flags ?? {}) as MonsterFlag[]))];
  const flagMasks = Array.from({ length: 1 << flags.length }, (_, combo) =>
    flags.reduce(
      (bits, flag, i) => (combo & (1 << i) ? bits | monsterFlagEntry(flag).bit : bits),
      0,
    ),
  );
  const attributes = representatives(
    ATTRIBUTE_CANDIDATES,
    pick('attributes'),
    (attribute) => cardRecord({ attribute }),
    full('attribute'),
  );
  const races = representatives(
    RACE_CANDIDATES,
    pick('races'),
    (race) => cardRecord({ race }),
    full('race'),
  );
  const levels = representatives(
    LEVEL_CANDIDATES,
    pick('level'),
    (level) => cardRecord({ level }),
    full('level'),
  );
  const atks = representatives(
    statCandidates(clauses.flatMap((c) => (c.atk !== undefined ? [c.atk] : []))),
    pick('atk'),
    (atk) => cardRecord({ atk }),
    full('atk'),
  );
  const defs = representatives(
    statCandidates(clauses.flatMap((c) => (c.def !== undefined ? [c.def] : []))),
    pick('def'),
    (def) => cardRecord({ def }),
    full('def'),
  );
  const queries = [...new Set(clauses.flatMap((c) => c.archetypes ?? []))];
  const setcodeLists = representatives(
    setcodeCandidates(queries),
    queries.map((query) => ({ archetypes: [query] })),
    (setcodes) => cardRecord({ setcodes }),
    full('setcodes'),
  );

  const cards: CardRecord[] = [];
  const add = (fields: Partial<CardRecord>) =>
    cards.push(cardRecord({ code: cards.length + 1, ...fields }));
  for (const setcodes of setcodeLists) {
    for (const type of [...SPELL_TYPES, ...TRAP_TYPES])
      add({ type, atk: 0, def: 0, level: 0, race: 0, attribute: 0, setcodes });
    for (const flagMask of flagMasks)
      for (const attribute of attributes)
        for (const race of races)
          for (const level of levels)
            for (const atk of atks)
              for (const def of defs)
                add({ type: TYPE_MONSTER | flagMask, attribute, race, level, atk, def, setcodes });
  }
  return cards;
}

export interface Verdict {
  holds: boolean;
  /** A card matching `L` and not `q`, when there is one. */
  counterexample?: CardRecord;
  universeSize: number;
}

/** `∀ card: evaluate(L, card) → evaluate(q, card)` over `universeFor(L, q)`. */
export function semanticImplies(
  L: Description,
  q: Description,
  opts: UniverseOptions = {},
): Verdict {
  const universe = universeFor(L, q, opts);
  const inL = matcher(L, NO_GROUPS);
  const inQ = matcher(q, NO_GROUPS);
  const counterexample = universe.find((card) => inL(card) && !inQ(card));
  return { holds: counterexample === undefined, counterexample, universeSize: universe.length };
}

/** Whether any card the model admits matches `desc`. */
export function semanticSatisfiable(desc: Description): boolean {
  const inDesc = matcher(desc, NO_GROUPS);
  return universeFor(desc, desc).some(inDesc);
}

// --- a generator over a REDUCED vocabulary ------------------------------------
// Few values per dimension, so that two independently generated descriptions
// constrain the same dimension with overlapping values often enough for
// containment, overlap and disjointness all to occur. Unlike `gen-desc.ts` it
// is NOT restricted to the image of `parse`: `implies` must be right on every
// AST `evaluate` gives a meaning to (`counter` beside `spell`, a sub-kind with
// no kinds, `normal: true` beside `trap`).

const LEVELS = [3, 4, 5, 6];
/** Adjacent endpoints (999/1000/1001) so that an off-by-one in interval arithmetic shows. */
const STAT_POINTS = [0, 999, 1000, 1001, 2000, 3000];
const ATTRIBUTES = [ATTRIBUTE_FIRE, ATTRIBUTE_WATER, ATTRIBUTE_EARTH];
const RACES = [RACE_WARRIOR, RACE_DRAGON, RACE_SPELLCASTER];
const FLAGS: readonly MonsterFlag[] = ['tuner', 'effect', 'normal'];
/** Base, its two sub-archetypes, their union, and an unrelated code (TDD §4.1). */
export const REDUCED_SETCODES = [0x66, 0x1066, 0x2066, 0x3066, 0x99];

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
  ['monster', 'spell', 'trap'],
];

function range(low: number, high: number): number[] {
  return Array.from({ length: high - low + 1 }, (_, i) => low + i);
}

function genReducedLevel(rng: Rng): number[] {
  switch (rng.int(0, 5)) {
    case 0:
      return range(LEVEL_MIN, rng.pick(LEVELS));
    case 1:
      return range(rng.pick(LEVELS), LEVEL_MAX);
    case 2:
      return rng.chance(0.3) ? range(LEVEL_MIN, LEVEL_MAX) : [rng.pick(LEVELS)];
    default:
      return rng.subset(LEVELS, 1, 4);
  }
}

function genReducedStat(rng: Rng): Stat {
  const [a, b] = [rng.pick(STAT_POINTS), rng.pick(STAT_POINTS)].sort((x, y) => x - y) as [
    number,
    number,
  ];
  switch (rng.int(0, 5)) {
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

/** Mostly a few values; sometimes nearly the whole vocabulary, where NONE / OTHER decide. */
function genReducedValueSet(
  rng: Rng,
  few: readonly number[],
  all: readonly number[],
): ValueSet<number> {
  const dropped = rng.subset(all, 0, 2);
  const values = rng.chance(0.15)
    ? all.filter((bit) => !dropped.includes(bit))
    : rng.subset(few, 1, 2);
  return rng.chance(0.35) ? { notIn: values } : { in: values };
}

export function genReducedClause(rng: Rng): Clause {
  const clause: Clause = {};
  const kinds = rng.pick(KIND_CHOICES);
  if (kinds) clause.kinds = [...kinds];
  if (rng.chance(0.2)) clause.stSubkinds = rng.subset(ST_SUBKINDS, 1, 3);
  if (rng.chance(0.25)) clause.level = genReducedLevel(rng);
  if (rng.chance(0.2)) clause.atk = genReducedStat(rng);
  if (rng.chance(0.15)) clause.def = genReducedStat(rng);
  if (rng.chance(0.25)) clause.attributes = genReducedValueSet(rng, ATTRIBUTES, ATTRIBUTE_BITS);
  if (rng.chance(0.2)) clause.races = genReducedValueSet(rng, RACES, RACE_BITS);
  const flags: Partial<Record<MonsterFlag, boolean>> = {};
  for (const flag of FLAGS) if (rng.chance(0.15)) flags[flag] = rng.chance(0.5);
  if (Object.keys(flags).length > 0) clause.flags = flags;
  if (rng.chance(0.3)) clause.archetypes = rng.subset(REDUCED_SETCODES, 1, 2);
  return clause;
}

/** One to three clause alternatives — no cards or groups, which are not semantic (TDD §6.2). */
export function genReducedDescription(rng: Rng): Description {
  const count = rng.pick([1, 1, 1, 2, 2, 3]);
  const anyOf = Array.from(
    { length: count },
    (): Alternative => ({ t: 'clause', clause: genReducedClause(rng) }),
  );
  return canonicalize({ anyOf });
}

// --- weakening ---------------------------------------------------------------
// `weaken(d)` is built so that `d ⇒ weaken(d)` USUALLY holds, which is what
// makes a substantial fraction of the oracle's pairs true implications. It is
// never assumed to hold: the oracle decides.

type ClauseEdit = (rng: Rng, clause: Clause) => Clause[] | null;

function widenStat(rng: Rng, stat: Stat): Stat | undefined {
  if (stat === '?') return undefined;
  if (rng.chance(0.5))
    return { min: rng.chance(0.5) ? 0 : Math.max(0, stat.min - 1), max: stat.max };
  return { min: stat.min, max: stat.max === null || rng.chance(0.5) ? null : stat.max + 1 };
}

function widenValueSet(
  rng: Rng,
  set: ValueSet<number>,
  all: readonly number[],
): ValueSet<number> | undefined {
  if ('in' in set) return { in: [...set.in, rng.pick(all)] };
  const kept = set.notIn.filter(() => rng.chance(0.5));
  return kept.length > 0 ? { notIn: kept } : undefined;
}

function without<K extends keyof Clause>(clause: Clause, key: K): Clause {
  const { [key]: _dropped, ...rest } = clause;
  return rest;
}

function withField<K extends keyof Clause>(clause: Clause, key: K, value: Clause[K]): Clause {
  return value === undefined ? without(clause, key) : { ...clause, [key]: value };
}

const CLAUSE_EDITS: readonly ClauseEdit[] = [
  // Drop one constraint.
  (rng, clause) => {
    const keys = Object.keys(clause) as (keyof Clause)[];
    if (keys.length === 0) return null;
    const key = rng.pick(keys);
    if (key === 'flags') {
      const flags = { ...clause.flags };
      delete flags[rng.pick(Object.keys(flags) as MonsterFlag[])];
      return [withField(clause, 'flags', Object.keys(flags).length > 0 ? flags : undefined)];
    }
    if (key === 'archetypes' && clause.archetypes!.length > 1)
      return [{ ...clause, archetypes: clause.archetypes!.slice(1) }];
    return [without(clause, key)];
  },
  // Widen one dimension.
  (rng, clause) => {
    const widened: Clause[] = [];
    if (clause.level)
      widened.push({ ...clause, level: [...clause.level, rng.int(LEVEL_MIN, LEVEL_MAX)] });
    if (clause.atk !== undefined)
      widened.push(withField(clause, 'atk', widenStat(rng, clause.atk)));
    if (clause.def !== undefined)
      widened.push(withField(clause, 'def', widenStat(rng, clause.def)));
    if (clause.attributes)
      widened.push(
        withField(clause, 'attributes', widenValueSet(rng, clause.attributes, ATTRIBUTE_BITS)),
      );
    if (clause.races)
      widened.push(withField(clause, 'races', widenValueSet(rng, clause.races, RACE_BITS)));
    if (clause.stSubkinds)
      widened.push({ ...clause, stSubkinds: [...clause.stSubkinds, rng.pick(ST_SUBKINDS)] });
    if (clause.kinds) widened.push({ ...clause, kinds: [...clause.kinds, rng.pick(KINDS)] });
    return widened.length > 0 ? [rng.pick(widened)] : null;
  },
  // Replace a sub-archetype by one of its bases (axiom 4).
  (rng, clause) => {
    const subs = (clause.archetypes ?? []).filter((code) => code > 0xfff);
    if (subs.length === 0) return null;
    const sub = rng.pick(subs);
    const nibbleBits = [0x1000, 0x2000, 0x4000, 0x8000].filter((bit) => (sub & bit) !== 0);
    const base = rng.chance(0.5) ? sub & 0xfff : sub & ~rng.pick(nibbleBits);
    return [{ ...clause, archetypes: clause.archetypes!.map((c) => (c === sub ? base : c)) }];
  },
  // Split a Level set or a stat range into two alternatives (the case of TDD §6.2), in
  // either order: subtracting the upper half first is what leaves a piece BELOW a cut.
  (rng, clause) => {
    const splits: [Clause, Clause][] = [];
    if (clause.level && clause.level.length > 1) {
      const cut = rng.int(1, clause.level.length - 1);
      splits.push([
        { ...clause, level: clause.level.slice(0, cut) },
        { ...clause, level: clause.level.slice(cut) },
      ]);
    }
    for (const key of ['atk', 'def'] as const) {
      const stat = clause[key];
      if (stat === undefined || stat === '?') continue;
      const cuts = STAT_POINTS.filter((p) => p >= stat.min && (stat.max === null || p < stat.max));
      if (cuts.length === 0) continue;
      const cut = rng.pick(cuts);
      splits.push([
        { ...clause, [key]: { min: stat.min, max: cut } },
        { ...clause, [key]: { min: cut + 1, max: stat.max } },
      ]);
    }
    if (splits.length === 0) return null;
    const [low, high] = rng.pick(splits);
    return rng.chance(0.5) ? [low, high] : [high, low];
  },
  // Positive to negative: FIRE ⇒ non-WATER (one value per card); spell ⇒ non-tuner (axiom 2).
  (rng, clause) => {
    if (clause.attributes && 'in' in clause.attributes) {
      const others = ATTRIBUTE_BITS.filter(
        (bit) => !(clause.attributes as { in: number[] }).in.includes(bit),
      );
      if (others.length > 0)
        return [{ ...clause, attributes: { notIn: rng.subset(others, 1, 3) } }];
    }
    if (clause.kinds && !clause.kinds.includes('monster'))
      return [{ ...without(clause, 'kinds'), flags: { [rng.pick(FLAGS)]: false } }];
    return null;
  },
];

/** `desc` with one to three weakening edits applied, canonical. */
export function weaken(rng: Rng, desc: Description, genClause: (rng: Rng) => Clause): Description {
  let anyOf = [...desc.anyOf];
  for (let edits = rng.int(1, 3); edits > 0; edits--) {
    const i = rng.int(0, anyOf.length - 1);
    const alt = anyOf[i]!;
    const edited =
      alt.t === 'clause' && rng.chance(0.85) ? rng.pick(CLAUSE_EDITS)(rng, alt.clause) : null;
    if (edited === null) {
      anyOf.push({ t: 'clause', clause: genClause(rng) });
      continue;
    }
    const replacement = edited.map((clause): Alternative => ({ t: 'clause', clause }));
    anyOf = [...anyOf.slice(0, i), ...replacement, ...anyOf.slice(i + 1)];
  }
  return canonicalize({ anyOf });
}
