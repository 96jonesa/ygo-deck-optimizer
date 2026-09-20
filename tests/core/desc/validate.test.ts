import { describe, expect, it } from 'vitest';
import { LEVEL_MAX, SETCODE_MAX } from '../../../src/core/desc/ast';
import { parse } from '../../../src/core/desc/parser';
import { validateDescription } from '../../../src/core/desc/validate';
import { cardRecord, contextOf, FakeCards } from '../../helpers/desc-context';

const CTX = contextOf(new FakeCards([cardRecord({ code: 89631139, name: 'Blue-Eyes' })]));

/** The AST of `text`, as the parser produces it: the shape validation must accept. */
function ast(text: string): unknown {
  const parsed = parse(text, CTX);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.message}`);
  return JSON.parse(JSON.stringify(parsed.desc));
}

function errors(value: unknown): string[] {
  const result = validateDescription(value, 'desc');
  return result.ok ? [] : result.errors;
}

describe('validateDescription', () => {
  // A stored AST is what the engine judges (TDD §14), so it arrives from a
  // file or over IPC as `unknown` and has to be checked before `implies` sees
  // it — the parser's own output is the shape it has to accept.
  it('accepts every AST the parser produces', () => {
    for (const text of [
      'level 4 monster',
      'FIRE/WATER non-tuner monster',
      'ATK 1500 or less spell/monster',
      'quick-play/continuous spell',
      '#89631139',
      '{Starters}',
      'level 1-3 monster or trap',
      '"Blue-Eyes"',
      'DEF ? monster',
      'card',
    ])
      expect(errors(ast(text))).toEqual([]);
  });

  it('gives back the CANONICAL form, so two equal descriptions stringify alike', () => {
    const result = validateDescription(
      { anyOf: [{ t: 'clause', clause: { level: [4, 2, 4], kinds: ['monster'] } }] },
      'desc',
    );
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(JSON.stringify(result.desc)).toBe(
      JSON.stringify({ anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [2, 4] } }] }),
    );
  });

  it('drops fields the AST has no place for rather than carrying them into the engine', () => {
    const result = validateDescription(
      { anyOf: [{ t: 'clause', clause: { kinds: ['spell'], sneaky: 1 } }], extra: true },
      'desc',
    );
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.desc).toEqual({ anyOf: [{ t: 'clause', clause: { kinds: ['spell'] } }] });
  });

  it('refuses anything that is not a description at all', () => {
    expect(errors(null)).toEqual(['desc: must be { anyOf: [...] }, not null']);
    expect(errors([])).toEqual(['desc: must be { anyOf: [...] }, not []']);
    expect(errors({})).toEqual(['desc: `anyOf` must be a list, not nothing']);
    expect(errors({ anyOf: [] })).toEqual([
      'desc: `anyOf` is empty; a description matches something',
    ]);
  });

  it('refuses an alternative of an unknown kind', () => {
    expect(errors({ anyOf: [{ t: 'passcode', passcode: 1 }] })).toEqual([
      'desc.anyOf[0]: `t` must be "card", "group" or "clause", not "passcode"',
    ]);
  });

  it('refuses a card alternative without a usable passcode', () => {
    expect(errors({ anyOf: [{ t: 'card' }] })).toEqual([
      'desc.anyOf[0]: `passcode` must be a whole number above 0, not nothing',
    ]);
    expect(errors({ anyOf: [{ t: 'card', passcode: 0 }] })).toHaveLength(1);
    expect(errors({ anyOf: [{ t: 'card', passcode: 1.5 }] })).toHaveLength(1);
  });

  it('refuses a group alternative without an id', () => {
    expect(errors({ anyOf: [{ t: 'group', groupId: '' }] })).toEqual([
      'desc.anyOf[0]: `groupId` must be non-empty text, not ""',
    ]);
  });

  it('refuses a word that is not in the vocabulary', () => {
    expect(errors({ anyOf: [{ t: 'clause', clause: { kinds: ['creature'] } }] })).toEqual([
      'desc.anyOf[0].clause: `kinds[0]` is "creature"; the kinds are monster, spell, trap',
    ]);
    expect(errors({ anyOf: [{ t: 'clause', clause: { stSubkinds: ['flip'] } }] })).toHaveLength(1);
    expect(errors({ anyOf: [{ t: 'clause', clause: { flags: { starter: true } } }] })).toHaveLength(
      1,
    );
    expect(errors({ anyOf: [{ t: 'clause', clause: { flags: { tuner: 'yes' } } }] })).toHaveLength(
      1,
    );
  });

  it('refuses a value outside its domain', () => {
    expect(errors({ anyOf: [{ t: 'clause', clause: { level: [LEVEL_MAX + 1] } }] })).toEqual([
      `desc.anyOf[0].clause: \`level[0]\` is ${LEVEL_MAX + 1}; a Level is 0 to ${LEVEL_MAX}`,
    ]);
    expect(
      errors({ anyOf: [{ t: 'clause', clause: { archetypes: [SETCODE_MAX + 1] } }] }),
    ).toHaveLength(1);
    expect(errors({ anyOf: [{ t: 'clause', clause: { archetypes: [0] } }] })).toHaveLength(1);
  });

  it('refuses a stat range that is not one', () => {
    expect(errors({ anyOf: [{ t: 'clause', clause: { atk: { min: 5, max: 1 } } }] })).toEqual([
      'desc.anyOf[0].clause: `atk`: 5 to 1 is not a range',
    ]);
    expect(errors({ anyOf: [{ t: 'clause', clause: { atk: '??' } }] })).toHaveLength(1);
    expect(
      errors({ anyOf: [{ t: 'clause', clause: { def: { min: -1, max: null } } }] }),
    ).toHaveLength(1);
    expect(errors({ anyOf: [{ t: 'clause', clause: { atk: { min: 0, max: null } } }] })).toEqual(
      [],
    );
    expect(errors({ anyOf: [{ t: 'clause', clause: { atk: '?' } }] })).toEqual([]);
  });

  it('refuses a value set that says both `in` and `notIn`, or neither', () => {
    expect(
      errors({ anyOf: [{ t: 'clause', clause: { attributes: { in: [1], notIn: [2] } } }] }),
    ).toEqual(['desc.anyOf[0].clause: `attributes` is either { in } or { notIn }, never both']);
    expect(errors({ anyOf: [{ t: 'clause', clause: { races: {} } }] })).toHaveLength(1);
  });

  it('reports every problem, not only the first', () => {
    expect(
      errors({
        anyOf: [{ t: 'clause', clause: { kinds: ['creature'], level: [99] } }, { t: 'card' }],
      }),
    ).toHaveLength(3);
  });
});
