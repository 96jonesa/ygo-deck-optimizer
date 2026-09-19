import { describe, expect, it } from 'vitest';
import { validateTemplate } from '../../../../src/core/model/template';
import { EXAMPLE_TEMPLATE } from '../../../../src/renderer/src/model/example-template';
import {
  cardLines,
  EMPTY_TEMPLATE,
  nextGroupId,
  nextLineId,
  withCardLine,
  withDeckSize,
  withDescriptionLine,
  withGroup,
  withGroupCard,
  withHandSize,
  withLineRange,
  withLineText,
  withMovedLine,
  withoutGroup,
  withoutGroupCard,
  withoutLine,
  withRenamedGroup,
} from '../../../../src/renderer/src/model/template-edit';
import type { CardHit, Template } from '../../../../src/shared/types';

const ASH: CardHit = {
  passcode: 14558127,
  name: 'Ash Blossom & Joyous Spring',
  typeline: 'Level 3 · FIRE · Zombie · Tuner Effect Monster',
};
const MAXX: CardHit = {
  passcode: 23434538,
  name: 'Maxx "C"',
  typeline: 'Level 2 · EARTH · Beast · Effect Monster',
};

function lineIds(template: Template): string[] {
  return template.lines.map((line) => line.id);
}

function textOf(template: Template, id: string): string | undefined {
  const line = template.lines.find((candidate) => candidate.id === id);
  return line !== undefined && 'text' in line ? line.text : undefined;
}

/** A template of three description lines, to reorder and edit. */
function three(): Template {
  let template = EMPTY_TEMPLATE;
  for (const text of ['monster', 'spell', 'trap']) {
    template = withDescriptionLine(template);
    const last = template.lines[template.lines.length - 1]!;
    template = withLineText(template, last.id, text);
  }
  return template;
}

describe('EMPTY_TEMPLATE', () => {
  it('is a deck of 40 drawn 5 at a time, with nothing said about it yet', () => {
    expect(EMPTY_TEMPLATE).toMatchObject({ deckSize: 40, hand: { size: 5 }, lines: [] });
  });

  it('is a valid template', () => {
    expect(validateTemplate(EMPTY_TEMPLATE)).toMatchObject({ ok: true });
  });
});

describe('withCardLine', () => {
  it('adds the picked card as a line of its own', () => {
    const template = withCardLine(EMPTY_TEMPLATE, ASH);
    expect(template.lines).toHaveLength(1);
    expect(template.lines[0]).toMatchObject({ card: { passcode: ASH.passcode, name: ASH.name } });
  });

  it('gives the new line a copy range a deck allows', () => {
    const [line] = withCardLine(EMPTY_TEMPLATE, ASH).lines;
    expect(line).toMatchObject({ min: 0, max: 3 });
  });

  it('does not add the same card twice — two lines for one card is a template error', () => {
    const once = withCardLine(EMPTY_TEMPLATE, ASH);
    expect(withCardLine(once, ASH)).toBe(once);
  });

  it('leaves the template it was given alone', () => {
    const before = EMPTY_TEMPLATE.lines.length;
    withCardLine(EMPTY_TEMPLATE, ASH);
    expect(EMPTY_TEMPLATE.lines).toHaveLength(before);
  });

  it('keeps every other part of the template', () => {
    const template = withCardLine(EXAMPLE_TEMPLATE, ASH);
    expect(template.criteria).toBe(EXAMPLE_TEMPLATE.criteria);
    expect(template.deckSize).toBe(EXAMPLE_TEMPLATE.deckSize);
    expect(template.lines).toHaveLength(EXAMPLE_TEMPLATE.lines.length + 1);
  });
});

describe('withDescriptionLine', () => {
  it('adds an empty description line at the end', () => {
    const template = withDescriptionLine(EMPTY_TEMPLATE);
    expect(template.lines).toHaveLength(1);
    expect(template.lines[0]).toMatchObject({ text: '', min: 0, max: 3 });
  });

  it('gives each new line an id of its own, however fast they are added', () => {
    const three = withDescriptionLine(withDescriptionLine(withDescriptionLine(EMPTY_TEMPLATE)));
    expect(new Set(lineIds(three)).size).toBe(3);
  });

  it('does not collide with a card line, which is numbered separately', () => {
    const mixed = withDescriptionLine(withCardLine(EMPTY_TEMPLATE, ASH));
    expect(new Set(lineIds(mixed)).size).toBe(2);
  });

  it('leaves the template it was given alone', () => {
    withDescriptionLine(EXAMPLE_TEMPLATE);
    expect(EXAMPLE_TEMPLATE.lines).toHaveLength(7);
  });
});

describe('withoutLine', () => {
  it('removes the line with that id', () => {
    const two = withCardLine(withCardLine(EMPTY_TEMPLATE, ASH), MAXX);
    const [first] = lineIds(two);
    expect(lineIds(withoutLine(two, first!))).toEqual(lineIds(two).slice(1));
  });

  it('leaves the template alone when the id is not there', () => {
    const one = withCardLine(EMPTY_TEMPLATE, ASH);
    expect(withoutLine(one, 'nope')).toBe(one);
  });
});

describe('withLineText', () => {
  it('replaces the text of that line and no other', () => {
    const edited = withLineText(three(), 'line2', 'quick-play spell');
    expect(edited.lines.map((line) => ('text' in line ? line.text : ''))).toEqual([
      'monster',
      'quick-play spell',
      'trap',
    ]);
  });

  it('keeps the line in its place and keeps its range', () => {
    const edited = withLineText(three(), 'line1', 'trap');
    expect(lineIds(edited)).toEqual(['line1', 'line2', 'line3']);
    expect(edited.lines[0]).toMatchObject({ min: 0, max: 3 });
  });

  it('drops a stored AST the text no longer matches: the text is what gets parsed', () => {
    const stale: Template = {
      ...EMPTY_TEMPLATE,
      lines: [{ id: 'l1', text: 'monster', min: 0, max: 3, desc: { anyOf: [] } }],
    };
    expect(withLineText(stale, 'l1', 'spell').lines[0]).not.toHaveProperty('desc');
  });

  it('leaves a card line alone: a named card is changed with the picker', () => {
    const named = withCardLine(EMPTY_TEMPLATE, ASH);
    expect(withLineText(named, named.lines[0]!.id, 'monster')).toBe(named);
  });

  it('leaves the template alone when the id is not there', () => {
    const template = three();
    expect(withLineText(template, 'nope', 'monster')).toBe(template);
  });
});

describe('withLineRange', () => {
  it('sets the range of that line', () => {
    const edited = withLineRange(three(), 'line2', { min: 2, max: 5 });
    expect(edited.lines[1]).toMatchObject({ id: 'line2', min: 2, max: 5 });
  });

  it('touches no other line', () => {
    const edited = withLineRange(three(), 'line2', { min: 2, max: 5 });
    expect(edited.lines[0]).toMatchObject({ min: 0, max: 3 });
    expect(edited.lines[2]).toMatchObject({ min: 0, max: 3 });
  });

  it('sets the range of a card line too', () => {
    const named = withCardLine(EMPTY_TEMPLATE, ASH);
    const edited = withLineRange(named, named.lines[0]!.id, { min: 1, max: 1 });
    expect(edited.lines[0]).toMatchObject({ min: 1, max: 1, card: { passcode: ASH.passcode } });
  });

  it('leaves the template alone when the id is not there', () => {
    const template = three();
    expect(withLineRange(template, 'nope', { min: 1, max: 2 })).toBe(template);
  });
});

describe('withMovedLine', () => {
  it('moves a line down one place', () => {
    expect(lineIds(withMovedLine(three(), 'line1', 1))).toEqual(['line2', 'line1', 'line3']);
  });

  it('moves a line up one place', () => {
    expect(lineIds(withMovedLine(three(), 'line3', -1))).toEqual(['line1', 'line3', 'line2']);
  });

  it('will not move the first line up off the top', () => {
    const template = three();
    expect(withMovedLine(template, 'line1', -1)).toBe(template);
  });

  it('will not move the last line down off the bottom', () => {
    const template = three();
    expect(withMovedLine(template, 'line3', 1)).toBe(template);
  });

  it('moves the middle line either way', () => {
    expect(lineIds(withMovedLine(three(), 'line2', -1))).toEqual(['line2', 'line1', 'line3']);
    expect(lineIds(withMovedLine(three(), 'line2', 1))).toEqual(['line1', 'line3', 'line2']);
  });

  it('is its own inverse', () => {
    const template = three();
    expect(lineIds(withMovedLine(withMovedLine(template, 'line1', 1), 'line1', -1))).toEqual(
      lineIds(template),
    );
  });

  it('leaves the template alone when the id is not there', () => {
    const template = three();
    expect(withMovedLine(template, 'nope', 1)).toBe(template);
  });

  it('keeps every line, and each one whole', () => {
    const moved = withMovedLine(three(), 'line1', 1);
    expect(moved.lines).toHaveLength(3);
    expect(textOf(moved, 'line1')).toBe('monster');
  });
});

describe('nextLineId', () => {
  it('does not collide with a line that is already there', () => {
    const two = withCardLine(withCardLine(EMPTY_TEMPLATE, ASH), MAXX);
    expect(lineIds(two)).not.toContain(nextLineId(two, 'card'));
  });

  it('does not collide with the ids of a loaded template either', () => {
    expect(lineIds(EXAMPLE_TEMPLATE)).not.toContain(nextLineId(EXAMPLE_TEMPLATE, 'card'));
    expect(lineIds(EXAMPLE_TEMPLATE)).not.toContain(nextLineId(EXAMPLE_TEMPLATE, 'line'));
  });

  it('fills a gap left by a removal rather than growing forever', () => {
    const two = withCardLine(withCardLine(EMPTY_TEMPLATE, ASH), MAXX);
    const [first] = lineIds(two);
    const one = withoutLine(two, first!);
    expect(nextLineId(one, 'card')).toBe(first);
  });

  it('numbers each prefix on its own', () => {
    expect(nextLineId(EMPTY_TEMPLATE, 'card')).toBe('card1');
    expect(nextLineId(EMPTY_TEMPLATE, 'line')).toBe('line1');
  });
});

describe('cardLines', () => {
  it('is the lines that name a card, not the ones that describe cards', () => {
    const mixed = withCardLine(EXAMPLE_TEMPLATE, ASH);
    expect(cardLines(mixed).map((line) => line.card.passcode)).toEqual([ASH.passcode]);
  });

  it('is empty for a template of descriptions alone', () => {
    expect(cardLines(EXAMPLE_TEMPLATE)).toEqual([]);
  });
});

describe('withDeckSize', () => {
  it('sets the deck size', () => {
    expect(withDeckSize(EMPTY_TEMPLATE, 47).deckSize).toBe(47);
  });

  it('gives back the same template when the size is the one it has', () => {
    expect(withDeckSize(EMPTY_TEMPLATE, 40)).toBe(EMPTY_TEMPLATE);
  });
});

describe('withHandSize', () => {
  it('sets the hand size', () => {
    expect(withHandSize(EMPTY_TEMPLATE, 6).hand).toEqual({ size: 6 });
  });

  it('gives back the same template when the size is the one it has', () => {
    expect(withHandSize(EMPTY_TEMPLATE, 5)).toBe(EMPTY_TEMPLATE);
  });
});

describe('nextGroupId', () => {
  it('does not collide with a group that is already there', () => {
    const one = withGroup(EMPTY_TEMPLATE, 'starter');
    expect(one.groups.map((group) => group.id)).not.toContain(nextGroupId(one));
  });
});

describe('withGroup', () => {
  it('adds an empty group under the name given', () => {
    const template = withGroup(EMPTY_TEMPLATE, 'starter');
    expect(template.groups).toEqual([{ id: 'g1', name: 'starter', cards: [] }]);
  });

  it('gives each group an id of its own', () => {
    const two = withGroup(withGroup(EMPTY_TEMPLATE, 'starter'), 'brick');
    expect(new Set(two.groups.map((group) => group.id)).size).toBe(2);
  });

  it('trims the name, which is what a description has to match', () => {
    expect(withGroup(EMPTY_TEMPLATE, '  starter  ').groups[0]?.name).toBe('starter');
  });

  it('refuses a blank name rather than making a group no description can reach', () => {
    expect(withGroup(EMPTY_TEMPLATE, '   ')).toBe(EMPTY_TEMPLATE);
  });
});

describe('withRenamedGroup', () => {
  it('renames the group and keeps its members', () => {
    const one = withGroupCard(withGroup(EMPTY_TEMPLATE, 'starter'), 'g1', ASH);
    const renamed = withRenamedGroup(one, 'g1', 'enabler');
    expect(renamed.groups[0]).toEqual({
      id: 'g1',
      name: 'enabler',
      cards: [{ passcode: ASH.passcode, name: ASH.name }],
    });
  });

  it('refuses a blank name', () => {
    const one = withGroup(EMPTY_TEMPLATE, 'starter');
    expect(withRenamedGroup(one, 'g1', '  ')).toBe(one);
  });

  it('leaves the template alone when the id is not there', () => {
    const one = withGroup(EMPTY_TEMPLATE, 'starter');
    expect(withRenamedGroup(one, 'nope', 'enabler')).toBe(one);
  });
});

describe('withoutGroup', () => {
  it('removes the group', () => {
    const two = withGroup(withGroup(EMPTY_TEMPLATE, 'starter'), 'brick');
    expect(withoutGroup(two, 'g1').groups.map((group) => group.name)).toEqual(['brick']);
  });

  it('leaves the lines exactly as they were: a description that named it says so itself', () => {
    // Deleting a group cannot quietly rewrite the user's text. `{starter}` on a
    // line stays `{starter}`, and `analyze` reports it as a parse error naming
    // the group that is gone — which is the only honest outcome.
    const used = withLineText(withGroup(three(), 'starter'), 'line1', '{starter}');
    expect(textOf(withoutGroup(used, 'g1'), 'line1')).toBe('{starter}');
  });

  it('leaves the template alone when the id is not there', () => {
    const one = withGroup(EMPTY_TEMPLATE, 'starter');
    expect(withoutGroup(one, 'nope')).toBe(one);
  });
});

describe('withGroupCard', () => {
  it('adds the card to that group', () => {
    const one = withGroupCard(withGroup(EMPTY_TEMPLATE, 'starter'), 'g1', ASH);
    expect(one.groups[0]?.cards).toEqual([{ passcode: ASH.passcode, name: ASH.name }]);
  });

  it('keeps only the passcode and the name a template file records', () => {
    const one = withGroupCard(withGroup(EMPTY_TEMPLATE, 'starter'), 'g1', ASH);
    expect(Object.keys(one.groups[0]!.cards[0]!).sort()).toEqual(['name', 'passcode']);
  });

  it('does not add one card to a group twice', () => {
    const once = withGroupCard(withGroup(EMPTY_TEMPLATE, 'starter'), 'g1', ASH);
    expect(withGroupCard(once, 'g1', ASH)).toBe(once);
  });

  it('adds the same card to a different group happily', () => {
    const two = withGroup(withGroup(EMPTY_TEMPLATE, 'starter'), 'brick');
    const both = withGroupCard(withGroupCard(two, 'g1', ASH), 'g2', ASH);
    expect(both.groups.map((group) => group.cards.length)).toEqual([1, 1]);
  });

  it('leaves the template alone when the id is not there', () => {
    const one = withGroup(EMPTY_TEMPLATE, 'starter');
    expect(withGroupCard(one, 'nope', ASH)).toBe(one);
  });
});

describe('withoutGroupCard', () => {
  it('removes that card from that group', () => {
    const two = withGroupCard(
      withGroupCard(withGroup(EMPTY_TEMPLATE, 'starter'), 'g1', ASH),
      'g1',
      MAXX,
    );
    expect(withoutGroupCard(two, 'g1', ASH.passcode).groups[0]?.cards).toEqual([
      { passcode: MAXX.passcode, name: MAXX.name },
    ]);
  });

  it('leaves the template alone when the card is not in the group', () => {
    const one = withGroupCard(withGroup(EMPTY_TEMPLATE, 'starter'), 'g1', ASH);
    expect(withoutGroupCard(one, 'g1', MAXX.passcode)).toBe(one);
  });
});

describe('an edited template', () => {
  it('stays one `core` accepts, through every kind of edit', () => {
    let template = withCardLine(EMPTY_TEMPLATE, ASH);
    template = withDescriptionLine(template);
    template = withLineText(template, 'line1', 'level 4 monster');
    template = withLineRange(template, 'line1', { min: 2, max: 3 });
    template = withMovedLine(template, 'line1', -1);
    template = withDeckSize(template, 41);
    template = withHandSize(template, 6);
    template = withGroupCard(withGroup(template, 'starter'), 'g1', MAXX);
    expect(validateTemplate(template)).toMatchObject({ ok: true });
  });

  it('never shares an array with the template it came from', () => {
    const before = EXAMPLE_TEMPLATE.lines;
    const after = withLineRange(EXAMPLE_TEMPLATE, 'monster', { min: 4, max: 4 });
    expect(after.lines).not.toBe(before);
    expect(before.find((line) => line.id === 'monster')).toMatchObject({ min: 5, max: 5 });
  });
});
