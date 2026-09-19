import { normalize } from '../util/normalize';
import {
  ATTRIBUTE_DARK,
  ATTRIBUTE_DIVINE,
  ATTRIBUTE_EARTH,
  ATTRIBUTE_FIRE,
  ATTRIBUTE_LIGHT,
  ATTRIBUTE_WATER,
  ATTRIBUTE_WIND,
  RACE_AQUA,
  RACE_BEAST,
  RACE_BEASTWARRIOR,
  RACE_CREATORGOD,
  RACE_CYBERSE,
  RACE_DINOSAUR,
  RACE_DIVINE,
  RACE_DRAGON,
  RACE_FAIRY,
  RACE_FIEND,
  RACE_FISH,
  RACE_ILLUSION,
  RACE_INSECT,
  RACE_MACHINE,
  RACE_PLANT,
  RACE_PSYCHIC,
  RACE_PYRO,
  RACE_REPTILE,
  RACE_ROCK,
  RACE_SEASERPENT,
  RACE_SPELLCASTER,
  RACE_THUNDER,
  RACE_WARRIOR,
  RACE_WINGEDBEAST,
  RACE_WYRM,
  RACE_ZOMBIE,
} from './constants';

/**
 * Hand-written English vocabulary beside the transcribed constants (TDD §4.6).
 * Matching is by `normalize`, so case and diacritics never need a synonym;
 * synonyms exist for spellings that differ in hyphens or spaces.
 */
export interface VocabularyEntry {
  /** The `RACE_*` / `ATTRIBUTE_*` bit this entry names. */
  bit: number;
  /** Canonical display name, as printed on English cards. */
  name: string;
  synonyms: readonly string[];
}

/**
 * The 26 official Types (`RACE_WARRIOR` … `RACE_ILLUSION`). Canonical names
 * agree with the client's own `!system 1020+i` strings. Rush and unofficial
 * races (`RACE_CYBORG` onward, `RACE_HI_*`) are outside the population and
 * deliberately have no vocabulary.
 */
export const RACE_VOCABULARY: readonly VocabularyEntry[] = [
  { bit: RACE_WARRIOR, name: 'Warrior', synonyms: [] },
  { bit: RACE_SPELLCASTER, name: 'Spellcaster', synonyms: [] },
  { bit: RACE_FAIRY, name: 'Fairy', synonyms: [] },
  { bit: RACE_FIEND, name: 'Fiend', synonyms: [] },
  { bit: RACE_ZOMBIE, name: 'Zombie', synonyms: [] },
  { bit: RACE_MACHINE, name: 'Machine', synonyms: [] },
  { bit: RACE_AQUA, name: 'Aqua', synonyms: [] },
  { bit: RACE_PYRO, name: 'Pyro', synonyms: [] },
  { bit: RACE_ROCK, name: 'Rock', synonyms: [] },
  { bit: RACE_WINGEDBEAST, name: 'Winged Beast', synonyms: ['Winged-Beast', 'WingedBeast'] },
  { bit: RACE_PLANT, name: 'Plant', synonyms: [] },
  { bit: RACE_INSECT, name: 'Insect', synonyms: [] },
  { bit: RACE_THUNDER, name: 'Thunder', synonyms: [] },
  { bit: RACE_DRAGON, name: 'Dragon', synonyms: [] },
  { bit: RACE_BEAST, name: 'Beast', synonyms: [] },
  { bit: RACE_BEASTWARRIOR, name: 'Beast-Warrior', synonyms: ['Beast Warrior', 'BeastWarrior'] },
  { bit: RACE_DINOSAUR, name: 'Dinosaur', synonyms: [] },
  { bit: RACE_FISH, name: 'Fish', synonyms: [] },
  { bit: RACE_SEASERPENT, name: 'Sea Serpent', synonyms: ['Sea-Serpent', 'SeaSerpent'] },
  { bit: RACE_REPTILE, name: 'Reptile', synonyms: [] },
  { bit: RACE_PSYCHIC, name: 'Psychic', synonyms: [] },
  { bit: RACE_DIVINE, name: 'Divine-Beast', synonyms: ['Divine Beast', 'DivineBeast'] },
  { bit: RACE_CREATORGOD, name: 'Creator God', synonyms: ['Creator-God', 'CreatorGod'] },
  { bit: RACE_WYRM, name: 'Wyrm', synonyms: [] },
  { bit: RACE_CYBERSE, name: 'Cyberse', synonyms: [] },
  { bit: RACE_ILLUSION, name: 'Illusion', synonyms: [] },
];

/** The 7 Attributes, upper-case as printed; agrees with `!system 1010+i`. */
export const ATTRIBUTE_VOCABULARY: readonly VocabularyEntry[] = [
  { bit: ATTRIBUTE_EARTH, name: 'EARTH', synonyms: [] },
  { bit: ATTRIBUTE_WATER, name: 'WATER', synonyms: [] },
  { bit: ATTRIBUTE_FIRE, name: 'FIRE', synonyms: [] },
  { bit: ATTRIBUTE_WIND, name: 'WIND', synonyms: [] },
  { bit: ATTRIBUTE_LIGHT, name: 'LIGHT', synonyms: [] },
  { bit: ATTRIBUTE_DARK, name: 'DARK', synonyms: [] },
  { bit: ATTRIBUTE_DIVINE, name: 'DIVINE', synonyms: [] },
];

function nameOf(table: readonly VocabularyEntry[], bit: number): string | undefined {
  return table.find((entry) => entry.bit === bit)?.name;
}

function bitOf(table: readonly VocabularyEntry[], text: string): number | undefined {
  const key = normalize(text.trim());
  return table.find(
    (entry) => normalize(entry.name) === key || entry.synonyms.some((s) => normalize(s) === key),
  )?.bit;
}

/** Canonical name of a single official `RACE_*` bit. */
export function raceName(bit: number): string | undefined {
  return nameOf(RACE_VOCABULARY, bit);
}

/** The `RACE_*` bit a canonical name or synonym denotes, normalized. */
export function raceFromName(text: string): number | undefined {
  return bitOf(RACE_VOCABULARY, text);
}

/** Canonical name of a single `ATTRIBUTE_*` bit. */
export function attributeName(bit: number): string | undefined {
  return nameOf(ATTRIBUTE_VOCABULARY, bit);
}

/** The `ATTRIBUTE_*` bit a name denotes, normalized. */
export function attributeFromName(text: string): number | undefined {
  return bitOf(ATTRIBUTE_VOCABULARY, text);
}
