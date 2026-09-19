import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../../src/core/cards/index';
import { type Kind, ST_SUBKIND_VOCABULARY } from '../../../src/core/cards/vocabulary';
import {
  type Clause,
  canonicalize,
  type Description,
  type Stat,
  type ValueSet,
} from '../../../src/core/desc/ast';
import { type Groups, matcher } from '../../../src/core/desc/evaluate';
import { implies, intersects, UNIVERSE } from '../../../src/core/desc/implies';
import {
  conjunction,
  NEAR_MISS_DIMENSIONS,
  type NearMissContext,
  type NearMissDimension,
  nearMiss,
} from '../../../src/core/desc/near-miss';
import { parse } from '../../../src/core/desc/parser';
import { print } from '../../../src/core/desc/print';
import { same } from '../../helpers/assert';
import { contextOf, FakeGroups } from '../../helpers/desc-context';
import { buildCdb, CODE, FIXTURE_ROWS, POPULATION } from '../../helpers/fixture-cards';
import { type GenPool, genClause, genDescription } from '../../helpers/gen-desc';
import { weaken } from '../../helpers/implies-oracle';
import { type Rng, seededRng } from '../../helpers/prng';

const SQL = await initSqlJs();
const fixture = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, FIXTURE_ROWS) }]);
const UNKNOWN_PASSCODE = 12345;
const GROUPS: Groups = new Map([
  ['g-starters', new Set([CODE.tunerFairy, CODE.quickSpell])],
  ['g-lights', new Set([CODE.vanillaDragon, CODE.tunerFairy])],
  ['g-empty', new Set<number>()],
  ['g-broken', new Set([CODE.tunerFairy, UNKNOWN_PASSCODE])],
]);
const descCtx = contextOf(fixture, {
  groups: new FakeGroups([
    ['g-starters', 'Starters'],
    ['g-lights', 'Lights'],
    ['g-empty', 'Empty'],
    ['g-broken', 'Broken'],
  ]),
});
const ctx: NearMissContext = { desc: descCtx, implies: { cards: fixture, groups: GROUPS } };

function d(text: string): Description {
  const result = parse(text, descCtx);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.desc;
}

const show = (L: Description, q: Description) =>
  `\n  line: ${print(L, descCtx)}\n  req:  ${print(q, descCtx)}`;

/** `[what, suggestion]` of the near miss of the line `L` for the requirement `q`. */
function missOf(L: string, q: string): [string, string | undefined] | null {
  const miss = nearMiss(d(L), d(q), ctx);
  return miss === null ? null : [miss.what, miss.suggestion];
}

describe('nearMiss', () => {
  it('is null for a line that fills the requirement, and for one that cannot', () => {
    expect(missOf('level 4 monster', 'level 4 or lower monster')).toBeNull();
    expect(missOf('spell', 'level 4 or lower monster')).toBeNull();
    expect(missOf('level 5 monster', 'level 4 or lower monster')).toBeNull();
  });

  it('says what the PRD says of the motivating example: Level unstated (PRD §6.4)', () => {
    expect(nearMiss(d('monster'), d('level 4 or lower monster'), ctx)).toEqual({
      dimension: 'level',
      reason: 'unstated',
      what: 'Level unstated',
      suggestion: 'level 4 or lower monster',
    });
  });

  it('names each dimension a line can leave unstated', () => {
    expect(missOf('card', 'monster')).toEqual(['kind unstated', 'monster']);
    expect(missOf('monster', 'level 4 monster')).toEqual(['Level unstated', 'level 4 monster']);
    expect(missOf('monster', 'ATK 1500 or less monster')).toEqual([
      'ATK unstated',
      'ATK 1500 or less monster',
    ]);
    expect(missOf('monster', 'DEF 2000 or more monster')).toEqual([
      'DEF unstated',
      'DEF 2000 or more monster',
    ]);
    expect(missOf('level 4 monster', 'level 4 FIRE monster')).toEqual([
      'Attribute unstated',
      'level 4 FIRE monster',
    ]);
    expect(missOf('monster', 'Warrior monster')).toEqual(['Type unstated', 'Warrior monster']);
    expect(missOf('monster', 'tuner monster')).toEqual(['Tuner unstated', 'tuner monster']);
    expect(missOf('monster', 'non-effect monster')).toEqual([
      'Effect unstated',
      'non-effect monster',
    ]);
    expect(missOf('spell', 'normal spell')).toEqual(['sub-kind unstated', 'normal spell']);
    expect(missOf('trap', 'counter trap')).toEqual(['sub-kind unstated', 'counter trap']);
    expect(missOf('monster', '"Sky Striker" monster')).toEqual([
      'archetype "Sky Striker":0x115 unstated',
      '"Sky Striker":0x115 monster',
    ]);
  });

  it('reports the FIRST failing dimension: kind, Level, ATK, DEF, Attribute, Type, flags, sub-kind, archetype', () => {
    const q = 'level 4 ATK 1000 DEF 1000 FIRE Warrior tuner "Sky Striker" monster';
    const stated = [
      ['card', 'kind unstated'],
      ['monster', 'Level unstated'],
      ['level 4 monster', 'ATK unstated'],
      ['level 4 ATK 1000 monster', 'DEF unstated'],
      ['level 4 ATK 1000 DEF 1000 monster', 'Attribute unstated'],
      ['level 4 ATK 1000 DEF 1000 FIRE monster', 'Type unstated'],
      ['level 4 ATK 1000 DEF 1000 FIRE Warrior monster', 'Tuner unstated'],
      [
        'level 4 ATK 1000 DEF 1000 FIRE Warrior tuner monster',
        'archetype "Sky Striker":0x115 unstated',
      ],
    ] as const;
    for (const [L, what] of stated) expect(missOf(L, q)?.[0], L).toBe(what);
    expect(missOf('spell/trap', 'continuous "Sky Striker" spell/trap')?.[0]).toBe(
      'sub-kind unstated',
    );
    expect(NEAR_MISS_DIMENSIONS).toEqual([
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
    ]);
  });

  it('says "too broad" of a dimension the line states, but not narrowly enough', () => {
    expect(missOf('level 1-6 monster', 'level 4 or lower monster')).toEqual([
      'Level too broad',
      'level 1-4 monster',
    ]);
    expect(missOf('spell/trap', 'trap')).toEqual(['kind too broad', 'trap']);
    expect(missOf('FIRE/WATER monster', 'FIRE monster')).toEqual([
      'Attribute too broad',
      'FIRE monster',
    ]);
    expect(missOf('non-FIRE monster', 'WATER monster')).toEqual([
      'Attribute too broad',
      'WATER monster',
    ]);
    expect(missOf('ATK 1000 or more monster', 'ATK 1500 or more monster')).toEqual([
      'ATK too broad',
      'ATK 1500 or more monster',
    ]);
  });

  it('builds the suggestion from the line AND the requirement: a refinement of the line', () => {
    expect(missOf('FIRE monster', 'level 4 or lower monster')).toEqual([
      'Level unstated',
      'level 4 or lower FIRE monster',
    ]);
    expect(missOf('non-tuner monster', 'Warrior monster')).toEqual([
      'Type unstated',
      'Warrior non-tuner monster',
    ]);
    // Alternative by alternative, dropping the pairs nothing can be.
    expect(missOf('FIRE monster or spell', 'level 4 monster or field spell')).toEqual([
      'Level unstated',
      'level 4 FIRE monster or field spell',
    ]);
  });

  it('reads the kind a line leaves unsaid off the axioms, not off the text', () => {
    // `level 4` can only be a monster: the kind IS stated.
    expect(missOf('level 4', 'level 4 FIRE monster')?.[0]).toBe('Attribute unstated');
    // A Spell is a non-Tuner too: the kind is not.
    expect(missOf('non-tuner card', 'non-tuner monster')).toEqual([
      'kind unstated',
      'non-tuner monster',
    ]);
  });

  it('says so when no single dimension is at fault', () => {
    expect(
      missOf('level 1-6 FIRE/WATER monster', 'level 1-3 FIRE monster or level 4-6 WATER monster'),
    ).toEqual([
      'covered by no single alternative',
      'level 1-3 FIRE monster or level 4-6 WATER monster',
    ]);
  });

  it('never lets a generic line stand for a named card, and suggests the card', () => {
    expect(nearMiss(d('monster'), d(`#${CODE.tunerFairy}`), ctx)).toEqual({
      dimension: 'named',
      reason: 'named',
      what: 'a generic line never counts as a named card',
      suggestion: `#${CODE.tunerFairy}`,
    });
    // A group all of whose members the line admits is suggested whole; else its members.
    expect(missOf('card', '{Starters}')?.[1]).toBe('{Starters}');
    expect(missOf('monster', '{Starters}')?.[1]).toBe(`#${CODE.tunerFairy}`);
  });

  it('names the members of a line that do not match', () => {
    expect(nearMiss(d('{Starters}'), d('monster'), ctx)).toEqual({
      dimension: 'card',
      reason: 'members',
      what: `#${CODE.quickSpell} (Synthetic Quick Spell) does not match`,
      suggestion: `#${CODE.tunerFairy}`,
    });
    expect(missOf(`#${CODE.tunerFairy} or #${CODE.counterTrap}`, 'monster or spell')).toEqual([
      `#${CODE.counterTrap} (Synthetic Counter Trap) does not match`,
      `#${CODE.tunerFairy}`,
    ]);
  });

  it('gives no suggestion it cannot write down', () => {
    // The conjunction names a passcode the database lacks, which the grammar refuses.
    const broken: Description = { anyOf: [{ t: 'group', groupId: 'g-broken' }] };
    const miss = nearMiss(broken, d('level 3 monster'), ctx);
    expect(miss).toMatchObject({ dimension: 'card', reason: 'members' });
    expect(miss!.suggestion).toBe(`#${CODE.tunerFairy}`);
    const unknown: Description = { anyOf: [{ t: 'card', passcode: UNKNOWN_PASSCODE }] };
    const named = nearMiss(UNIVERSE, unknown, ctx);
    expect(named).toMatchObject({ dimension: 'named' });
    expect(named).not.toHaveProperty('suggestion');
  });
});

describe('conjunction', () => {
  const text = (L: string, q: string) => {
    const both = conjunction(d(L), d(q), ctx.implies);
    return both === null ? null : print(both, descCtx);
  };

  it('meets two clauses dimension by dimension', () => {
    expect(text('level 1-6 FIRE/WATER monster', 'level 4 or higher non-WATER tuner monster')).toBe(
      'level 4-6 FIRE tuner monster',
    );
    expect(text('non-FIRE monster', 'non-WATER monster')).toBe('non-WATER/FIRE monster');
    expect(text('ATK 1000-2000 monster', 'ATK 1500 or more monster')).toBe('ATK 1500-2000 monster');
    expect(text('"Sky Striker" card', 'spell')).toBe('"Sky Striker":0x115 spell');
    expect(text('continuous spell/trap', 'trap')).toBe('continuous trap');
  });

  it('is null when nothing can be both', () => {
    expect(text('FIRE monster', 'WATER monster')).toBeNull();
    expect(text('ATK ? monster', 'ATK 1000 or more monster')).toBeNull();
    expect(text('tuner monster', 'non-tuner monster')).toBeNull();
    expect(text('quick-play spell', 'counter trap')).toBeNull();
    expect(text('monster', 'spell')).toBeNull();
  });

  it('says `monster` when either side can only be one, and sheds what is then vacuous', () => {
    expect(text('level 4', 'card')).toBe('level 4 monster');
    expect(text('non-tuner card', 'spell')).toBe('spell');
    expect(text('non-FIRE card', 'spell/trap')).toBe('spell/trap');
  });

  it('keeps the cards of either side that the other admits', () => {
    expect(text(`#${CODE.tunerFairy} or #${CODE.quickSpell}`, 'monster')).toBe(
      `#${CODE.tunerFairy}`,
    );
    expect(text('spell', '{Starters}')).toBe(`#${CODE.quickSpell}`);
    expect(text('{Lights}', 'LIGHT monster')).toBe('{Lights}');
  });
});

// ---------------------------------------------------------------------------
// Oracle A2: near-miss soundness over generated line / requirement pairs.
// ---------------------------------------------------------------------------

/** The kinds a clause can be of, by the axioms of TDD §6.1 — written out here, not read off a box. */
function effectiveKinds(clause: Clause): Kind[] {
  let kinds: Kind[] =
    clause.kinds && clause.kinds.length > 0 ? [...clause.kinds] : ['monster', 'spell', 'trap'];
  const positive =
    (clause.level?.length ?? 0) > 0 ||
    clause.atk !== undefined ||
    clause.def !== undefined ||
    (clause.attributes !== undefined && 'in' in clause.attributes) ||
    (clause.races !== undefined && 'in' in clause.races) ||
    Object.values(clause.flags ?? {}).some((want) => want);
  if (positive) kinds = kinds.filter((kind) => kind === 'monster');
  const subkinds = clause.stSubkinds ?? [];
  if (subkinds.length > 0)
    kinds = kinds.filter(
      (kind) =>
        kind !== 'monster' &&
        ST_SUBKIND_VOCABULARY.some((e) => subkinds.includes(e.subkind) && e.kinds.includes(kind)),
    );
  return kinds;
}

function meetValues(a: ValueSet<number> | undefined, b: ValueSet<number> | undefined) {
  if (a === undefined || b === undefined) return a ?? b;
  if ('in' in a)
    return { in: a.in.filter((v) => ('in' in b ? b.in.includes(v) : !b.notIn.includes(v))) };
  if ('in' in b) return { in: b.in.filter((v) => !a.notIn.includes(v)) };
  return { notIn: [...new Set([...a.notIn, ...b.notIn])] };
}

function meetStat(a: Stat | undefined, b: Stat | undefined): Stat | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  if (a === '?' || b === '?') return '?';
  const max = a.max === null ? b.max : b.max === null ? a.max : Math.min(a.max, b.max);
  return { min: Math.max(a.min, b.min), max };
}

/** `line`, made to say on `dimension` ALONE what `req` says there. */
function strengthen(line: Clause, req: Clause, dimension: NearMissDimension): Clause {
  const out: Clause = structuredClone(line);
  switch (dimension) {
    case 'kind': {
      const allowed = effectiveKinds(req);
      out.kinds = effectiveKinds(line).filter((kind) => allowed.includes(kind));
      break;
    }
    case 'level':
      out.level = line.level ? line.level.filter((n) => req.level!.includes(n)) : req.level!;
      break;
    case 'atk':
      out.atk = meetStat(line.atk, req.atk)!;
      break;
    case 'def':
      out.def = meetStat(line.def, req.def)!;
      break;
    case 'attribute':
      out.attributes = meetValues(line.attributes, req.attributes)!;
      break;
    case 'type':
      out.races = meetValues(line.races, req.races)!;
      break;
    case 'flags':
      out.flags = { ...line.flags, ...req.flags };
      break;
    case 'subkind':
      out.stSubkinds = line.stSubkinds
        ? line.stSubkinds.filter((s) => req.stSubkinds!.includes(s))
        : req.stSubkinds!;
      break;
    case 'archetype':
      out.archetypes = [...new Set([...(line.archetypes ?? []), ...(req.archetypes ?? [])])];
      break;
    default:
      throw new Error(`a single clause cannot miss on ${dimension}`);
  }
  return out;
}

describe('near-miss soundness over generated pairs (oracle A2)', () => {
  const pool: GenPool = {
    passcodes: [...POPULATION, UNKNOWN_PASSCODE],
    groupIds: [...GROUPS.keys()],
    setcodes: [0x66, 0x1066, 0x2066, 0x3066, 0xdd, 0x64, 0x115, 0x1115],
  };
  const cards = [...fixture.all()];
  const single = (rng: Rng): Description => ({
    anyOf: [{ t: 'clause', clause: genClause(rng, pool) }],
  });
  /** A Spell/Trap clause: the general generator seldom lands two of them on one kind. */
  const spellTrap = (rng: Rng): Description => {
    const kinds = rng.pick<Kind[]>([['spell'], ['trap'], ['spell', 'trap']]);
    const exists = ST_SUBKIND_VOCABULARY.filter((e) => e.kinds.some((k) => kinds.includes(k)));
    const clause: Clause = { kinds };
    if (rng.chance(0.7)) clause.stSubkinds = rng.subset(exists, 1, 3).map((e) => e.subkind);
    if (rng.chance(0.3)) clause.archetypes = rng.subset(pool.setcodes, 1, 2);
    return canonicalize({ anyOf: [{ t: 'clause', clause }] });
  };
  const clauseOf = (desc: Description): Clause => (desc.anyOf[0] as { clause: Clause }).clause;

  function genPair(rng: Rng, gen: (rng: Rng) => Description): [Description, Description] {
    const q = gen(rng);
    // A requirement and something weaker than it: the shape of a near miss.
    return rng.chance(0.6) ? [weaken(rng, q, (r) => genClause(r, pool)), q] : [gen(rng), q];
  }

  it('reports a near miss exactly when the line meets the requirement without implying it', () => {
    const rng = seededRng(0xa2_0001);
    let misses = 0;
    for (let i = 0; i < 6000; i++) {
      const [L, q] = genPair(rng, (r) => genDescription(r, pool));
      const expected = intersects(L, q, ctx.implies) && !implies(L, q, ctx.implies);
      const miss = nearMiss(L, q, ctx);
      same(miss !== null, expected, () => show(L, q));
      if (miss === null) continue;
      misses++;
      same(NEAR_MISS_DIMENSIONS.includes(miss.dimension), true, () => show(L, q));
    }
    expect(misses).toBeGreaterThan(3500);
  });

  it('names a dimension on which strengthening the line ALONE makes progress', () => {
    const rng = seededRng(0xa2_0002);
    let misses = 0;
    let fixed = 0;
    let moved = 0;
    const byDimension = new Map<NearMissDimension, number>();
    for (let i = 0; i < 12_000; i++) {
      const [L, q] = genPair(rng, rng.chance(0.2) ? spellTrap : single);
      if (L.anyOf.length !== 1 || L.anyOf[0]!.t !== 'clause') continue;
      const miss = nearMiss(L, q, ctx);
      if (miss === null) continue;
      misses++;
      byDimension.set(miss.dimension, (byDimension.get(miss.dimension) ?? 0) + 1);

      const stronger: Description = {
        anyOf: [{ t: 'clause', clause: strengthen(clauseOf(L), clauseOf(q), miss.dimension) }],
      };
      // Stronger on that dimension and no other: still a refinement of the line …
      same(implies(stronger, L, ctx.implies), true, () => show(L, q));
      const next = nearMiss(stronger, q, ctx);
      if (next === null) {
        // … which now fills the requirement (it still meets it: only what `q` excludes was cut).
        same(implies(stronger, q, ctx.implies), true, () => `${miss.what}${show(L, q)}`);
        fixed++;
        continue;
      }
      // … or whose first failing dimension comes LATER in the order.
      const before = NEAR_MISS_DIMENSIONS.indexOf(miss.dimension);
      const after = NEAR_MISS_DIMENSIONS.indexOf(next.dimension);
      same(after > before, true, () => `${miss.what} then ${next.what}${show(L, q)}`);
      moved++;
    }
    expect(misses).toBeGreaterThan(2500);
    expect(fixed).toBeGreaterThan(1000);
    expect(moved).toBeGreaterThan(1000);
    // Every dimension a single clause can miss on was exercised.
    for (const dimension of NEAR_MISS_DIMENSIONS.slice(2, -1))
      expect(byDimension.get(dimension) ?? 0, dimension).toBeGreaterThan(100);
  });

  it('suggests only a refinement of the line that fills the requirement — and, on the fixture, exactly their overlap', () => {
    const rng = seededRng(0xa2_0003);
    let misses = 0;
    let suggestions = 0;
    let witnessed = 0;
    for (let i = 0; i < 6000; i++) {
      const [L, q] = genPair(rng, (r) => (r.chance(0.5) ? single(r) : genDescription(r, pool)));
      const miss = nearMiss(L, q, ctx);
      if (miss === null) continue;
      misses++;
      if (miss.suggestion === undefined) continue;
      suggestions++;
      const parsed = parse(miss.suggestion, descCtx);
      if (!parsed.ok) throw new Error(`${miss.suggestion}: ${parsed.message}${show(L, q)}`);
      const context = () => `suggestion: ${miss.suggestion}${show(L, q)}`;
      same(implies(parsed.desc, q, ctx.implies), true, context);
      same(implies(parsed.desc, L, ctx.implies), true, context);
      same(intersects(parsed.desc, UNIVERSE, ctx.implies), true, context);

      // By `evaluate`, which shares nothing with boxes: a fixture card matches the
      // suggestion iff it matches both the line and the requirement.
      const [inL, inQ, inS] = [L, q, parsed.desc].map((desc) => matcher(desc, GROUPS));
      for (const card of cards) {
        const both = inL!(card) && inQ!(card);
        same(inS!(card), both, () => `${card.name}; ${context()}`);
        if (both) witnessed++;
      }
    }
    expect(misses).toBeGreaterThan(3000);
    // Most near misses can be written as one description.
    expect(suggestions / misses).toBeGreaterThan(0.9);
    expect(witnessed).toBeGreaterThan(3000);
  });
});
