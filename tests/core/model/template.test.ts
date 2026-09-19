import { describe, expect, it } from 'vitest';
import { validateTemplate } from '../../../src/core/model/template';
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
        { id: 'l2', text: 'level 4 monster', desc: { anyOf: [] }, min: 2, max: 3 },
      ],
      remainder: { min: 0, max: null },
      criteria: [{ id: 'c1', name: 'full combo', text: '1x [..]', expr: { op: 'and', args: [] } }],
      cardSnapshot: { '14558127': { type: 4129, level: 3 } },
    };
    expect(validateTemplate(json)).toEqual({ ok: true, template: json });
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
    expect(errorsOf(withLine({ id: 'l1', text: '  ', min: 0, max: 1 }))).toEqual([
      'lines[0] ("l1"): `text` must be non-empty text, not "  "',
    ]);
    expect(
      errorsOf(withLine({ id: 'l1', text: 'monster', desc: 'monster', min: 0, max: 1 })),
    ).toEqual(['lines[0] ("l1"): `desc` must be a description object, not "monster"']);
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
      'criteria[0] ("c1"): `expr` must be an expression object, not []',
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
