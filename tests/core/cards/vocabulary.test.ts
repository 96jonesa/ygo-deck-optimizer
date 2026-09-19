import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_DIVINE,
  ATTRIBUTES,
  OFFICIAL_RACES,
  RACE_BEASTWARRIOR,
  RACE_CREATORGOD,
  RACE_CYBORG,
  RACE_DIVINE,
  RACE_ILLUSION,
  RACE_SEASERPENT,
  RACE_WARRIOR,
  RACE_WINGEDBEAST,
} from '../../../src/core/cards/constants';
import {
  ATTRIBUTE_VOCABULARY,
  attributeFromName,
  attributeName,
  RACE_VOCABULARY,
  raceFromName,
  raceName,
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

it('no race spelling collides with an attribute spelling', () => {
  const all = [...spellings(RACE_VOCABULARY), ...spellings(ATTRIBUTE_VOCABULARY)];
  expect(new Set(all).size).toBe(all.length);
});
