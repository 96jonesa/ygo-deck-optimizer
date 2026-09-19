import { type CardRecord, isMonster, isTrap } from '../../core/cards/record';
import {
  attributeName,
  kindEntry,
  type MonsterFlag,
  monsterFlagEntry,
  raceName,
  ST_SUBKIND_VOCABULARY,
  stSubkindEntry,
} from '../../core/cards/vocabulary';

/**
 * The order a printed card lists its monster types in — `[Spellcaster /
 * Pendulum / Effect]`, `[Fairy / Flip / Tuner / Effect]`: Ritual and Pendulum,
 * then the abilities, then Tuner, and Normal or Effect last.
 */
const FLAG_ORDER: readonly MonsterFlag[] = [
  'ritual',
  'pendulum',
  'toon',
  'spirit',
  'union',
  'gemini',
  'flip',
  'tuner',
  'normal',
  'effect',
];

/**
 * One line that tells a card from its namesakes in the picker (TDD §4.3,
 * §12): `Level 4 · WIND · Warrior · Effect Monster`, `Quick-Play Spell`,
 * `Counter Trap`. Every word comes from the vocabulary tables. The index
 * holds Main Deck cards only, so there is no Rank and no Link Rating to say.
 */
export function typeline(card: CardRecord): string {
  if (isMonster(card.type)) {
    const flags = FLAG_ORDER.map(monsterFlagEntry)
      .filter((entry) => (card.type & entry.bit) !== 0)
      .map((entry) => entry.name);
    return [
      `Level ${card.level}`,
      attributeName(card.attribute),
      raceName(card.race),
      [...flags, kindEntry('monster').name].join(' '),
    ]
      .filter((part) => part !== undefined)
      .join(' · ');
  }

  const kind = isTrap(card.type) ? 'trap' : 'spell';
  const subkinds = ST_SUBKIND_VOCABULARY.filter((entry) => (card.type & entry.bit) !== 0).map(
    (entry) => entry.name,
  );
  // `normal` has no bit of its own: it is the absence of every other sub-kind.
  if (subkinds.length === 0) subkinds.push(stSubkindEntry('normal').name);
  return [...subkinds, kindEntry(kind).name].join(' ');
}
