import type {
  Template,
  TemplateCriterion,
  TemplateGroup,
  TemplateLine,
} from '../../src/core/model/template';
import { CODE } from './fixture-cards';
import { ROTA, STRATOS } from './motivating';
import type { Rng } from './prng';

// ---------------------------------------------------------------------------
// Generated templates over the motivating fixture database (tests/helpers/
// motivating.ts): small valid ones whose raw ratios can all be listed, and
// VALID-SHAPED garbage for fuzzing — the types are right, the contents are not.
// ---------------------------------------------------------------------------

/** Every one parses, and matches a card of the fixture. */
export const LINE_TEXTS = [
  'monster',
  'level 4 monster',
  'level 4 or lower monster',
  'LIGHT monster',
  'tuner monster',
  'spell',
  'normal spell',
  'quick-play spell',
  'trap',
  'counter trap',
  'spell/trap',
  'card',
  '[Elemental HERO Stratos]',
  '[Reinforcement of the Army]',
] as const;

export const CRITERION_TEXTS = [
  '1x monster',
  '1x level 4 or lower monster',
  '1x [Elemental HERO Stratos], 1x spell',
  '1x card, 1x monster',
  '1x spell, at most 1x trap',
  '2x monster or 1x tuner monster',
  'no trap, 1x LIGHT monster',
  '1x [Reinforcement of the Army] or 1x [Elemental HERO Stratos]',
] as const;

export function templateOf(
  lines: TemplateLine[],
  criteria: (string | TemplateCriterion)[],
  overrides: Partial<Template> = {},
): Template {
  return {
    version: 2,
    deckSize: 40,
    hand: { size: 5 },
    groups: [],
    lines,
    remainder: { min: 0, max: null },
    criteria: criteria.map((criterion, i) =>
      typeof criterion === 'string' ? { id: `c${i + 1}`, text: criterion } : criterion,
    ),
    ...overrides,
  };
}

/**
 * A valid template of two to six narrow lines, so that every raw ratio can be
 * listed. The remainder's range cuts into the ratios from either side, and now
 * and then leaves none at all.
 */
export function genSmallTemplate(rng: Rng): Template {
  const lines = Array.from({ length: rng.int(2, 6) }, (_, i): TemplateLine => {
    const min = rng.int(0, 2);
    const text = rng.pick(LINE_TEXTS);
    // A line that names a card ranges as far as a description does: no copy limit (PRD §5.1).
    const max = Math.min(min + rng.int(0, 3), 5);
    return { id: `l${i + 1}`, text, min, max };
  });
  const least = lines.reduce((sum, line) => sum + line.min, 0);
  const most = lines.reduce((sum, line) => sum + line.max, 0);
  const remainder = rng.pick([
    { min: 0, max: null },
    { min: 0, max: null },
    // Cuts off the ratios that hold the fewest cards …
    { min: 0, max: 40 - least - rng.int(1, 4) },
    // … the ones that hold the most …
    { min: 40 - most + rng.int(1, 4), max: null },
    // … both …
    { min: 40 - most + 1, max: 40 - least - 1 },
    // … and all of them.
    { min: 0, max: rng.int(0, 5) },
    { min: 41, max: null },
  ]);
  const criteria = rng.subset(CRITERION_TEXTS, 1, 3);
  const min = Math.max(0, remainder.min);
  // Narrow lines can leave the two cuts crossing; an open remainder then.
  const valid = remainder.max === null || min <= remainder.max;
  return templateOf(lines, criteria, {
    remainder: valid ? { min, max: remainder.max } : { min: 0, max: null },
  });
}

const GARBAGE = [
  '',
  ' ',
  'monstr',
  'level',
  'level 99 monster',
  'level 4 level 5 monster',
  'FIRE WATER monster',
  'counter spell',
  'non-normal spell',
  'normal',
  '[',
  '[Nobody Home]',
  '[Black Luster Soldier',
  '{no such group}',
  '{Empty}',
  '{Broken}',
  '#0',
  '#123456789',
  '"No Such Archetype" monster',
  '"Warrior" monster',
  '(((((monster)))))',
  '((((((((((((((((((((((((((((((((((((((((',
  'monster or',
  'or or or',
  'level 7 FIRE beast-warrior monster',
  'ATK ? DEF ? level 1-13 non-FIRE/WATER tuner "Sky Striker" monster',
  '1x monster',
  '💥',
  'monster'.repeat(200),
] as const;

const GARBAGE_CRITERIA = [
  '',
  'monster',
  '1x',
  '0x monster',
  '99x monster',
  '6x monster',
  '7x monster or 1x spell',
  'at most',
  'no',
  'no card',
  'at most 0x card, 1x card',
  '1x monster and',
  '1x monster or or 1x spell',
  '1x [Nobody Home]',
  `1x #${CODE.xyzMonster}`,
  '1x {Empty}',
  '1x {Broken}, no {Starters}',
  '1x level 12 monster',
  '(1x monster',
  // 2^9 alternatives: past the cap.
  Array.from(
    { length: 9 },
    (_, i) => `(1x ATK ${2 * i} monster or 1x ATK ${2 * i + 1} monster)`,
  ).join(' and '),
] as const;

export const FUZZ_GROUPS: TemplateGroup[] = [
  {
    id: 'g-starters',
    name: 'Starters',
    cards: [
      { passcode: STRATOS, name: 'Elemental HERO Stratos' },
      { passcode: ROTA, name: 'Reinforcement of the Army' },
    ],
  },
  { id: 'g-empty', name: 'Empty', cards: [] },
  {
    id: 'g-broken',
    name: 'Broken',
    cards: [
      { passcode: CODE.tunerFairy, name: 'Synthetic Tuner Fairy' },
      { passcode: 12345, name: 'Not In The Database' },
    ],
  },
];

/** A template whose shape `validateTemplate` would accept field by field, and whose contents are anything. */
export function genFuzzTemplate(rng: Rng): Template {
  const count = () => rng.pick([0, 0, 1, 2, 3, 3, 4, 7, 40, 61, 1000, 2 ** 31]);
  const text = () => (rng.chance(0.55) ? rng.pick(LINE_TEXTS) : rng.pick(GARBAGE));
  const lines = Array.from({ length: rng.pick([0, 1, 2, 3, 5, 8, 12]) }, (_, i): TemplateLine => {
    // Ids are unique, as `validateTemplate` insists; everything else is up for grabs.
    const range = { id: `l${i}`, min: count(), max: count() };
    if (rng.chance(0.25))
      return {
        ...range,
        card: {
          passcode: rng.pick([STRATOS, STRATOS, ROTA, CODE.harpy, CODE.treatedAsHarpy, 12345, 1]),
          name: rng.pick(['Elemental HERO Stratos', 'whatever', '']),
        },
      };
    return { ...range, text: text() };
  });
  const criteria = Array.from({ length: rng.pick([0, 1, 1, 2, 3, 6]) }, (_, i) => ({
    id: `c${i}`,
    text: rng.chance(0.6)
      ? rng.pick(CRITERION_TEXTS)
      : rng.chance(0.5)
        ? rng.pick(GARBAGE_CRITERIA)
        : `${rng.int(0, 7)}x ${text()}, at most ${rng.int(0, 7)}x ${text()}`,
  }));
  return {
    version: 2,
    deckSize: rng.pick([40, 40, 40, 60, 41, 0, 1, 5, 39, 61, 1000]),
    hand: { size: rng.pick([5, 5, 5, 6, 0, 1, 7, 100]) },
    groups: rng.chance(0.7) ? FUZZ_GROUPS : [],
    lines,
    remainder: { min: count(), max: rng.chance(0.5) ? null : count() },
    criteria,
  };
}
