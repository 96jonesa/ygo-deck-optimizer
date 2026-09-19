import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SqlJsStatic } from 'sql.js';
import {
  ATTRIBUTE_FIRE,
  ATTRIBUTE_WIND,
  RACE_BEASTWARRIOR,
  RACE_WARRIOR,
  TYPE_EFFECT,
  TYPE_MONSTER,
  TYPE_SPELL,
} from '../../src/core/cards/constants';
import { CardIndex } from '../../src/core/cards/index';
import type { ResolveContext } from '../../src/core/model/compile';
import { type Template, validateTemplate } from '../../src/core/model/template';
import { SETNAMES } from './desc-context';
import { buildCdb, FIXTURE_ROWS, type FixtureRow } from './fixture-cards';

/** The two cards `examples/motivating.json` names. */
export const STRATOS = 40044918;
export const ROTA = 32807846;

/**
 * Stand-ins for the cards the motivating example (PRD §4.2) needs and the
 * synthetic fixture lacks: card A, a Level 4 WIND Warrior; card B, a Normal
 * Spell; and one Level 8 FIRE Beast-Warrior, so that line matches a card.
 */
export const MOTIVATING_ROWS: readonly FixtureRow[] = [
  {
    id: STRATOS,
    name: 'Elemental HERO Stratos',
    type: TYPE_MONSTER | TYPE_EFFECT,
    atk: 1800,
    def: 300,
    level: 4,
    race: RACE_WARRIOR,
    attribute: ATTRIBUTE_WIND,
  },
  {
    id: ROTA,
    name: 'Reinforcement of the Army',
    type: TYPE_SPELL,
    level: 0,
    race: 0,
    attribute: 0,
  },
  {
    id: 90001000,
    name: 'Synthetic Fire Beast-Warrior',
    type: TYPE_MONSTER | TYPE_EFFECT,
    atk: 2700,
    def: 1700,
    level: 8,
    race: RACE_BEASTWARRIOR,
    attribute: ATTRIBUTE_FIRE,
  },
];

/** A `.cdb` image holding the synthetic fixture plus the stand-ins. */
export function motivatingCdb(SQL: SqlJsStatic): Uint8Array {
  return buildCdb(SQL, [...FIXTURE_ROWS, ...MOTIVATING_ROWS]);
}

export function motivatingContext(SQL: SqlJsStatic): ResolveContext {
  return {
    cards: CardIndex.fromDatabases(SQL, [{ bytes: motivatingCdb(SQL) }]),
    setnames: SETNAMES,
  };
}

export const MOTIVATING_PATH = path.resolve(import.meta.dirname, '../../examples/motivating.json');

/** `examples/motivating.json`, validated. */
export function motivatingTemplate(): Template {
  const result = validateTemplate(JSON.parse(readFileSync(MOTIVATING_PATH, 'utf8')));
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.template;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return Math.round(out);
}

/**
 * The exact success probability of the motivating example, by a route that
 * shares nothing with `src/`: the criteria can tell five kinds of card apart
 * (TDD §11.1) — A, B, `level 4 monster`, the other known monsters, and
 * everything else — so every hand COMPOSITION over those five is enumerated,
 * weighted by the multivariate hypergeometric law, and judged by a predicate
 * derived by hand from PRD §6.2's table, where A is a Level 4 monster and B a
 * Normal Spell:
 *
 * - `1x A, 1x B, 1x monster`: an A, a B, and one MORE monster — another A, a
 *   `level 4 monster`, or another known monster;
 * - `1x A, 1x B, 1x level 4 or lower monster`: the same, except that the
 *   other known monsters do not count, their Level being unstated.
 *
 * `counts` are the seven line counts in the order of the template.
 */
export function motivatingExact(
  counts: readonly number[],
  deckSize: number,
  handSize: number,
): { successes: number; hands: number; p: number } {
  const [a, b, monster, level4, fireBeastWarrior, spell, normalSpell] = counts as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const others = monster + fireBeastWarrior;
  const blank = deckSize - a - b - level4 - others;
  if (blank < spell + normalSpell) throw new Error('the lines hold more cards than the deck');

  let successes = 0;
  for (let ha = 0; ha <= handSize; ha++)
    for (let hb = 0; ha + hb <= handSize; hb++)
      for (let h4 = 0; ha + hb + h4 <= handSize; h4++)
        for (let ho = 0; ha + hb + h4 + ho <= handSize; ho++) {
          const anyMonster = ha >= 1 && hb >= 1 && ha - 1 + h4 + ho >= 1;
          const lowMonster = ha >= 1 && hb >= 1 && ha - 1 + h4 >= 1;
          if (!anyMonster && !lowMonster) continue;
          successes +=
            choose(a, ha) *
            choose(b, hb) *
            choose(level4, h4) *
            choose(others, ho) *
            choose(blank, handSize - ha - hb - h4 - ho);
        }
  const hands = choose(deckSize, handSize);
  return { successes, hands, p: successes / hands };
}
