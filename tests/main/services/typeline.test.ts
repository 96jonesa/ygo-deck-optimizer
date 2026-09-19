import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_LIGHT,
  ATTRIBUTE_WIND,
  RACE_BEASTWARRIOR,
  RACE_DRAGON,
  RACE_FAIRY,
  RACE_SPELLCASTER,
  RACE_WARRIOR,
  TYPE_CONTINUOUS,
  TYPE_COUNTER,
  TYPE_EFFECT,
  TYPE_EQUIP,
  TYPE_FIELD,
  TYPE_FLIP,
  TYPE_MONSTER,
  TYPE_NORMAL,
  TYPE_PENDULUM,
  TYPE_QUICKPLAY,
  TYPE_RITUAL,
  TYPE_SPELL,
  TYPE_SPIRIT,
  TYPE_TRAP,
  TYPE_TUNER,
} from '../../../src/core/cards/constants';
import { typeline } from '../../../src/main/services/typeline';
import { cardRecord } from '../../helpers/desc-context';

function monster(type: number, overrides: Parameters<typeof cardRecord>[0] = {}): string {
  return typeline(cardRecord({ type: TYPE_MONSTER | type, ...overrides }));
}

function spell(type: number): string {
  return typeline(cardRecord({ type: TYPE_SPELL | type, level: 0, race: 0, attribute: 0 }));
}

function trap(type: number): string {
  return typeline(cardRecord({ type: TYPE_TRAP | type, level: 0, race: 0, attribute: 0 }));
}

describe('typeline', () => {
  it('reads a monster as Level · Attribute · Type · flags Monster', () => {
    expect(monster(TYPE_EFFECT, { level: 4, attribute: ATTRIBUTE_WIND, race: RACE_WARRIOR })).toBe(
      'Level 4 · WIND · Warrior · Effect Monster',
    );
    expect(monster(TYPE_NORMAL, { level: 8, attribute: ATTRIBUTE_LIGHT, race: RACE_DRAGON })).toBe(
      'Level 8 · LIGHT · Dragon · Normal Monster',
    );
  });

  it('uses the vocabulary’s canonical names', () => {
    expect(monster(TYPE_EFFECT, { level: 7, race: RACE_BEASTWARRIOR })).toBe(
      'Level 7 · EARTH · Beast-Warrior · Effect Monster',
    );
  });

  it('lists the flags as a card’s type line does: Ritual and Pendulum, abilities, Tuner, then Normal or Effect', () => {
    expect(monster(TYPE_EFFECT | TYPE_TUNER, { level: 3, race: RACE_FAIRY })).toBe(
      'Level 3 · EARTH · Fairy · Tuner Effect Monster',
    );
    expect(monster(TYPE_EFFECT | TYPE_RITUAL)).toBe(
      'Level 4 · EARTH · Warrior · Ritual Effect Monster',
    );
    expect(
      monster(TYPE_NORMAL | TYPE_PENDULUM, { attribute: ATTRIBUTE_DARK, race: RACE_SPELLCASTER }),
    ).toBe('Level 4 · DARK · Spellcaster · Pendulum Normal Monster');
    expect(monster(TYPE_EFFECT | TYPE_TUNER | TYPE_FLIP)).toBe(
      'Level 4 · EARTH · Warrior · Flip Tuner Effect Monster',
    );
    expect(monster(TYPE_EFFECT | TYPE_SPIRIT)).toBe(
      'Level 4 · EARTH · Warrior · Spirit Effect Monster',
    );
  });

  it('says just Monster for one that is neither Normal nor Effect', () => {
    expect(monster(TYPE_RITUAL)).toBe('Level 4 · EARTH · Warrior · Ritual Monster');
    expect(monster(0)).toBe('Level 4 · EARTH · Warrior · Monster');
  });

  it('leaves out an Attribute or Type it has no name for, rather than invent one', () => {
    expect(monster(TYPE_EFFECT, { attribute: 0, race: 0 })).toBe('Level 4 · Effect Monster');
    expect(monster(TYPE_EFFECT, { attribute: ATTRIBUTE_DARK | ATTRIBUTE_LIGHT })).toBe(
      'Level 4 · Warrior · Effect Monster',
    );
  });

  it('names every Spell sub-kind, and Normal when none is set', () => {
    expect(spell(0)).toBe('Normal Spell');
    expect(spell(TYPE_QUICKPLAY)).toBe('Quick-Play Spell');
    expect(spell(TYPE_CONTINUOUS)).toBe('Continuous Spell');
    expect(spell(TYPE_EQUIP)).toBe('Equip Spell');
    expect(spell(TYPE_FIELD)).toBe('Field Spell');
    expect(spell(TYPE_RITUAL)).toBe('Ritual Spell');
  });

  it('names every Trap sub-kind, and Normal when none is set', () => {
    expect(trap(0)).toBe('Normal Trap');
    expect(trap(TYPE_CONTINUOUS)).toBe('Continuous Trap');
    expect(trap(TYPE_COUNTER)).toBe('Counter Trap');
  });

  it('gives a Spell or Trap no Level, Attribute or Type, whatever its row holds', () => {
    expect(typeline(cardRecord({ type: TYPE_SPELL | TYPE_FIELD, level: 4 }))).toBe('Field Spell');
  });

  it('does not read a monster’s Ritual or Normal bit as a Spell sub-kind, nor the reverse', () => {
    expect(monster(TYPE_EFFECT | TYPE_RITUAL)).not.toContain('Spell');
    expect(spell(TYPE_RITUAL)).not.toContain('Monster');
  });
});
