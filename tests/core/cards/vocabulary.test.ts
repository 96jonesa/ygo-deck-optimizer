import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_DIVINE,
  ATTRIBUTES,
  CORE_TYPES,
  OFFICIAL_RACES,
  RACE_BEASTWARRIOR,
  RACE_CREATORGOD,
  RACE_CYBORG,
  RACE_DIVINE,
  RACE_ILLUSION,
  RACE_SEASERPENT,
  RACE_WARRIOR,
  RACE_WINGEDBEAST,
  TYPE_CONTINUOUS,
  TYPE_COUNTER,
  TYPE_EQUIP,
  TYPE_FIELD,
  TYPE_FUSION,
  TYPE_LINK,
  TYPE_MAXIMUM,
  TYPE_MONSTER,
  TYPE_QUICKPLAY,
  TYPE_RITUAL,
  TYPE_SPELL,
  TYPE_SPSUMMON,
  TYPE_SYNCHRO,
  TYPE_TOKEN,
  TYPE_TRAP,
  TYPE_TRAPMONSTER,
  TYPE_TUNER,
  TYPE_XYZ,
} from '../../../src/core/cards/constants';
import {
  ATTRIBUTE_VOCABULARY,
  attributeFromName,
  attributeName,
  KIND_VOCABULARY,
  KINDS,
  kindEntry,
  MONSTER_FLAG_VOCABULARY,
  MONSTER_FLAGS,
  monsterFlagEntry,
  RACE_VOCABULARY,
  raceFromName,
  raceName,
  ST_SUBKIND_BITS,
  ST_SUBKIND_VOCABULARY,
  ST_SUBKINDS,
  stSubkindEntry,
  type VocabularyEntry,
} from '../../../src/core/cards/vocabulary';
import { normalize } from '../../../src/core/util/normalize';

function spellings(table: readonly VocabularyEntry[]): string[] {
  return table.flatMap((entry) => [entry.name, ...entry.synonyms]).map(normalize);
}

function expectTotalOver(table: readonly VocabularyEntry[], bits: number[]) {
  for (const bit of bits) expect(table.filter((entry) => entry.bit === bit)).toHaveLength(1);
  expect(table).toHaveLength(bits.length);
}

describe('RACE_VOCABULARY', () => {
  it('gives every official race exactly one canonical name', () => {
    expectTotalOver(RACE_VOCABULARY, Object.values(OFFICIAL_RACES));
    expect(RACE_VOCABULARY).toHaveLength(26);
  });

  it('names no Rush or unofficial race', () => {
    expect(RACE_VOCABULARY.some((entry) => entry.bit === RACE_CYBORG)).toBe(false);
  });

  it('lists the races in bit order', () => {
    expect(RACE_VOCABULARY.map((entry) => entry.bit)).toEqual(Object.values(OFFICIAL_RACES));
  });

  it('spells the multi-word Types as English cards print them', () => {
    expect(raceName(RACE_BEASTWARRIOR)).toBe('Beast-Warrior');
    expect(raceName(RACE_WINGEDBEAST)).toBe('Winged Beast');
    expect(raceName(RACE_SEASERPENT)).toBe('Sea Serpent');
    expect(raceName(RACE_DIVINE)).toBe('Divine-Beast');
    expect(raceName(RACE_CREATORGOD)).toBe('Creator God');
  });

  it('has no two names or synonyms that normalize to the same string', () => {
    const all = spellings(RACE_VOCABULARY);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('ATTRIBUTE_VOCABULARY', () => {
  it('gives every attribute exactly one canonical name', () => {
    expectTotalOver(ATTRIBUTE_VOCABULARY, Object.values(ATTRIBUTES));
    expect(ATTRIBUTE_VOCABULARY).toHaveLength(7);
  });

  it('names each attribute after its constant', () => {
    for (const [constant, bit] of Object.entries(ATTRIBUTES))
      expect(`ATTRIBUTE_${attributeName(bit)}`).toBe(constant);
  });

  it('has no two names or synonyms that normalize to the same string', () => {
    const all = spellings(ATTRIBUTE_VOCABULARY);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('raceName', () => {
  it('returns the canonical name of an official race bit', () => {
    expect(raceName(RACE_WARRIOR)).toBe('Warrior');
    expect(raceName(RACE_ILLUSION)).toBe('Illusion');
  });

  it('returns undefined for an unofficial race, a mask of several, or zero', () => {
    expect(raceName(RACE_CYBORG)).toBeUndefined();
    expect(raceName(RACE_WARRIOR | RACE_ILLUSION)).toBeUndefined();
    expect(raceName(0)).toBeUndefined();
  });
});

describe('raceFromName', () => {
  it('resolves every canonical name and synonym back to its bit', () => {
    for (const entry of RACE_VOCABULARY)
      for (const spelling of [entry.name, ...entry.synonyms])
        expect(raceFromName(spelling)).toBe(entry.bit);
  });

  it('ignores case, diacritics and outer whitespace', () => {
    expect(raceFromName('  bEaSt-wArRiOr ')).toBe(RACE_BEASTWARRIOR);
    expect(raceFromName('Wýrm')).toBe(raceFromName('Wyrm'));
  });

  it('accepts hyphen, space and joined spellings of the two-word Types', () => {
    for (const spelling of ['beast-warrior', 'beast warrior', 'beastwarrior'])
      expect(raceFromName(spelling)).toBe(RACE_BEASTWARRIOR);
    for (const spelling of ['divine-beast', 'divine beast', 'divinebeast'])
      expect(raceFromName(spelling)).toBe(RACE_DIVINE);
  });

  it('returns undefined for an unknown name, including an attribute', () => {
    expect(raceFromName('Cyborg')).toBeUndefined();
    expect(raceFromName('Divine')).toBeUndefined();
    expect(raceFromName('')).toBeUndefined();
  });
});

describe('attributeName', () => {
  it('returns the canonical upper-case name', () => {
    expect(attributeName(ATTRIBUTE_DARK)).toBe('DARK');
    expect(attributeName(ATTRIBUTE_DIVINE)).toBe('DIVINE');
  });

  it('returns undefined for a mask of several, or zero', () => {
    expect(attributeName(ATTRIBUTE_DARK | ATTRIBUTE_DIVINE)).toBeUndefined();
    expect(attributeName(0)).toBeUndefined();
  });
});

describe('attributeFromName', () => {
  it('resolves every canonical name back to its bit, in any case', () => {
    for (const entry of ATTRIBUTE_VOCABULARY) {
      expect(attributeFromName(entry.name)).toBe(entry.bit);
      expect(attributeFromName(entry.name.toLowerCase())).toBe(entry.bit);
    }
  });

  it('returns undefined for an unknown name, including a race', () => {
    expect(attributeFromName('Divine-Beast')).toBeUndefined();
    expect(attributeFromName('Shadow')).toBeUndefined();
  });
});

describe('KIND_VOCABULARY', () => {
  it('names each kind once, in canonical order, by its TYPE_* bit', () => {
    expect(KIND_VOCABULARY.map((entry) => entry.kind)).toEqual([...KINDS]);
    expect(KIND_VOCABULARY.map((entry) => entry.bit)).toEqual([
      TYPE_MONSTER,
      TYPE_SPELL,
      TYPE_TRAP,
    ]);
    expect(KIND_VOCABULARY.map((entry) => entry.name)).toEqual(['Monster', 'Spell', 'Trap']);
  });
});

describe('MONSTER_FLAG_VOCABULARY', () => {
  it('gives every monster flag exactly one entry, in canonical order', () => {
    expect(MONSTER_FLAG_VOCABULARY.map((entry) => entry.flag)).toEqual([...MONSTER_FLAGS]);
    expect(MONSTER_FLAGS).toHaveLength(10);
  });

  it('maps each flag to the TYPE_* constant of the same name', () => {
    for (const entry of MONSTER_FLAG_VOCABULARY) {
      const constant = `TYPE_${entry.flag.toUpperCase()}` as keyof typeof CORE_TYPES;
      expect(entry.bit, entry.flag).toBe(CORE_TYPES[constant]);
      expect(entry.name.toLowerCase()).toBe(entry.flag);
    }
  });

  it('pins a literal, so that a drifted constant cannot hide behind its name', () => {
    expect(monsterFlagEntry('tuner').bit).toBe(0x1000);
    expect(monsterFlagEntry('toon').bit).toBe(0x400000);
  });
});

describe('ST_SUBKIND_VOCABULARY', () => {
  it('gives every sub-kind exactly one entry, in canonical order', () => {
    expect(ST_SUBKIND_VOCABULARY.map((entry) => entry.subkind)).toEqual([...ST_SUBKINDS]);
    expect(ST_SUBKINDS).toHaveLength(7);
  });

  it('maps each sub-kind to its TYPE_* bit, and "normal" to none', () => {
    expect(Object.fromEntries(ST_SUBKIND_VOCABULARY.map((e) => [e.subkind, e.bit]))).toEqual({
      normal: 0,
      'quick-play': TYPE_QUICKPLAY,
      continuous: TYPE_CONTINUOUS,
      equip: TYPE_EQUIP,
      field: TYPE_FIELD,
      ritual: TYPE_RITUAL,
      counter: TYPE_COUNTER,
    });
  });

  it('says which kinds each sub-kind exists for', () => {
    const spellOnly = ['quick-play', 'equip', 'field', 'ritual'];
    for (const entry of ST_SUBKIND_VOCABULARY) {
      const expected = spellOnly.includes(entry.subkind)
        ? ['spell']
        : entry.subkind === 'counter'
          ? ['trap']
          : ['spell', 'trap'];
      expect(entry.kinds, entry.subkind).toEqual(expected);
    }
  });

  it('spells quick-play with a hyphen, a space, or neither', () => {
    const entry = stSubkindEntry('quick-play');
    expect([entry.name, ...entry.synonyms]).toEqual(['Quick-Play', 'Quick Play', 'QuickPlay']);
  });
});

describe('ST_SUBKIND_BITS', () => {
  it('is exactly the bits the sub-kind vocabulary names', () => {
    const named = ST_SUBKIND_VOCABULARY.reduce((all, entry) => all | entry.bit, 0);
    expect(ST_SUBKIND_BITS).toBe(named);
    expect(ST_SUBKIND_BITS).toBe(0x1f0080);
  });
});

describe('kindEntry', () => {
  it('returns the entry of each kind', () => {
    for (const kind of KINDS) expect(kindEntry(kind).kind).toBe(kind);
    expect(kindEntry('trap').bit).toBe(TYPE_TRAP);
  });
});

describe('monsterFlagEntry', () => {
  it('returns the entry of each flag', () => {
    for (const flag of MONSTER_FLAGS) expect(monsterFlagEntry(flag).flag).toBe(flag);
    expect(monsterFlagEntry('tuner').bit).toBe(TYPE_TUNER);
  });
});

describe('stSubkindEntry', () => {
  it('returns the entry of each sub-kind', () => {
    for (const subkind of ST_SUBKINDS) expect(stSubkindEntry(subkind).subkind).toBe(subkind);
    expect(stSubkindEntry('counter').bit).toBe(TYPE_COUNTER);
  });
});

// Totality over TYPE_*: a new core type must be given a meaning or an excuse.
it('every core TYPE_* bit is a kind, a monster flag, a sub-kind, or deliberately outside the language', () => {
  const outside = [
    // Extra Deck, outside the population (TDD §5.1).
    TYPE_FUSION,
    TYPE_SYNCHRO,
    TYPE_XYZ,
    TYPE_LINK,
    // Not Main Deck cards, or not a property a player describes cards by.
    TYPE_TOKEN,
    TYPE_TRAPMONSTER,
    TYPE_MAXIMUM,
    TYPE_SPSUMMON,
  ];
  const named = [...KIND_VOCABULARY, ...MONSTER_FLAG_VOCABULARY, ...ST_SUBKIND_VOCABULARY]
    .map((entry) => entry.bit)
    .filter((bit) => bit !== 0);
  // TYPE_RITUAL is both a monster flag and a Spell sub-kind; nothing else is shared.
  expect(named.filter((bit, i) => named.indexOf(bit) !== i)).toEqual([TYPE_RITUAL]);
  expect([...new Set([...named, ...outside])].sort((a, b) => a - b)).toEqual(
    Object.values(CORE_TYPES).sort((a, b) => a - b),
  );
  expect(named.filter((bit) => outside.includes(bit))).toEqual([]);
});

it('no race spelling collides with an attribute spelling', () => {
  const all = [...spellings(RACE_VOCABULARY), ...spellings(ATTRIBUTE_VOCABULARY)];
  expect(new Set(all).size).toBe(all.length);
});
