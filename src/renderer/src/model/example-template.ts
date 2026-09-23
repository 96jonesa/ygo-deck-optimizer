import type { Template } from '../../../shared/types';

/**
 * `examples/motivating.json` (PRD §4.2), word for word — the renderer cannot
 * read files, so it carries a copy; a test holds the two equal. It stays now
 * that Open exists: "Load example" is one click and needs nobody to know
 * where the repository put its `examples/` folder.
 */
const MOTIVATING: Template = {
  version: 2,
  deckSize: 40,
  hand: { size: 5 },
  groups: [],
  lines: [
    { id: 'A', text: '[Elemental HERO Stratos]', min: 0, max: 3 },
    { id: 'B', text: '[Reinforcement of the Army]', min: 0, max: 3 },
    { id: 'monster', text: 'monster', min: 5, max: 5 },
    { id: 'level4', text: 'level 4 monster', min: 2, max: 3 },
    { id: 'fire-bw', text: 'level 7 FIRE beast-warrior monster', min: 0, max: 3 },
    { id: 'spell', text: 'spell', min: 0, max: 7 },
    { id: 'normal-spell', text: 'normal spell', min: 0, max: 3 },
  ],
  remainder: { min: 0, max: null },
  criteria: [
    {
      id: 'c1',
      name: 'A, B and any monster',
      text: '1x [Elemental HERO Stratos], 1x [Reinforcement of the Army], 1x monster',
    },
    {
      id: 'c2',
      name: 'A, B and a low-Level monster',
      text: '1x [Elemental HERO Stratos], 1x [Reinforcement of the Army], 1x level 4 or lower monster',
    },
  ],
};

/** The example, read-only: a test holds it equal to `examples/motivating.json`. */
export const EXAMPLE_TEMPLATE: Template = MOTIVATING;

/**
 * A FRESH copy of the example, which is what "Load example" loads. The editor
 * changes the template in place from here on, so handing out the module's own
 * object would let one edit rewrite the example for the rest of the session.
 */
export function exampleTemplate(): Template {
  return structuredClone(MOTIVATING);
}
