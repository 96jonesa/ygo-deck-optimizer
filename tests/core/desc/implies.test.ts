import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../../src/core/cards/index';
import { RACE_VOCABULARY } from '../../../src/core/cards/vocabulary';
import type { Description } from '../../../src/core/desc/ast';
import { type Groups, matcher } from '../../../src/core/desc/evaluate';
import { type ImpliesContext, implies, intersects, UNIVERSE } from '../../../src/core/desc/implies';
import { parse } from '../../../src/core/desc/parser';
import { same } from '../../helpers/assert';
import { contextOf, FakeGroups } from '../../helpers/desc-context';
import { buildCdb, CODE, FIXTURE_ROWS, POPULATION } from '../../helpers/fixture-cards';
import { type GenPool, genClause, genDescription } from '../../helpers/gen-desc';
import {
  genReducedClause,
  genReducedDescription,
  type MonsterField,
  REDUCED_SETCODES,
  semanticImplies,
  semanticSatisfiable,
  universeFor,
  weaken,
} from '../../helpers/implies-oracle';
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
const parseCtx = contextOf(fixture, {
  groups: new FakeGroups([
    ['g-starters', 'Starters'],
    ['g-lights', 'Lights'],
    ['g-empty', 'Empty'],
    ['g-broken', 'Broken'],
    ['g-undefined', 'Undefined'],
  ]),
});
const ctx: ImpliesContext = { cards: fixture, groups: GROUPS };
/** For descriptions with no card or group in them: nothing to look up. */
const NO_CARDS: ImpliesContext = { cards: { get: () => undefined }, groups: new Map() };

/** The parser rejects a passcode no card has, so this one is written as an AST. */
const UNKNOWN_CARD: Description = { anyOf: [{ t: 'card', passcode: UNKNOWN_PASSCODE }] };

/** `a or b or …`, for the descriptions that cannot be written as one text. */
function or(...descs: Description[]): Description {
  return { anyOf: descs.flatMap((desc) => desc.anyOf) };
}

function d(text: string): Description {
  const result = parse(text, parseCtx);
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.desc;
}

function expectImplies(L: string, q: string) {
  expect(implies(d(L), d(q), ctx), `${L}  ⇒  ${q}`).toBe(true);
}

function expectNotImplies(L: string, q: string) {
  expect(implies(d(L), d(q), ctx), `${L}  ⇏  ${q}`).toBe(false);
}

const ALL_TYPES_BUT_WARRIOR = RACE_VOCABULARY.map((entry) => entry.name)
  .filter((name) => name !== 'Warrior')
  .join('/');

describe('implies', () => {
  describe('must imply', () => {
    it('drops constraints: level 4 FIRE monster ⇒ monster', () => {
      expectImplies('level 4 FIRE monster', 'monster');
    });

    it('drops one constraint: level 4 FIRE monster ⇒ FIRE monster', () => {
      expectImplies('level 4 FIRE monster', 'FIRE monster');
    });

    it('widens a Level: level 4 FIRE monster ⇒ level 4 or lower monster', () => {
      expectImplies('level 4 FIRE monster', 'level 4 or lower monster');
    });

    it('axiom 1: anything with a Level is a monster', () => {
      expectImplies('level 4', 'monster');
    });

    it('axiom 1: a required flag makes a monster', () => {
      expectImplies('tuner', 'monster');
    });

    it('axiom 1: ATK, DEF, an Attribute and a Type each make a monster', () => {
      expectImplies('ATK 1500 or less', 'monster');
      expectImplies('DEF ?', 'monster');
      expectImplies('FIRE', 'monster');
      expectImplies('Warrior/Dragon', 'monster');
    });

    it('axiom 2: spell ⇒ non-tuner', () => {
      expectImplies('spell', 'non-tuner');
    });

    it('axiom 2: trap ⇒ non-FIRE, and ⇒ non-Warrior', () => {
      expectImplies('trap', 'non-FIRE');
      expectImplies('trap', 'non-Warrior');
    });

    it('axiom 3: quick-play ⇒ spell', () => {
      expectImplies('quick-play', 'spell');
    });

    it('axiom 3: counter ⇒ trap', () => {
      expectImplies('counter', 'trap');
    });

    it('axiom 3: continuous ⇒ spell/trap', () => {
      expectImplies('continuous', 'spell/trap');
    });

    // The parser always writes the kinds beside a sub-kind; an AST need not, and then
    // axiom 3 alone keeps the monsters out.
    it('axiom 3, on an AST with no kinds or with broader ones than the sub-kind has', () => {
      const bare: Description = {
        anyOf: [{ t: 'clause', clause: { stSubkinds: ['continuous'] } }],
      };
      const broad: Description = {
        anyOf: [
          { t: 'clause', clause: { kinds: ['monster', 'spell'], stSubkinds: ['continuous'] } },
        ],
      };
      expect(implies(bare, d('spell/trap'), ctx)).toBe(true);
      expect(implies(d('continuous'), bare, ctx)).toBe(true);
      expect(implies(broad, d('continuous spell'), ctx)).toBe(true);
      expect(implies(d('continuous spell'), broad, ctx)).toBe(true);
      expect(implies(d('monster'), broad, ctx)).toBe(false);
    });

    it('continuous spell ⇒ continuous', () => {
      expectImplies('continuous spell', 'continuous');
    });

    it('widens a sub-kind list: field spell ⇒ field/equip spell', () => {
      expectImplies('field spell', 'field/equip spell');
    });

    it('splits a sub-kind across kinds: continuous ⇒ continuous spell or continuous trap', () => {
      expectImplies('continuous', 'continuous spell or continuous trap');
    });

    it('covers a kind with its sub-kinds: trap ⇒ normal/continuous/counter trap', () => {
      expectImplies('trap', 'normal/continuous/counter trap');
    });

    it('splits a range: level 1-6 monster ⇒ level 1-3 monster or level 4-6 monster', () => {
      expectImplies('level 1-6 monster', 'level 1-3 monster or level 4-6 monster');
    });

    it('splits a range across overlapping alternatives', () => {
      expectImplies('ATK 1000-3000', 'ATK 2000 or less or ATK 1500 or more');
    });

    it('ATK 1000-2000 ⇒ ATK 500 or more', () => {
      expectImplies('ATK 1000-2000', 'ATK 500 or more');
    });

    it('DEF 2000 ⇒ DEF 1000-2000', () => {
      expectImplies('DEF 2000', 'DEF 1000-2000');
    });

    it('ATK ? ⇒ ATK ?, and ⇒ monster', () => {
      expectImplies('ATK ?', 'ATK ?');
      expectImplies('ATK ?', 'monster');
    });

    it('covers the ATK domain: monster ⇒ ATK ? or ATK 0 or more', () => {
      expectImplies('monster', 'ATK ? or ATK 0 or more');
    });

    it('axiom 4: "Magnet Warrior":0x3066 card ⇒ "Magnet":0x1066 card', () => {
      expectImplies('"Magnet Warrior":0x3066 card', '"Magnet":0x1066 card');
    });

    it('axiom 4: a sub-archetype implies its base archetype', () => {
      expectImplies('"Magnet Warrior":0x3066 card', '"Warrior":0x66 card');
      expectImplies('"Magnet":0x1066 monster', '"Warrior":0x66 card');
    });

    it('drops one of two archetypes', () => {
      expectImplies('"Sky Striker" "Blue-Eyes" spell', '"Blue-Eyes" card');
    });

    it('FIRE/WATER monster ⇒ non-EARTH monster', () => {
      expectImplies('FIRE/WATER monster', 'non-EARTH monster');
    });

    it('widens a value list: Warrior ⇒ Warrior/Dragon', () => {
      expectImplies('Warrior', 'Warrior/Dragon');
    });

    it('narrows a negated list: non-Warrior/Dragon ⇒ non-Warrior', () => {
      expectImplies('non-Warrior/Dragon', 'non-Warrior');
    });

    it('splits a flag: level 4 monster ⇒ level 4 tuner or level 4 non-tuner monster', () => {
      expectImplies('level 4 monster', 'level 4 tuner or level 4 non-tuner monster');
    });

    it('splits an Attribute: monster ⇒ FIRE monster or non-FIRE monster', () => {
      expectImplies('monster', 'FIRE monster or non-FIRE monster');
    });

    it('drops a flag: effect tuner monster ⇒ tuner', () => {
      expectImplies('effect tuner monster', 'tuner');
    });

    it('level 4 monster or spell ⇒ card', () => {
      expectImplies('level 4 monster or spell', 'card');
    });

    it('splits the kinds: card ⇒ monster or spell or trap', () => {
      expectImplies('card', 'monster or spell or trap');
    });

    it('spell/trap ⇒ non-tuner non-FIRE', () => {
      expectImplies('spell/trap', 'non-tuner non-FIRE');
    });

    it('lets an unsatisfiable L imply anything', () => {
      expectImplies('level 4 spell', 'ATK ? trap');
      expectImplies('level 4 spell', `#${CODE.tunerFairy}`);
    });

    it('lets anything imply card', () => {
      for (const text of ['level 4 monster', 'non-tuner', 'counter', '"Sky Striker"', 'ATK ?'])
        expectImplies(text, 'card');
    });
  });

  describe('must not imply', () => {
    it('monster ⇏ level 4 or lower monster — the one the product exists for', () => {
      expectNotImplies('monster', 'level 4 or lower monster');
    });

    it('monster ⇏ effect monster', () => {
      expectNotImplies('monster', 'effect monster');
    });

    it('level 4 monster ⇏ level 4 FIRE monster', () => {
      expectNotImplies('level 4 monster', 'level 4 FIRE monster');
    });

    it('non-tuner ⇏ monster', () => {
      expectNotImplies('non-tuner', 'monster');
    });

    it('monster ⇏ non-tuner', () => {
      expectNotImplies('monster', 'non-tuner');
    });

    it('"Magnet":0x1066 card ⇏ "Magnet Warrior":0x3066 card — refinement is one-way', () => {
      expectNotImplies('"Magnet":0x1066 card', '"Magnet Warrior":0x3066 card');
    });

    it('both halves of a sub-archetype mask ⇏ the mask: a card may carry them as two codes', () => {
      expectNotImplies('"Magnet":0x1066 "Warrior":0x2066 card', '"Magnet Warrior":0x3066 card');
    });

    it('a base archetype ⇏ its sub-archetype, nor an unrelated one', () => {
      expectNotImplies('"Warrior":0x66 card', '"Magnet":0x1066 card');
      expectNotImplies('"Warrior":0x66 card', '"Sky Striker" card');
    });

    it('ATK 1500 or less ⇏ ATK ?', () => {
      expectNotImplies('ATK 1500 or less', 'ATK ?');
    });

    it('monster ⇏ ATK 0 or more, because of "?"', () => {
      expectNotImplies('monster', 'ATK 0 or more');
    });

    it('ATK ? ⇏ ATK 0 or more', () => {
      expectNotImplies('ATK ?', 'ATK 0 or more');
    });

    it('ATK 1000-2000 ⇏ ATK 1001 or more, nor ATK 1999 or less', () => {
      expectNotImplies('ATK 1000-2000', 'ATK 1001 or more');
      expectNotImplies('ATK 1000-2000', 'ATK 1999 or less');
    });

    it('ATK says nothing about DEF', () => {
      expectNotImplies('ATK 1000', 'DEF 1000');
    });

    it('leaves a gap: level 1-6 monster ⇏ level 1-3 monster or level 5-6 monster', () => {
      expectNotImplies('level 1-6 monster', 'level 1-3 monster or level 5-6 monster');
    });

    it('non-FIRE monster ⇏ every other Attribute: a monster may have none', () => {
      expectNotImplies('non-FIRE monster', 'EARTH/WATER/WIND/LIGHT/DARK/DIVINE monster');
    });

    it('non-Warrior monster ⇏ every other Type: a monster may have an unofficial one', () => {
      expectNotImplies('non-Warrior monster', `${ALL_TYPES_BUT_WARRIOR} monster`);
    });

    it('monster ⇏ level 0 or higher monster: a Level may lie outside the vocabulary', () => {
      expectNotImplies('monster', 'level 0 or higher monster');
    });

    it('claims no exclusivity between flags: normal monster ⇏ non-effect monster', () => {
      expectNotImplies('normal monster', 'non-effect monster');
    });

    it('card ⇏ monster', () => {
      expectNotImplies('card', 'monster');
    });

    it('spell/trap ⇏ spell', () => {
      expectNotImplies('spell/trap', 'spell');
    });

    it('continuous ⇏ spell', () => {
      expectNotImplies('continuous', 'spell');
    });

    it('spell ⇏ quick-play', () => {
      expectNotImplies('spell', 'quick-play');
    });

    it('needs every alternative of L: level 4 monster or spell ⇏ monster', () => {
      expectNotImplies('level 4 monster or spell', 'monster');
    });

    it('never lets a generic clause imply a card, even one that satisfies it', () => {
      expectNotImplies('level 3 LIGHT Fairy tuner monster', `#${CODE.tunerFairy}`);
      expectNotImplies('monster', `#${CODE.tunerFairy}`);
    });

    it('never lets a generic clause imply a group', () => {
      expectNotImplies('level 3 LIGHT Fairy tuner monster', '{Starters}');
    });

    it('still reaches the clause alternatives of a description that also names cards', () => {
      expectImplies('level 4 monster', `#${CODE.tunerFairy} or monster`);
      expectNotImplies('level 4 monster', `#${CODE.tunerFairy} or spell`);
    });
  });

  describe('cards and groups as L', () => {
    it('lets a card imply whatever its record satisfies', () => {
      expectImplies(`#${CODE.tunerFairy}`, 'level 3 LIGHT Fairy tuner monster');
      expectImplies(`#${CODE.tunerFairy}`, 'ATK 0 DEF 1500 or more');
      expectNotImplies(`#${CODE.tunerFairy}`, 'level 4 monster');
      expectNotImplies(`#${CODE.tunerFairy}`, 'spell');
    });

    it('lets a card imply its own passcode, and not another', () => {
      expectImplies(`#${CODE.tunerFairy}`, `#${CODE.tunerFairy}`);
      expectNotImplies(`#${CODE.tunerFairy}`, `#${CODE.vanillaDragon}`);
    });

    it('lets a card imply a group containing it, and not one without it', () => {
      expectImplies(`#${CODE.tunerFairy}`, '{Starters}');
      expectNotImplies(`#${CODE.vanillaDragon}`, '{Starters}');
      expectNotImplies(`#${CODE.tunerFairy}`, '{Empty}');
    });

    it('matches archetypes through the record setcodes, by the set-card rule', () => {
      // fourSetcodes carries 0xdd, 0x1066, 0x2066 and 0x8fed.
      expectImplies(`#${CODE.fourSetcodes}`, '"Magnet":0x1066 "Warrior":0x2066 card');
      expectImplies(`#${CODE.fourSetcodes}`, '"Warrior":0x66 card');
      expectNotImplies(`#${CODE.fourSetcodes}`, '"Magnet Warrior":0x3066 card');
    });

    it('lets a card imply any one alternative of q', () => {
      expectImplies(`#${CODE.tunerFairy}`, `#${CODE.vanillaDragon} or tuner monster`);
      expectNotImplies(`#${CODE.tunerFairy}`, `#${CODE.vanillaDragon} or spell`);
    });

    // Of a passcode missing from the index nothing is known but the passcode.
    it('lets an unknown passcode imply itself', () => {
      expect(implies(UNKNOWN_CARD, UNKNOWN_CARD, ctx)).toBe(true);
      expect(implies(UNKNOWN_CARD, or(d('spell'), UNKNOWN_CARD), ctx)).toBe(true);
    });

    it('lets an unknown passcode imply a group that holds it, and no other', () => {
      expect(implies(UNKNOWN_CARD, d('{Broken}'), ctx)).toBe(true);
      expect(implies(UNKNOWN_CARD, d('{Starters}'), ctx)).toBe(false);
      expect(implies(UNKNOWN_CARD, d('{Empty}'), ctx)).toBe(false);
      expect(implies(UNKNOWN_CARD, d('{Undefined}'), ctx)).toBe(false);
    });

    it('lets an unknown passcode imply the whole universe, however it is written', () => {
      expect(implies(UNKNOWN_CARD, d('card'), ctx)).toBe(true);
      expect(implies(UNKNOWN_CARD, d('monster or spell/trap'), ctx)).toBe(true);
      expect(implies(UNKNOWN_CARD, d('tuner or non-tuner'), ctx)).toBe(true);
    });

    it('lets an unknown passcode imply no clause short of the universe, and no other card', () => {
      expect(implies(UNKNOWN_CARD, d('monster'), ctx)).toBe(false);
      expect(implies(UNKNOWN_CARD, d('non-tuner'), ctx)).toBe(false);
      expect(implies(UNKNOWN_CARD, d('monster or spell'), ctx)).toBe(false);
      expect(implies(UNKNOWN_CARD, d(`#${CODE.tunerFairy}`), ctx)).toBe(false);
      expect(implies(UNKNOWN_CARD, d(`#${CODE.tunerFairy} or monster`), ctx)).toBe(false);
    });

    it('lets a group imply q iff every member does', () => {
      expectImplies('{Lights}', 'LIGHT monster');
      expectNotImplies('{Lights}', 'tuner monster');
      expectImplies('{Starters}', 'LIGHT monster or spell');
      expectNotImplies('{Starters}', 'monster');
    });

    it('lets a group imply itself, and a description naming each member', () => {
      expectImplies('{Starters}', '{Starters}');
      expectImplies('{Starters}', `#${CODE.tunerFairy} or #${CODE.quickSpell}`);
      expectNotImplies('{Starters}', `#${CODE.tunerFairy}`);
    });

    // {Broken} holds tunerFairy, which is judged by its record, and an unknown passcode.
    it('lets a group with a member missing from the index imply itself and the universe', () => {
      expectImplies('{Broken}', '{Broken}');
      expectImplies('{Broken}', 'card');
    });

    it('needs the missing member named by q and the known members to satisfy q', () => {
      expect(implies(d('{Broken}'), or(d('tuner monster'), UNKNOWN_CARD), ctx)).toBe(true);
      expect(implies(d('{Broken}'), or(d(`#${CODE.tunerFairy}`), UNKNOWN_CARD), ctx)).toBe(true);
      expectNotImplies('{Broken}', 'tuner monster');
      expect(implies(d('{Broken}'), UNKNOWN_CARD, ctx)).toBe(false);
      expect(implies(d('{Broken}'), or(d('spell'), UNKNOWN_CARD), ctx)).toBe(false);
    });

    it('lets an empty group imply anything, vacuously', () => {
      expectImplies('{Empty}', 'level 4 spell');
      expectImplies('{Empty}', `#${CODE.tunerFairy}`);
    });

    it('treats a group the map does not hold as empty, as evaluate does', () => {
      expectImplies('{Undefined}', 'level 4 spell');
    });

    it('needs every alternative of a mixed L to imply q', () => {
      expectImplies(`#${CODE.tunerFairy} or level 4 monster`, 'monster');
      expectImplies(`#${CODE.tunerFairy} or {Lights} or LIGHT Dragon`, 'LIGHT monster');
      expectNotImplies(`#${CODE.tunerFairy} or spell`, 'monster');
      expectNotImplies(`#${CODE.quickSpell} or level 4 monster`, 'monster');
      expectNotImplies(`{Starters} or level 4 monster`, 'monster');
    });
  });
});

describe('intersects', () => {
  function expectIntersects(L: string, q: string, expected: boolean) {
    expect(intersects(d(L), d(q), ctx), `${L}  ∩  ${q}`).toBe(expected);
    expect(intersects(d(q), d(L), ctx), `${q}  ∩  ${L}`).toBe(expected);
  }

  it('finds the overlap of constraints on different dimensions', () => {
    expectIntersects('level 4 monster', 'FIRE monster', true);
  });

  it('finds none between disjoint values of one dimension', () => {
    expectIntersects('level 4 monster', 'level 5 monster', false);
    expectIntersects('FIRE', 'WATER/EARTH', false);
    expectIntersects('tuner', 'non-tuner monster', false);
  });

  it('finds none between different kinds', () => {
    expectIntersects('monster', 'spell', false);
    expectIntersects('counter', 'spell', false);
    expectIntersects('level 4', 'spell/trap', false);
  });

  it('lets a negative constraint meet a Spell (axiom 2)', () => {
    expectIntersects('non-tuner', 'spell', true);
  });

  it('meets ranges at a shared endpoint and not one past it', () => {
    expectIntersects('ATK 1000-2000', 'ATK 2000 or more', true);
    expectIntersects('ATK 1000-2000', 'ATK 2001 or more', false);
  });

  it('keeps "?" apart from every range', () => {
    expectIntersects('ATK ?', 'ATK 0 or more', false);
    expectIntersects('ATK ?', 'monster', true);
  });

  it('lets any two archetypes meet: a card can carry both codes', () => {
    expectIntersects('"Magnet":0x1066 card', '"Warrior":0x2066 card', true);
    expectIntersects('"Sky Striker" card', '"Blue-Eyes" card', true);
  });

  it('finds no overlap with an unsatisfiable description', () => {
    expectIntersects('level 4 spell', 'card', false);
  });

  it('needs only one pair of alternatives to meet', () => {
    expectIntersects('level 4 monster or spell', 'trap or quick-play', true);
    expectIntersects('level 4 monster or spell', 'trap or level 5 monster', false);
  });

  it('judges a card by its record, on either side', () => {
    expectIntersects(`#${CODE.tunerFairy}`, 'tuner monster', true);
    expectIntersects(`#${CODE.tunerFairy}`, 'spell', false);
    expectIntersects(`#${CODE.tunerFairy}`, `#${CODE.tunerFairy}`, true);
    expectIntersects(`#${CODE.tunerFairy}`, '{Starters}', true);
    expectIntersects(`#${CODE.vanillaDragon}`, '{Starters}', false);
  });

  it('needs only one member of a group to match', () => {
    expectIntersects('{Starters}', 'spell', true);
    expectIntersects('{Starters}', 'trap', false);
    expectIntersects('{Broken}', 'tuner', true);
  });

  it('finds nothing in an empty group', () => {
    expectIntersects('{Empty}', 'card', false);
    expectIntersects('{Empty}', '{Empty}', false);
  });

  it('lets an unknown passcode meet what names it or is the universe, on either side', () => {
    const both = (L: Description, q: Description) => [intersects(L, q, ctx), intersects(q, L, ctx)];
    expect(both(UNKNOWN_CARD, UNKNOWN_CARD)).toEqual([true, true]);
    expect(both(UNKNOWN_CARD, d('{Broken}'))).toEqual([true, true]);
    expect(both(UNKNOWN_CARD, d('card'))).toEqual([true, true]);
    expect(both(UNKNOWN_CARD, d('monster or spell/trap'))).toEqual([true, true]);
    expect(both(UNKNOWN_CARD, or(d('spell'), UNKNOWN_CARD))).toEqual([true, true]);
  });

  it('keeps an unknown passcode apart from every clause short of the universe', () => {
    const both = (L: Description, q: Description) => [intersects(L, q, ctx), intersects(q, L, ctx)];
    expect(both(UNKNOWN_CARD, d('monster'))).toEqual([false, false]);
    expect(both(UNKNOWN_CARD, d('non-tuner'))).toEqual([false, false]);
    expect(both(UNKNOWN_CARD, d(`#${CODE.tunerFairy}`))).toEqual([false, false]);
    expect(both(UNKNOWN_CARD, d('{Starters}'))).toEqual([false, false]);
  });
});

describe('UNIVERSE', () => {
  it('is the description `card`', () => {
    expect(UNIVERSE).toEqual(d('card'));
  });

  it('implies card and monster/spell/trap', () => {
    expect(implies(UNIVERSE, d('card'), ctx)).toBe(true);
    expect(implies(UNIVERSE, d('monster/spell/trap'), ctx)).toBe(true);
    expect(implies(UNIVERSE, d('monster or spell/trap'), ctx)).toBe(true);
  });

  it('does not imply monster, nor anything else short of the universe', () => {
    for (const text of ['monster', 'spell/trap', 'non-tuner', 'monster or spell or counter'])
      expect(implies(UNIVERSE, d(text), ctx), text).toBe(false);
  });

  it('is implied by everything and intersects everything satisfiable', () => {
    const texts = ['monster', 'ATK ?', 'counter', `#${CODE.tunerFairy}`, '{Starters}', '{Broken}'];
    for (const desc of [...texts.map(d), UNKNOWN_CARD]) {
      expect(implies(desc, UNIVERSE, ctx), JSON.stringify(desc)).toBe(true);
      expect(intersects(desc, UNIVERSE, ctx), JSON.stringify(desc)).toBe(true);
    }
  });
});

// --- oracles spanning implies, intersects and the box machinery (TDD §15.1) --------------

function show(L: Description, q: Description): string {
  return `\nL = ${JSON.stringify(L)}\nq = ${JSON.stringify(q)}`;
}

describe('implication against the semantic oracle (O1)', () => {
  /** Bases; each yields three pairs: base ⇒ weakened, weakened ⇒ base, base ⇒ unrelated. */
  const BASES = 10000;

  it(`agrees with brute-force evaluation on ${3 * BASES} pairs, both ways`, () => {
    const rng = seededRng(0x1a9c0001);
    // [pairs, true implications, of which L is satisfiable] per way of building the pair.
    const kinds = { weakened: [0, 0, 0], reversed: [0, 0, 0], unrelated: [0, 0, 0] };
    let cards = 0;
    let largest = 0;
    for (let i = 0; i < BASES; i++) {
      const base = genReducedDescription(rng);
      const weaker = weaken(rng, base, genReducedClause);
      const other = genReducedDescription(rng);
      const pairs = [
        ['weakened', base, weaker],
        ['reversed', weaker, base],
        ['unrelated', base, other],
      ] as const;
      for (const [kind, L, q] of pairs) {
        const verdict = semanticImplies(L, q);
        if (implies(L, q, NO_CARDS) !== verdict.holds)
          throw new Error(
            `case ${i} (${kind}): implies is ${!verdict.holds}, the oracle says ${verdict.holds}` +
              `${show(L, q)}\ncounterexample = ${JSON.stringify(verdict.counterexample)}`,
          );
        kinds[kind][0]! += 1;
        if (verdict.holds) kinds[kind][1]! += 1;
        if (verdict.holds && semanticSatisfiable(L)) kinds[kind][2]! += 1;
        cards += verdict.universeSize;
        largest = Math.max(largest, verdict.universeSize);
      }
    }
    const total = Object.values(kinds).reduce((sum, [n]) => sum + n!, 0);
    const holds = Object.values(kinds).reduce((sum, [, n]) => sum + n!, 0);
    const nonVacuous = Object.values(kinds).reduce((sum, [, , n]) => sum + n!, 0);
    console.info(
      `O1: ${total} pairs, ${holds} true implications (${((100 * holds) / total).toFixed(1)}%),`,
      `${nonVacuous} of them from a satisfiable L;`,
      `[pairs, true, true with L satisfiable]: ${JSON.stringify(kinds)};`,
      `universe mean ${(cards / total).toFixed(0)} cards, largest ${largest}`,
    );
    expect(total).toBeGreaterThanOrEqual(20000);
    // Both verdicts must be well exercised, or agreement means little.
    expect(nonVacuous / total).toBeGreaterThan(0.25);
    expect(holds / total).toBeLessThan(0.75);
    expect(kinds.unrelated[2]).toBeGreaterThan(100);
  });

  it('agrees on satisfiable pairs too: an unsatisfiable L is not what makes them true', () => {
    const rng = seededRng(0x1a9c0002);
    let holds = 0;
    for (let i = 0; i < 1500; i++) {
      const base = genReducedDescription(rng);
      if (!semanticSatisfiable(base)) continue;
      const weaker = weaken(rng, base, genReducedClause);
      const verdict = semanticImplies(base, weaker);
      same(implies(base, weaker, NO_CARDS), verdict.holds, () => show(base, weaker));
      if (verdict.holds) holds++;
    }
    expect(holds).toBeGreaterThan(500);
  });

  it('agrees with brute force on intersects: some card of the universe matches both', () => {
    const rng = seededRng(0x1a9c0003);
    let meets = 0;
    for (let i = 0; i < 4000; i++) {
      const L = genReducedDescription(rng);
      const q = rng.chance(0.5) ? weaken(rng, L, genReducedClause) : genReducedDescription(rng);
      const inL = matcher(L, NO_CARDS.groups);
      const inQ = matcher(q, NO_CARDS.groups);
      const expected = universeFor(L, q).some((card) => inL(card) && inQ(card));
      same(intersects(L, q, NO_CARDS), expected, () => show(L, q));
      if (expected) meets++;
    }
    expect(meets).toBeGreaterThan(1000);
    expect(meets).toBeLessThan(3500);
  });

  // The universe keeps one value per signature in each field. Leaving any one field whole
  // must never change a verdict, or the de-duplication is hiding a cell.
  it('gets the same verdict with any one field of the universe left un-de-duplicated', () => {
    const rng = seededRng(0x1a9c0004);
    const fields: MonsterField[] = ['attribute', 'race', 'level', 'atk', 'def', 'setcodes'];
    for (let i = 0; i < 150; i++) {
      const L = genReducedDescription(rng);
      const q = weaken(rng, L, genReducedClause);
      const expected = semanticImplies(L, q).holds;
      for (const fullDimension of fields)
        same(semanticImplies(L, q, { fullDimension }).holds, expected, () => show(L, q));
    }
  });

  it('builds a universe with every archetype cell of the 0x1066 / 0x2066 / 0x3066 triple', () => {
    const all: Description = {
      anyOf: REDUCED_SETCODES.map((code) => ({ t: 'clause', clause: { archetypes: [code] } })),
    };
    const signatures = new Set(
      universeFor(all, all).map((card) =>
        REDUCED_SETCODES.map((query) =>
          matcher({ anyOf: [{ t: 'clause', clause: { archetypes: [query] } }] }, new Map())(card)
            ? 1
            : 0,
        ).join(''),
      ),
    );
    // Over [0x66, 0x1066, 0x2066, 0x3066]: none, base only, either half, both halves as two
    // codes (the cell a single 0x3066 code does not reach), and the union — each with and
    // without the unrelated 0x99.
    expect([...signatures].sort()).toEqual(
      ['0000', '1000', '1100', '1010', '1110', '1111'].flatMap((s) => [`${s}0`, `${s}1`]).sort(),
    );
  });
});

describe('implication is sound against the fixture database (O2)', () => {
  const pool: GenPool = {
    passcodes: [...POPULATION, UNKNOWN_PASSCODE],
    groupIds: [...GROUPS.keys(), 'g-undefined'],
    setcodes: [0x66, 0x1066, 0x2066, 0x3066, 0xdd, 0x64, 0x93, 0xabc, 0x1234, 0xcf, 0x10cf, 0x9999],
  };
  const cards = [...fixture.all()];

  function genPair(rng: Rng): [Description, Description] {
    const L = genDescription(rng, pool);
    const q = rng.chance(0.6)
      ? weaken(rng, L, (r) => genClause(r, pool))
      : genDescription(rng, pool);
    return [L, q];
  }

  it('never claims an implication that a fixture card contradicts, over 6,000 pairs', () => {
    const rng = seededRng(0x1a9c0005);
    let holds = 0;
    let witnessed = 0;
    for (let i = 0; i < 6000; i++) {
      const [L, q] = genPair(rng);
      if (!implies(L, q, ctx)) continue;
      holds++;
      const inL = matcher(L, GROUPS);
      const inQ = matcher(q, GROUPS);
      for (const card of cards) {
        if (!inL(card)) continue;
        witnessed++;
        same(inQ(card), true, () => `${card.name} matches L and not q${show(L, q)}`);
      }
    }
    // Enough true implications, and enough of them about cards the fixture actually holds.
    expect(holds).toBeGreaterThan(1500);
    expect(witnessed).toBeGreaterThan(1500);
  });

  it('never misses an overlap that a fixture card witnesses, over 3,000 pairs', () => {
    const rng = seededRng(0x1a9c0006);
    let witnessed = 0;
    for (let i = 0; i < 3000; i++) {
      const [L, q] = genPair(rng);
      const inL = matcher(L, GROUPS);
      const inQ = matcher(q, GROUPS);
      if (!cards.some((card) => inL(card) && inQ(card))) continue;
      witnessed++;
      same(intersects(L, q, ctx), true, () => show(L, q));
    }
    expect(witnessed).toBeGreaterThan(500);
  });
});

describe('algebraic properties of implies and intersects', () => {
  // Passcodes missing from the index, a group holding one, an empty group and a group the map
  // does not hold are all in the pool: none of them is an exception to any law below.
  const pool: GenPool = {
    passcodes: [...POPULATION, UNKNOWN_PASSCODE, UNKNOWN_PASSCODE + 1],
    groupIds: ['g-starters', 'g-lights', 'g-empty', 'g-broken', 'g-undefined'],
    setcodes: [0x66, 0x1066, 0x2066, 0x3066, 0xdd, 0x64, 0x9999],
  };
  const gen = (rng: Rng) => genDescription(rng, pool);
  const weakened = (rng: Rng, desc: Description) => weaken(rng, desc, (r) => genClause(r, pool));
  const mentionsUnknown = (desc: Description) =>
    desc.anyOf.some(
      (alt) =>
        (alt.t === 'card' && fixture.get(alt.passcode) === undefined) ||
        (alt.t === 'group' && alt.groupId === 'g-broken'),
    );

  it('is reflexive', () => {
    const rng = seededRng(0x1a9c0010);
    let unknown = 0;
    for (let i = 0; i < 2000; i++) {
      const desc = gen(rng);
      same(implies(desc, desc, ctx), true, () => desc);
      if (mentionsUnknown(desc)) unknown++;
    }
    // Including descriptions that name a card the index does not hold.
    expect(unknown).toBeGreaterThan(100);
    const reduced = seededRng(0x1a9c0011);
    for (let i = 0; i < 2000; i++) {
      const desc = genReducedDescription(reduced);
      same(implies(desc, desc, NO_CARDS), true, () => desc);
    }
  });

  it('is transitive, on chains where both premises hold', () => {
    const rng = seededRng(0x1a9c0012);
    let chains = 0;
    for (let i = 0; i < 3000; i++) {
      const a = gen(rng);
      const b = weakened(rng, a);
      const c = weakened(rng, b);
      if (!implies(a, b, ctx) || !implies(b, c, ctx)) continue;
      chains++;
      same(implies(a, c, ctx), true, () => `${show(a, b)}\nc = ${JSON.stringify(c)}`);
    }
    expect(chains).toBeGreaterThan(800);
  });

  it('is monotone in q: implies(L, q1) ⇒ implies(L, q1 or q2)', () => {
    const rng = seededRng(0x1a9c0013);
    let holds = 0;
    for (let i = 0; i < 3000; i++) {
      const L = gen(rng);
      const q1 = weakened(rng, L);
      if (!implies(L, q1, ctx)) continue;
      holds++;
      same(implies(L, or(q1, gen(rng)), ctx), true, () => show(L, q1));
    }
    expect(holds).toBeGreaterThan(1000);
  });

  it('splits over the alternatives of L: implies(L1 or L2, q) ⇔ implies(L1, q) ∧ implies(L2, q)', () => {
    const rng = seededRng(0x1a9c0014);
    const seen = { both: 0, notBoth: 0 };
    for (let i = 0; i < 3000; i++) {
      const L1 = gen(rng);
      const L2 = rng.chance(0.5) ? weakened(rng, L1) : gen(rng);
      const q = rng.chance(0.7) ? weakened(rng, or(L1, L2)) : gen(rng);
      const each = implies(L1, q, ctx) && implies(L2, q, ctx);
      same(implies(or(L1, L2), q, ctx), each, () => `${show(L1, q)}\nL2 = ${JSON.stringify(L2)}`);
      seen[each ? 'both' : 'notBoth']++;
    }
    expect(seen.both).toBeGreaterThan(500);
    expect(seen.notBoth).toBeGreaterThan(500);
  });

  it('makes intersects symmetric', () => {
    const rng = seededRng(0x1a9c0015);
    const seen = { meets: 0, apart: 0 };
    for (let i = 0; i < 3000; i++) {
      const a = gen(rng);
      const b = rng.chance(0.5) ? weakened(rng, a) : gen(rng);
      const meets = intersects(a, b, ctx);
      same(intersects(b, a, ctx), meets, () => show(a, b));
      seen[meets ? 'meets' : 'apart']++;
    }
    expect(seen.meets).toBeGreaterThan(500);
    expect(seen.apart).toBeGreaterThan(500);
  });

  it('makes intersects monotone: what meets q1 meets whatever q1 implies', () => {
    const rng = seededRng(0x1a9c0017);
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const q1 = gen(rng);
      const q2 = weakened(rng, q1);
      const L = rng.chance(0.5) ? weakened(rng, q1) : gen(rng);
      if (!intersects(L, q1, ctx) || !implies(q1, q2, ctx)) continue;
      checked++;
      same(intersects(L, q2, ctx), true, () => `${show(L, q1)}\nq2 = ${JSON.stringify(q2)}`);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('makes a satisfiable L intersect whatever it implies', () => {
    const rng = seededRng(0x1a9c0016);
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const L = gen(rng);
      const q = weakened(rng, L);
      if (!implies(L, q, ctx) || !intersects(L, UNIVERSE, ctx)) continue;
      checked++;
      same(intersects(L, q, ctx), true, () => show(L, q));
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
