import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../../src/core/cards/index';
import { DECK_SIZE_MAX, DECK_SIZE_MIN } from '../../../src/core/model/template';
import { parseYdk, templateFromDeck } from '../../../src/core/model/ydk';
import { buildCdb, CODE, FIXTURE_ROWS, POPULATION } from '../../helpers/fixture-cards';

const SQL = await initSqlJs();
const cards = CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, FIXTURE_ROWS) }]);

/** A `.ydk` file, written the way EDOPro writes one. */
function ydk(sections: { main?: number[]; extra?: number[]; side?: number[] }): string {
  return [
    '#created by pyrQ',
    '#main',
    ...(sections.main ?? []),
    '#extra',
    ...(sections.extra ?? []),
    '!side',
    ...(sections.side ?? []),
    '',
  ].join('\n');
}

/**
 * `codes` followed by enough other fixture cards, three copies each, to reach
 * `to` entries — so a test can hand over a legal-sized deck while saying only
 * the part it is about. Past 3 × the population it cycles round and the filler
 * itself exceeds three copies, which only the over-60 case reaches.
 */
function padded(codes: readonly number[], to = DECK_SIZE_MIN): number[] {
  const main = [...codes];
  const taken = new Set(codes.map((code) => cards.resolve(code)?.code ?? code));
  const filler = POPULATION.filter((code) => !taken.has(code));
  for (let n = 0; main.length < to; n++) main.push(filler[n % filler.length]!);
  return main;
}

describe('parseYdk', () => {
  it('reads the three sections of a file EDOPro wrote', () => {
    expect(parseYdk(ydk({ main: [1, 2, 2], extra: [3], side: [4, 5] }))).toEqual({
      main: [1, 2, 2],
      extra: [3],
      side: [4, 5],
    });
  });

  it('keeps the file order and every repeat: a count is how many times a code appears', () => {
    expect(parseYdk('#main\n7\n8\n7\n7\n').main).toEqual([7, 8, 7, 7]);
  });

  it('reads CRLF line endings, blank lines and surrounding spaces', () => {
    expect(parseYdk('#main\r\n  11 \r\n\r\n12\r\n').main).toEqual([11, 12]);
  });

  it('ignores a directive it does not know, leaving the section where it was', () => {
    expect(parseYdk('#main\n1\n#created by someone\n2\n')).toMatchObject({ main: [1, 2] });
  });

  it('treats the text before any section directive as the main deck, as EDOPro does', () => {
    expect(parseYdk('1\n2\n#extra\n3\n')).toEqual({ main: [1, 2], extra: [3], side: [] });
  });

  it('skips a line that is not a whole number, rather than failing the file', () => {
    expect(parseYdk('#main\n1\nnot a passcode\n-2\n3.5\n2\n').main).toEqual([1, 2]);
  });

  it('skips a number too large to be an exact passcode', () => {
    expect(parseYdk(`#main\n1\n${'9'.repeat(20)}\n2\n`).main).toEqual([1, 2]);
  });

  it('reads a file with no main deck as an empty one', () => {
    expect(parseYdk('#created by x\n#extra\n9\n!side\n')).toEqual({
      main: [],
      extra: [9],
      side: [],
    });
  });

  it('reads the empty string', () => {
    expect(parseYdk('')).toEqual({ main: [], extra: [], side: [] });
  });
});

describe('templateFromDeck', () => {
  it('makes one line per distinct card, at the count the deck holds, in file order', () => {
    const main = padded([CODE.vanillaDragon, CODE.quickSpell, CODE.vanillaDragon]);
    const imported = templateFromDeck(main, cards);
    expect(imported.warnings).toEqual([]);
    expect(imported.mainSize).toBe(DECK_SIZE_MIN);
    expect(imported.template.deckSize).toBe(DECK_SIZE_MIN);
    expect(imported.template.lines.slice(0, 2)).toEqual([
      {
        id: 'card1',
        card: { passcode: CODE.vanillaDragon, name: 'Synthetic Vanilla Dragon' },
        min: 2,
        max: 2,
      },
      {
        id: 'card2',
        card: { passcode: CODE.quickSpell, name: 'Synthetic Quick Spell' },
        min: 1,
        max: 1,
      },
    ]);
  });

  it('leaves the criteria, the groups and the remainder alone: the deck states the lines only', () => {
    const imported = templateFromDeck(padded([]), cards);
    expect(imported.template.criteria).toEqual([]);
    expect(imported.template.groups).toEqual([]);
    expect(imported.template.remainder).toEqual({ min: 0, max: null });
    expect(imported.template.version).toBe(1);
    expect(imported.template.hand).toEqual({ size: 5 });
  });

  it('counts an alternate-art passcode as the printing it is a reprint of', () => {
    // THE hazard of TDD §19: the index collapses alternate artwork, so the
    // passcode a decklist carries has no record of its own.
    expect(cards.get(CODE.nearAltArt)).toBeUndefined();
    const imported = templateFromDeck(padded([CODE.nearAltArt]), cards);
    expect(imported.warnings).toEqual([]);
    expect(imported.template.lines[0]).toEqual({
      id: 'card1',
      card: { passcode: CODE.vanillaDragon, name: 'Synthetic Vanilla Dragon' },
      min: 1,
      max: 1,
    });
  });

  it('merges a reprint with its canonical printing into ONE line of their combined count', () => {
    const main = padded([CODE.vanillaDragon, CODE.nearAltArt, CODE.vanillaDragon]);
    const imported = templateFromDeck(main, cards);
    expect(imported.template.lines[0]).toMatchObject({
      card: { passcode: CODE.vanillaDragon },
      min: 3,
      max: 3,
    });
    expect(imported.distinct).toBe(new Set(main.map((c) => cards.resolve(c)?.code ?? c)).size);
  });

  it('keeps a "treated as" card as itself: it is not a reprint of its alias target', () => {
    const imported = templateFromDeck(padded([CODE.treatedAsHarpy, CODE.harpy]), cards);
    expect(imported.template.lines.slice(0, 2).map((line) => line.id)).toEqual(['card1', 'card2']);
    expect(imported.template.lines[0]).toMatchObject({
      card: { passcode: CODE.treatedAsHarpy, name: 'Synthetic Cyber Harpy' },
    });
    expect(imported.template.lines[1]).toMatchObject({ card: { passcode: CODE.harpy } });
  });

  it('keeps a line for a passcode the database lacks, and NAMES it in a warning', () => {
    const imported = templateFromDeck(padded([CODE.missingTarget]), cards);
    expect(imported.template.lines[0]).toEqual({
      id: 'card1',
      card: { passcode: CODE.missingTarget, name: `#${CODE.missingTarget}` },
      min: 1,
      max: 1,
    });
    expect(imported.warnings).toEqual([
      `#${CODE.missingTarget} is not in the card database; its line is named after the passcode and fills only a requirement that names it`,
    ]);
  });

  it('holds a line at three copies when the deck lists more, and says which card', () => {
    const imported = templateFromDeck(padded([...Array(4).fill(CODE.harpy)]), cards);
    expect(imported.template.lines[0]).toMatchObject({ min: 3, max: 3 });
    expect(imported.warnings).toEqual([
      'the deck holds 4 copies of Synthetic Harpy; a deck holds at most 3 copies of one card, so its line is 3',
    ]);
  });

  it('raises a main deck under the minimum to the minimum, and says so', () => {
    const imported = templateFromDeck(padded([], 38), cards);
    expect(imported.mainSize).toBe(38);
    expect(imported.template.deckSize).toBe(DECK_SIZE_MIN);
    expect(imported.warnings).toEqual([
      `the main deck holds 38 cards; a template's deck is ${DECK_SIZE_MIN} to ${DECK_SIZE_MAX} cards, so the deck size is ${DECK_SIZE_MIN} and the rest is unspecified`,
    ]);
  });

  it('lowers a main deck over the maximum to the maximum, and says so', () => {
    const imported = templateFromDeck(padded([], 61), cards);
    expect(imported.mainSize).toBe(61);
    expect(imported.template.deckSize).toBe(DECK_SIZE_MAX);
    expect(imported.warnings).toContain(
      `the main deck holds 61 cards; a template's deck is ${DECK_SIZE_MIN} to ${DECK_SIZE_MAX} cards, so the deck size is ${DECK_SIZE_MAX} and the rest is unspecified`,
    );
  });

  it('drops the passcode 0, which names no card, rather than making a line of it', () => {
    const imported = templateFromDeck(padded([0]), cards);
    expect(imported.template.lines.every((line) => line.id !== 'card1' || 'card' in line)).toBe(
      true,
    );
    expect(
      imported.template.lines.some((line) => JSON.stringify(line).includes('"passcode":0')),
    ).toBe(false);
    expect(imported.warnings).toEqual([
      '1 entry of the deck has the passcode 0, which names no card',
    ]);
  });

  it('makes an empty template of an empty deck rather than failing', () => {
    const imported = templateFromDeck([], cards);
    expect(imported.template.lines).toEqual([]);
    expect(imported.mainSize).toBe(0);
    expect(imported.distinct).toBe(0);
  });
});
