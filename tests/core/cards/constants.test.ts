import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DIVINE,
  ATTRIBUTES,
  CLIENT_TYPES,
  CORE_TYPES,
  OFFICIAL_RACE_MASK,
  OFFICIAL_RACES,
  RACE_BEASTWARRIOR,
  RACE_GALAXY,
  RACE_HI_YOKAI,
  RACE_ILLUSION,
  RACE_WARRIOR,
  RACES,
  RACES_HI,
  SCOPE_OCG,
  SCOPE_OFFICIAL,
  SCOPE_PRERELEASE,
  SCOPE_RUSH,
  SCOPE_TCG,
  SCOPES,
  TYPE_ACTION,
  TYPE_LINK,
  TYPE_MONSTER,
  TYPE_SKILL,
} from '../../../src/core/cards/constants';

// The tables are transcribed mechanically from the pinned headers (TDD §15.1).
// These pins exist only to fail if a value drifts: a wrong constant is not
// visibly wrong, it just makes some rule silently never fire.

function isSingleBit(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 2 ** 32 && Math.log2(value) % 1 === 0;
}

const TABLES = { CORE_TYPES, CLIENT_TYPES, ATTRIBUTES, RACES, RACES_HI, SCOPES };

describe('CORE_TYPES', () => {
  it('pins TYPE_MONSTER and TYPE_LINK', () => {
    expect(TYPE_MONSTER).toBe(0x1);
    expect(TYPE_LINK).toBe(0x4000000);
  });

  it('holds the 26 core types', () => {
    expect(Object.keys(CORE_TYPES)).toHaveLength(26);
  });

  it('leaves bit 0x8 unassigned', () => {
    expect(Object.values(CORE_TYPES)).not.toContain(0x8);
  });
});

describe('CLIENT_TYPES', () => {
  it('pins TYPE_SKILL and TYPE_ACTION', () => {
    expect(TYPE_SKILL).toBe(0x8000000);
    expect(TYPE_ACTION).toBe(0x10000000);
  });

  it('holds exactly SKILL and ACTION, clear of every core type', () => {
    expect(Object.keys(CLIENT_TYPES)).toEqual(['TYPE_SKILL', 'TYPE_ACTION']);
    for (const bit of Object.values(CLIENT_TYPES))
      expect(Object.values(CORE_TYPES)).not.toContain(bit);
  });
});

describe('ATTRIBUTES', () => {
  it('pins ATTRIBUTE_DIVINE', () => {
    expect(ATTRIBUTE_DIVINE).toBe(0x40);
  });

  it('holds the 7 attributes on bits 0-6', () => {
    expect(Object.values(ATTRIBUTES)).toEqual([0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40]);
  });
});

describe('RACES', () => {
  it('pins RACE_WARRIOR, RACE_BEASTWARRIOR and RACE_ILLUSION', () => {
    expect(RACE_WARRIOR).toBe(0x1);
    expect(RACE_BEASTWARRIOR).toBe(0x8000);
    expect(RACE_ILLUSION).toBe(0x2000000);
  });

  it('holds all 32 low-half races, one per bit, in bit order', () => {
    expect(Object.values(RACES)).toEqual(Array.from({ length: 32 }, (_, bit) => 2 ** bit));
  });

  it('keeps RACE_GALAXY a positive literal, although & with bit 31 comes out negative', () => {
    expect(RACE_GALAXY).toBe(2147483648);
    // Hence bit tests are written `!== 0`, never `> 0`.
    expect(RACE_GALAXY & RACE_GALAXY).toBeLessThan(0);
  });
});

describe('RACES_HI', () => {
  it('pins RACE_HI_YOKAI as bit 62 of the column, shifted down by 32', () => {
    expect(RACE_HI_YOKAI).toBe(0x40000000);
    expect(BigInt(RACE_HI_YOKAI) << 32n).toBe(0x4000000000000000n);
  });

  it('holds exactly RACE_HI_YOKAI', () => {
    expect(Object.keys(RACES_HI)).toEqual(['RACE_HI_YOKAI']);
  });
});

describe('OFFICIAL_RACES', () => {
  it('holds the 26 official races, RACE_WARRIOR through RACE_ILLUSION', () => {
    const names = Object.keys(OFFICIAL_RACES);
    expect(names).toHaveLength(26);
    expect(names[0]).toBe('RACE_WARRIOR');
    expect(names[25]).toBe('RACE_ILLUSION');
  });

  it('covers OFFICIAL_RACE_MASK exactly', () => {
    const union = Object.values(OFFICIAL_RACES).reduce((mask, bit) => mask | bit, 0);
    expect(union).toBe(OFFICIAL_RACE_MASK);
    expect(OFFICIAL_RACE_MASK).toBe(0x3ffffff);
  });
});

describe('SCOPES', () => {
  it('pins SCOPE_PRERELEASE and SCOPE_RUSH', () => {
    expect(SCOPE_PRERELEASE).toBe(0x100);
    expect(SCOPE_RUSH).toBe(0x200);
  });

  it('holds the 11 scope flags, with the documented gaps at 0x80 and 0x800', () => {
    const values = Object.values(SCOPES);
    expect(values).toHaveLength(11);
    expect(values).not.toContain(0x80);
    expect(values).not.toContain(0x800);
  });
});

describe('SCOPE_OFFICIAL', () => {
  it('is OCG | TCG | PRERELEASE', () => {
    expect(SCOPE_OFFICIAL).toBe(0x103);
    expect(SCOPE_OFFICIAL).toBe(SCOPE_OCG | SCOPE_TCG | SCOPE_PRERELEASE);
  });
});

it.each(Object.entries(TABLES))('%s is a table of distinct single uint32 bits', (_, table) => {
  const values = Object.values(table);
  for (const value of values) expect(isSingleBit(value)).toBe(true);
  expect(new Set(values).size).toBe(values.length);
});
