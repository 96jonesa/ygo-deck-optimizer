import { describe, expect, it } from 'vitest';
import {
  TYPE_ACTION,
  TYPE_EFFECT,
  TYPE_FUSION,
  TYPE_LINK,
  TYPE_MONSTER,
  TYPE_NORMAL,
  TYPE_PENDULUM,
  TYPE_RITUAL,
  TYPE_SKILL,
  TYPE_SPELL,
  TYPE_SYNCHRO,
  TYPE_TOKEN,
  TYPE_TRAP,
  TYPE_XYZ,
} from '../../../src/core/cards/constants';
import {
  isExtraDeck,
  isMainDeckEligible,
  isMonster,
  isOfficialScope,
  isSpell,
  isToken,
  isTrap,
  matchSetcode,
} from '../../../src/core/cards/record';

describe('isMonster', () => {
  it('tests TYPE_MONSTER only', () => {
    expect(isMonster(TYPE_MONSTER | TYPE_EFFECT)).toBe(true);
    expect(isMonster(TYPE_SPELL)).toBe(false);
    expect(isMonster(TYPE_TRAP)).toBe(false);
  });
});

describe('isSpell', () => {
  it('tests TYPE_SPELL only', () => {
    expect(isSpell(TYPE_SPELL)).toBe(true);
    expect(isSpell(TYPE_MONSTER)).toBe(false);
    expect(isSpell(TYPE_TRAP)).toBe(false);
  });
});

describe('isTrap', () => {
  it('tests TYPE_TRAP only', () => {
    expect(isTrap(TYPE_TRAP)).toBe(true);
    expect(isTrap(TYPE_MONSTER)).toBe(false);
    expect(isTrap(TYPE_SPELL)).toBe(false);
  });
});

describe('isToken', () => {
  it('tests TYPE_TOKEN', () => {
    expect(isToken(TYPE_MONSTER | TYPE_NORMAL | TYPE_TOKEN)).toBe(true);
    expect(isToken(TYPE_MONSTER | TYPE_NORMAL)).toBe(false);
  });
});

describe('isExtraDeck', () => {
  it.each([
    ['Fusion', TYPE_FUSION],
    ['Synchro', TYPE_SYNCHRO],
    ['Xyz', TYPE_XYZ],
    ['Link', TYPE_LINK],
  ])('is true for a %s monster', (_, bit) => {
    expect(isExtraDeck(TYPE_MONSTER | TYPE_EFFECT | bit)).toBe(true);
  });

  it('gates Link on Monster: a Link Spell is not Extra Deck', () => {
    expect(isExtraDeck(TYPE_SPELL | TYPE_LINK)).toBe(false);
  });

  it('does not gate Fusion, Synchro or Xyz on Monster, as the source does not', () => {
    expect(isExtraDeck(TYPE_SPELL | TYPE_FUSION)).toBe(true);
    expect(isExtraDeck(TYPE_TRAP | TYPE_SYNCHRO)).toBe(true);
    expect(isExtraDeck(TYPE_SPELL | TYPE_XYZ)).toBe(true);
  });

  it('is false for Ritual and Pendulum monsters', () => {
    expect(isExtraDeck(TYPE_MONSTER | TYPE_EFFECT | TYPE_RITUAL)).toBe(false);
    expect(isExtraDeck(TYPE_MONSTER | TYPE_EFFECT | TYPE_PENDULUM)).toBe(false);
  });
});

describe('isMainDeckEligible', () => {
  it('accepts ordinary monsters, spells and traps', () => {
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_NORMAL)).toBe(true);
    expect(isMainDeckEligible(TYPE_SPELL)).toBe(true);
    expect(isMainDeckEligible(TYPE_TRAP)).toBe(true);
  });

  it('accepts Ritual and Pendulum monsters, and a Link Spell', () => {
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_EFFECT | TYPE_RITUAL)).toBe(true);
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_EFFECT | TYPE_PENDULUM)).toBe(true);
    expect(isMainDeckEligible(TYPE_SPELL | TYPE_LINK)).toBe(true);
  });

  it('requires exactly one of Monster, Spell, Trap', () => {
    expect(isMainDeckEligible(0)).toBe(false);
    expect(isMainDeckEligible(TYPE_EFFECT)).toBe(false);
    expect(isMainDeckEligible(TYPE_SPELL | TYPE_TRAP)).toBe(false);
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_TRAP)).toBe(false);
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_SPELL | TYPE_TRAP)).toBe(false);
  });

  it.each([
    ['TOKEN', TYPE_TOKEN],
    ['SKILL', TYPE_SKILL],
    ['ACTION', TYPE_ACTION],
  ])('rejects TYPE_%s', (_, bit) => {
    expect(isMainDeckEligible(TYPE_MONSTER | bit)).toBe(false);
    expect(isMainDeckEligible(TYPE_SPELL | bit)).toBe(false);
  });

  it('rejects Extra Deck monsters, including a Pendulum Xyz', () => {
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_EFFECT | TYPE_FUSION)).toBe(false);
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_EFFECT | TYPE_SYNCHRO)).toBe(false);
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_EFFECT | TYPE_XYZ | TYPE_PENDULUM)).toBe(false);
    expect(isMainDeckEligible(TYPE_MONSTER | TYPE_EFFECT | TYPE_LINK)).toBe(false);
  });
});

describe('isOfficialScope', () => {
  it.each([0x1, 0x2, 0x3])('accepts OCG/TCG scope %#x either way', (ot) => {
    expect(isOfficialScope(ot)).toBe(true);
    expect(isOfficialScope(ot, false)).toBe(true);
  });

  it.each([0x100, 0x101, 0x102, 0x103])('accepts pre-release scope %#x by default', (ot) => {
    expect(isOfficialScope(ot)).toBe(true);
    expect(isOfficialScope(ot, true)).toBe(true);
  });

  it.each([0x100, 0x101, 0x102, 0x103])('rejects pre-release scope %#x when excluded', (ot) => {
    expect(isOfficialScope(ot, false)).toBe(false);
  });

  it('rejects scope 0', () => {
    expect(isOfficialScope(0)).toBe(false);
    expect(isOfficialScope(0, false)).toBe(false);
  });

  it.each([
    ['anime', 0x4],
    ['illegal', 0x8],
    ['video game', 0x10],
    ['custom', 0x20],
    ['speed', 0x40],
    ['rush', 0x200],
    ['rush legend', 0x600],
    ['hidden', 0x1000],
  ])('rejects %s scope', (_, ot) => {
    expect(isOfficialScope(ot)).toBe(false);
  });

  it('rejects an official flag combined with an unofficial one', () => {
    expect(isOfficialScope(0x3 | 0x4)).toBe(false);
    expect(isOfficialScope(0x1 | 0x40)).toBe(false);
    expect(isOfficialScope(0x3 | 0x1000)).toBe(false);
  });
});

describe('matchSetcode', () => {
  // 0x1066 and 0x2066 are sub-archetypes of 0x066; 0x3066 carries both nibble bits.
  it('matches a code against itself', () => {
    for (const code of [0x66, 0x1066, 0x2066, 0x3066]) expect(matchSetcode(code, code)).toBe(true);
  });

  it('matches the base archetype query against every sub-archetype card', () => {
    for (const card of [0x1066, 0x2066, 0x3066]) expect(matchSetcode(0x66, card)).toBe(true);
  });

  it('matches a sub-archetype query against a card carrying a superset nibble', () => {
    expect(matchSetcode(0x1066, 0x3066)).toBe(true);
    expect(matchSetcode(0x2066, 0x3066)).toBe(true);
  });

  it('takes the query first: 0x3066 does not match a 0x1066 or 0x2066 card', () => {
    expect(matchSetcode(0x3066, 0x1066)).toBe(false);
    expect(matchSetcode(0x3066, 0x2066)).toBe(false);
  });

  it('does not match sibling sub-archetypes', () => {
    expect(matchSetcode(0x1066, 0x2066)).toBe(false);
    expect(matchSetcode(0x2066, 0x1066)).toBe(false);
  });

  it('does not match a sub-archetype query against the bare archetype card', () => {
    expect(matchSetcode(0x1066, 0x66)).toBe(false);
  });

  it('requires the low 12 bits to be equal, not merely a superset', () => {
    expect(matchSetcode(0x064, 0x066)).toBe(false);
    expect(matchSetcode(0x1064, 0x1066)).toBe(false);
  });

  it('handles a high nibble with bit 15 set', () => {
    expect(matchSetcode(0x8fed, 0x8fed)).toBe(true);
    expect(matchSetcode(0x8fed, 0xffed)).toBe(true);
    expect(matchSetcode(0xffed, 0x8fed)).toBe(false);
  });
});
