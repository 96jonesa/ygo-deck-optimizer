import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CRITERION_WEIGHT_MAX,
  countsFor,
  handSizeForMode,
  modeOf,
  partsOfMode,
  TEMPLATE_VERSION,
  validateTemplate,
  weightOf,
  whenOf,
} from '../../../src/core/model/template';
import { motivatingTemplate } from '../../helpers/motivating';

/** A small valid template file, as parsed JSON; tests break one thing at a time. */
function valid(): Record<string, unknown> {
  return {
    version: 1,
    deckSize: 40,
    hand: { size: 5 },
    groups: [{ id: 'g1', name: 'starter', cards: [{ passcode: 14558127, name: 'Ash Blossom' }] }],
    lines: [
      { id: 'l1', card: { passcode: 14558127, name: 'Ash Blossom' }, min: 0, max: 3 },
      { id: 'l2', text: 'level 4 monster', min: 2, max: 9 },
    ],
    remainder: { min: 0, max: null },
    criteria: [{ id: 'c1', name: 'combo', text: '1x {starter}' }],
  };
}

function errorsOf(json: unknown): string[] {
  const result = validateTemplate(json);
  return result.ok ? [] : result.errors;
}

/** `valid()` with one top-level field replaced. */
function withField(field: string, value: unknown): Record<string, unknown> {
  return { ...valid(), [field]: value };
}

/** `valid()` with its first line replaced by `line`. */
function withLine(line: unknown): Record<string, unknown> {
  return withField('lines', [line]);
}

describe('validateTemplate', () => {
  it('accepts a valid template and hands it back typed', () => {
    const result = validateTemplate(valid());
    expect(result).toEqual({ ok: true, template: valid() });
  });

  it('accepts the shipped example', () => {
    expect(motivatingTemplate().lines).toHaveLength(7);
  });

  it('accepts the template file of TDD §14, stored ASTs and card snapshot included', () => {
    const json = {
      version: 1,
      deckSize: 40,
      hand: { size: 5 },
      groups: [
        {
          id: 'g1',
          name: 'starter',
          cards: [{ passcode: 14558127, name: 'Ash Blossom & Joyous Spring' }],
        },
      ],
      lines: [
        {
          id: 'l1',
          card: { passcode: 14558127, name: 'Ash Blossom & Joyous Spring' },
          min: 0,
          max: 3,
        },
        {
          id: 'l2',
          text: 'level 4 monster',
          desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [4] } }] },
          min: 2,
          max: 3,
        },
      ],
      remainder: { min: 0, max: null },
      criteria: [
        {
          id: 'c1',
          name: 'full combo',
          text: '1x [Ash Blossom & Joyous Spring]',
          expr: { op: 'req', n: 1, desc: { anyOf: [{ t: 'card', passcode: 14558127 }] } },
        },
      ],
      cardSnapshot: {
        '14558127': {
          type: 4129,
          attribute: 4,
          race: 16,
          level: 3,
          atk: 0,
          def: 1800,
          setcodes: [],
        },
      },
    };
    expect(validateTemplate(json)).toEqual({ ok: true, template: json });
  });

  // The test above holds a COPY of §14's example, so it cannot notice the
  // document drifting away from it. This reads the example out of §14 itself.
  // It is the check that was missing: the placeholder ASTs below sat in the
  // TDD for four milestones because nothing ever ran them.
  it('accepts the template file printed in docs/TDD.md §14, read from the document', () => {
    // Line endings are normalised because git hands this file over with CRLF
    // on Windows, where `\n` in the fence pattern then matches nothing. The
    // Windows CI leg caught exactly that, on its first run.
    const md = readFileSync(new URL('../../../docs/TDD.md', import.meta.url), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    const section = md.slice(md.indexOf('## 14. Template file'), md.indexOf('## 15. Testing'));
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(block, '§14 must still print a JSON template example').toBeDefined();
    expect(validateTemplate(JSON.parse(block!))).toMatchObject({ ok: true });
  });

  // TDD §14's example writes `{ "anyOf": [] }` and `{ "op": "and", "args": [] }`
  // as placeholders beside placeholder text (`"1x [..]"`). They were carried
  // through unread while the text was what got parsed; now that a stored AST is
  // what the engine judges, they are what they say — a description matching
  // nothing and a criterion of no terms — and the file is refused rather than
  // silently meaning something nobody wrote.
  it('refuses the placeholder ASTs the TDD §14 example writes', () => {
    expect(
      errorsOf(withLine({ id: 'l1', text: 'monster', desc: { anyOf: [] }, min: 0, max: 1 })),
    ).toEqual(['lines[0] ("l1"): `desc`: `anyOf` is empty; a description matches something']);
    expect(
      errorsOf(
        withField('criteria', [{ id: 'c1', text: '1x monster', expr: { op: 'and', args: [] } }]),
      ),
    ).toEqual(['criteria[0] ("c1"): `expr`: `and` needs at least one argument']);
  });

  it('fills in no groups and an open remainder when they are left out', () => {
    const { groups: _groups, remainder: _remainder, ...rest } = valid();
    const result = validateTemplate({ ...rest, criteria: [{ id: 'c1', text: '1x monster' }] });
    expect(result).toMatchObject({
      ok: true,
      template: { groups: [], remainder: { min: 0, max: null } },
    });
  });

  it('reads a remainder with only a min, or only a max', () => {
    expect(validateTemplate(withField('remainder', { min: 5 }))).toMatchObject({
      template: { remainder: { min: 5, max: null } },
    });
    expect(validateTemplate(withField('remainder', { max: 20 }))).toMatchObject({
      template: { remainder: { min: 0, max: 20 } },
    });
  });

  it('ignores fields it does not know', () => {
    const result = validateTemplate({ ...valid(), editorState: { zoom: 2 } });
    expect(result).toEqual({ ok: true, template: valid() });
  });

  it('accepts a template with no lines and no criteria yet', () => {
    expect(validateTemplate({ ...valid(), lines: [], criteria: [] }).ok).toBe(true);
  });

  it('rejects what is not a JSON object', () => {
    for (const json of [null, 7, 'x', [valid()]])
      expect(errorsOf(json)).toEqual([expect.stringMatching(/^a template is a JSON object/)]);
  });

  it('refuses an unknown version, and says which it reads', () => {
    expect(errorsOf(withField('version', 2))).toEqual([
      'this file has `version` 2; this build reads version 1 templates',
    ]);
    expect(errorsOf(withField('version', '1'))).toHaveLength(1);
    const { version: _version, ...unversioned } = valid();
    expect(errorsOf(unversioned)).toEqual([
      'this file has no `version`; this build reads version 1 templates',
    ]);
  });

  it('reports every missing field at once', () => {
    expect(errorsOf({ version: 1 })).toEqual([
      'template: `deckSize` is missing',
      '`hand` must be { size }, not nothing',
      '`lines` is missing',
      '`criteria` is missing',
    ]);
  });

  it('holds the deck size to 40-60', () => {
    expect(validateTemplate(withField('deckSize', 40)).ok).toBe(true);
    expect(validateTemplate(withField('deckSize', 60)).ok).toBe(true);
    for (const deckSize of [39, 61])
      expect(errorsOf(withField('deckSize', deckSize))).toEqual([
        `\`deckSize\` is ${deckSize}; a Main Deck holds 40 to 60`,
      ]);
    expect(errorsOf(withField('deckSize', 40.5))).toEqual([
      'template: `deckSize` must be a whole number, not 40.5',
    ]);
  });

  it('holds the hand size to 5 or 6', () => {
    expect(validateTemplate(withField('hand', { size: 6 })).ok).toBe(true);
    for (const size of [4, 7])
      expect(errorsOf(withField('hand', { size }))).toEqual([
        `\`hand.size\` is ${size}; an opening hand is 5 or 6 cards`,
      ]);
    expect(errorsOf(withField('hand', {}))).toEqual(['`hand`: `size` is missing']);
  });

  it('rejects min above max, naming the line by position and id', () => {
    expect(errorsOf(withLine({ id: 'l9', text: 'monster', min: 4, max: 3 }))).toEqual([
      'lines[0] ("l9"): `min` 4 is greater than `max` 3',
    ]);
  });

  it('rejects negative and fractional counts', () => {
    expect(errorsOf(withLine({ id: 'l9', text: 'monster', min: -1, max: 3 }))).toEqual([
      'lines[0] ("l9"): `min` is -1; a count cannot be negative',
    ]);
    expect(errorsOf(withLine({ id: 'l9', text: 'monster', min: 0, max: 2.5 }))).toEqual([
      'lines[0] ("l9"): `max` must be a whole number, not 2.5',
    ]);
    expect(errorsOf(withLine({ id: 'l9', text: 'monster', min: 0 }))).toEqual([
      'lines[0] ("l9"): `max` is missing',
    ]);
  });

  it('caps a named card at three copies, but not a description', () => {
    const card = { passcode: 14558127, name: 'Ash Blossom' };
    expect(validateTemplate(withLine({ id: 'l1', card, min: 0, max: 3 })).ok).toBe(true);
    expect(errorsOf(withLine({ id: 'l1', card, min: 0, max: 4 }))).toEqual([
      'lines[0] ("l1"): `max` is 4, but a deck holds at most 3 copies of one card',
    ]);
    expect(validateTemplate(withLine({ id: 'l1', text: 'monster', min: 0, max: 40 })).ok).toBe(
      true,
    );
  });

  it('wants exactly one of `card` and `text` on a line', () => {
    const card = { passcode: 1, name: 'x' };
    expect(errorsOf(withLine({ id: 'l1', min: 0, max: 1 }))).toEqual([
      'lines[0] ("l1"): needs either `card` ({ passcode, name }) or `text` (a description)',
    ]);
    expect(errorsOf(withLine({ id: 'l1', card, text: 'monster', min: 0, max: 1 }))).toEqual([
      'lines[0] ("l1"): has both `card` and `text`; a line is one or the other',
    ]);
  });

  it('checks the shape of a card', () => {
    expect(errorsOf(withLine({ id: 'l1', card: 14558127, min: 0, max: 1 }))).toEqual([
      'lines[0] ("l1"): `card` must be { passcode, name }, not 14558127',
    ]);
    expect(
      errorsOf(withLine({ id: 'l1', card: { passcode: '1', name: '' }, min: 0, max: 1 })),
    ).toEqual([
      'lines[0] ("l1"): `card.passcode` must be a whole number, not "1"',
      'lines[0] ("l1"): `card.name` must be non-empty text, not ""',
    ]);
    expect(
      errorsOf(withLine({ id: 'l1', card: { passcode: 0, name: 'x' }, min: 0, max: 1 })),
    ).toEqual(['lines[0] ("l1"): `card.passcode` is 0; no card has it']);
  });

  it('wants text on a text line, and an object for a stored AST', () => {
    expect(errorsOf(withLine({ id: 'l1', text: 7, min: 0, max: 1 }))).toEqual([
      'lines[0] ("l1"): `text` must be text, not 7',
    ]);
    expect(
      errorsOf(withLine({ id: 'l1', text: 'monster', desc: 'monster', min: 0, max: 1 })),
    ).toEqual(['lines[0] ("l1"): `desc`: must be { anyOf: [...] }, not "monster"']);
  });

  it('accepts a line or criterion whose text is still empty', () => {
    // A half-written template is full of these: the user has added a line and
    // not typed it yet. Rejecting it here would make the WHOLE template
    // invalid, so `analyze` could answer nothing at all and the editor would
    // lose every other line's readout. An empty description is just a
    // description that does not parse, which `analyze` reports on its own line.
    expect(errorsOf(withLine({ id: 'l1', text: '', min: 0, max: 1 }))).toEqual([]);
    expect(errorsOf(withLine({ id: 'l1', text: '   ', min: 0, max: 1 }))).toEqual([]);
    expect(errorsOf(withField('criteria', [{ id: 'c1', text: '' }]))).toEqual([]);
  });

  it('still wants non-empty text where a blank would be meaningless', () => {
    expect(errorsOf(withLine({ id: '', text: 'monster', min: 0, max: 1 }))).toEqual([
      'lines[0] (""): `id` must be non-empty text, not ""',
    ]);
    expect(
      errorsOf(withLine({ id: 'l1', card: { passcode: 14558127, name: '' }, min: 0, max: 1 })),
    ).toEqual(['lines[0] ("l1"): `card.name` must be non-empty text, not ""']);
  });

  it('rejects duplicate ids within lines, criteria and groups — once each', () => {
    const line = { id: 'dup', text: 'monster', min: 0, max: 1 };
    expect(errorsOf(withField('lines', [line, line, line]))).toEqual([
      '`lines`: the id "dup" is used more than once',
    ]);
    const criterion = { id: 'c', text: '1x monster' };
    expect(errorsOf(withField('criteria', [criterion, criterion]))).toEqual([
      '`criteria`: the id "c" is used more than once',
    ]);
    const group = { id: 'g', name: 'n', cards: [] };
    expect(errorsOf(withField('groups', [group, group]))).toEqual([
      '`groups`: the id "g" is used more than once',
    ]);
  });

  it('lets a line and a criterion share an id: they are different lists', () => {
    const json = {
      ...valid(),
      lines: [{ id: 'x', text: 'monster', min: 0, max: 1 }],
      criteria: [{ id: 'x', text: '1x monster' }],
    };
    expect(validateTemplate(json).ok).toBe(true);
  });

  it('checks criteria: id, text, and the types of name and expr', () => {
    expect(errorsOf(withField('criteria', [{ text: '1x monster' }]))).toEqual([
      'criteria[0]: `id` is missing',
    ]);
    expect(errorsOf(withField('criteria', [{ id: 'c1' }]))).toEqual([
      'criteria[0] ("c1"): `text` is missing',
    ]);
    expect(
      errorsOf(withField('criteria', [{ id: 'c1', text: '1x monster', name: 3, expr: [] }])),
    ).toEqual([
      'criteria[0] ("c1"): `name` must be text, not 3',
      'criteria[0] ("c1"): `expr`: must be an expression object, not []',
    ]);
  });

  it('checks groups and their cards', () => {
    expect(errorsOf(withField('groups', [{ id: 'g1', name: 'starter' }]))).toEqual([
      'groups[0] ("g1"): `cards` must be a list, not nothing',
    ]);
    expect(errorsOf(withField('groups', [{ id: 'g1', name: 'starter', cards: [{}] }]))).toEqual([
      'groups[0] ("g1").cards[0]: `passcode` is missing',
      'groups[0] ("g1").cards[0]: `name` is missing',
    ]);
  });

  it('checks the remainder', () => {
    expect(errorsOf(withField('remainder', { min: 9, max: 3 }))).toEqual([
      '`remainder`: `min` 9 is greater than `max` 3',
    ]);
    expect(errorsOf(withField('remainder', { min: -1 }))).toEqual([
      '`remainder`: `min` is -1; a count cannot be negative',
    ]);
    expect(errorsOf(withField('remainder', 13))).toEqual([
      '`remainder` must be { min, max }, not 13',
    ]);
  });

  it('rejects lists and a snapshot of the wrong type', () => {
    expect(errorsOf(withField('lines', {}))).toEqual(['`lines` must be a list, not {}']);
    expect(errorsOf(withField('lines', ['monster']))).toEqual([
      'lines[0]: must be an object, not "monster"',
    ]);
    expect(errorsOf(withField('cardSnapshot', []))).toEqual([
      '`cardSnapshot` must be an object, not []',
    ]);
  });
});

/**
 * Which hand a criterion is judged for, and which hands a run scores (PRD
 * §5.5). `mode` is what a template MEANS; `hand.size` is how a file written
 * before modes existed said the same thing, and the two may not disagree.
 */
describe('modes and criterion tags', () => {
  describe('handSizeForMode', () => {
    it('is five going first and six otherwise: an average must score the larger hand', () => {
      expect(handSizeForMode('first')).toBe(5);
      expect(handSizeForMode('second')).toBe(6);
      expect(handSizeForMode('average')).toBe(6);
    });
  });

  describe('partsOfMode', () => {
    it('is the one part of a single mode, and both of an average, in that order', () => {
      expect(partsOfMode('first')).toEqual(['first']);
      expect(partsOfMode('second')).toEqual(['second']);
      expect(partsOfMode('average')).toEqual(['first', 'second']);
    });
  });

  describe('countsFor', () => {
    it('counts a tagged criterion in its own part, and `both` in either', () => {
      expect([countsFor('first', 'first'), countsFor('first', 'second')]).toEqual([true, false]);
      expect([countsFor('second', 'first'), countsFor('second', 'second')]).toEqual([false, true]);
      expect([countsFor('both', 'first'), countsFor('both', 'second')]).toEqual([true, true]);
    });
  });

  describe('whenOf', () => {
    it('reads an untagged criterion as `both`: written once, counted either way', () => {
      expect(whenOf({})).toBe('both');
      expect(whenOf({ when: 'second' })).toBe('second');
    });
  });

  describe('modeOf', () => {
    it("is the template's own mode when it states one", () => {
      expect(modeOf({ mode: 'average', hand: { size: 6 } })).toBe('average');
      expect(modeOf({ mode: 'second', hand: { size: 6 } })).toBe('second');
    });

    it('reads a file that predates modes off its hand size, which always meant this', () => {
      expect(modeOf({ hand: { size: 5 } })).toBe('first');
      expect(modeOf({ hand: { size: 6 } })).toBe('second');
    });
  });

  describe('validateTemplate', () => {
    it('accepts a mode and a criterion tag, and hands both back', () => {
      const json = {
        ...withField('mode', 'average'),
        hand: { size: 6 },
        criteria: [
          { id: 'c1', text: '1x {starter}', when: 'first' },
          { id: 'c2', text: '1x {starter}', when: 'both' },
          { id: 'c3', text: '1x {starter}' },
        ],
      };
      const result = validateTemplate(json);
      expect(result.ok && result.template.mode).toBe('average');
      expect(result.ok && result.template.criteria.map((c) => c.when)).toEqual([
        'first',
        'both',
        undefined,
      ]);
    });

    it('leaves `mode` out when the file does, so an older file is unchanged', () => {
      const result = validateTemplate(valid());
      expect(result.ok && 'mode' in result.template).toBe(false);
    });

    it('refuses a mode it does not know, and a tag it does not know', () => {
      expect(errorsOf(withField('mode', 'coinflip'))).toEqual([
        '`mode` is "coinflip"; a run goes first, second, average',
      ]);
      expect(
        errorsOf(withField('criteria', [{ id: 'c1', text: '1x spell', when: 'either' }])),
      ).toEqual([
        'criteria[0] ("c1"): `when` is "either"; a criterion is judged going first, second, both',
      ]);
    });

    it('refuses a file whose mode and hand size disagree, naming both', () => {
      expect(errorsOf({ ...withField('mode', 'average'), hand: { size: 5 } })).toEqual([
        '`mode` is "average", which is judged at a hand of 6, but `hand.size` is 5',
      ]);
      expect(errorsOf({ ...withField('mode', 'second'), hand: { size: 5 } })).toEqual([
        '`mode` is "second", which is judged at a hand of 6, but `hand.size` is 5',
      ]);
      expect(errorsOf({ ...withField('mode', 'first'), hand: { size: 5 } })).toEqual([]);
    });
  });
});

/**
 * Weighting the criteria (PRD §5.6). `weighted` and `weight` are both OPTIONAL
 * on read — which is why `TEMPLATE_VERSION` is not bumped for them: a file
 * written before weighting existed reads as the unweighted run it always was.
 */
describe('criterion weights', () => {
  it('reads a template that says nothing about weighting as unweighted', () => {
    const result = validateTemplate(valid());
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.template.weighted).toBeUndefined();
    expect(result.template.criteria[0]).not.toHaveProperty('weight');
    expect(weightOf(result.template.criteria[0]!)).toBe(1);
    // The SAME version: nothing here needs a migration.
    expect(result.template.version).toBe(TEMPLATE_VERSION);
  });

  it('reads the switch and the weights when they are there', () => {
    const json = {
      ...withField('weighted', true),
      criteria: [
        { id: 'c1', text: '1x monster', weight: 5 },
        { id: 'c2', text: '1x spell' },
      ],
    };
    const result = validateTemplate(json);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.template.weighted).toBe(true);
    expect(result.template.criteria.map(weightOf)).toEqual([5, 1]);
  });

  it('keeps `weighted: false` apart from saying nothing, since a file may say either', () => {
    const result = validateTemplate(withField('weighted', false));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.template.weighted).toBe(false);
  });

  it('refuses a switch that is not a boolean', () => {
    expect(errorsOf(withField('weighted', 'yes'))).toEqual([
      '`weighted` must be true or false, not "yes"',
    ]);
    expect(errorsOf(withField('weighted', 1))).toEqual(['`weighted` must be true or false, not 1']);
  });

  it('refuses a weight that is not a whole number in range', () => {
    const withWeight = (weight: unknown) => ({
      ...valid(),
      criteria: [{ id: 'c1', text: '1x monster', weight }],
    });
    expect(errorsOf(withWeight(0))).toEqual([
      `criteria[0] ("c1"): \`weight\` is 0; a criterion is worth 1 to ${CRITERION_WEIGHT_MAX}`,
    ]);
    expect(errorsOf(withWeight(CRITERION_WEIGHT_MAX + 1))).toEqual([
      `criteria[0] ("c1"): \`weight\` is ${CRITERION_WEIGHT_MAX + 1}; a criterion is worth 1 to ${CRITERION_WEIGHT_MAX}`,
    ]);
    expect(errorsOf(withWeight(-2))).toEqual([
      'criteria[0] ("c1"): `weight` is -2; a count cannot be negative',
    ]);
    expect(errorsOf(withWeight(1.5))).toEqual([
      'criteria[0] ("c1"): `weight` must be a whole number, not 1.5',
    ]);
    expect(errorsOf(withWeight('3'))).toEqual([
      'criteria[0] ("c1"): `weight` must be a whole number, not "3"',
    ]);
  });

  it('reads a weight even with the switch off: the switch decides whether it COUNTS', () => {
    // A weight is kept through turning weighting off and on again, so it has to
    // survive the file too; a broken one is a broken file either way.
    const json = { ...valid(), criteria: [{ id: 'c1', text: '1x monster', weight: 7 }] };
    const result = validateTemplate(json);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.template.weighted).toBeUndefined();
    expect(result.template.criteria[0]!.weight).toBe(7);
  });

  it('bounds the editor far below what the engine can score exactly', () => {
    // The engine's own bound is `floor((2^53 - 1) / C(N, H))` and is enforced by
    // `checkWeightBound`; this one is about a field that must not accept a typo.
    expect(CRITERION_WEIGHT_MAX).toBe(1000);
    expect(CRITERION_WEIGHT_MAX).toBeLessThan(Number.MAX_SAFE_INTEGER / 50_063_860);
  });
});
