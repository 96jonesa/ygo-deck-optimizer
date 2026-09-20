import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../../../src/core/model/analyze';
import { validateTemplate } from '../../../../src/core/model/template';
import { EXAMPLE_TEMPLATE } from '../../../../src/renderer/src/model/example-template';
import {
  cardLines,
  EMPTY_TEMPLATE,
  nextCriterionId,
  nextGroupId,
  nextLineId,
  withCardLine,
  withCriterion,
  withCriterionName,
  withCriterionText,
  withCriterionWhen,
  withDeckSize,
  withDescriptionLine,
  withGroup,
  withGroupCard,
  withHandSize,
  withImportedDeck,
  withLineRange,
  withLineText,
  withMode,
  withMovedCriterion,
  withMovedLine,
  withoutCriterion,
  withoutGroup,
  withoutGroupCard,
  withoutLine,
  withRenamedGroup,
  withSuggestedLine,
} from '../../../../src/renderer/src/model/template-edit';
import type { CardHit, Template, TemplateCriterion } from '../../../../src/shared/types';
import { motivatingContext } from '../../../helpers/motivating';

const ctx = motivatingContext(await initSqlJs());

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

function criterionIds(template: Template): string[] {
  return template.criteria.map((criterion) => criterion.id);
}

function criterionTextOf(template: Template, id: string): string | undefined {
  return template.criteria.find((candidate) => candidate.id === id)?.text;
}

/** One empty criterion and nothing else: what the editor starts a criterion from. */
const EMPTY_TEMPLATE_WITH_C1: Template = withCriterion(EMPTY_TEMPLATE);

function descOf(template: Template, id: string): unknown {
  const line = template.lines.find((candidate) => candidate.id === id);
  return line !== undefined && 'desc' in line ? line.desc : undefined;
}

const GROUP_REQ: TemplateCriterion['expr'] = {
  op: 'req',
  n: 1,
  desc: { anyOf: [{ t: 'group', groupId: 'g1' }] },
};

/**
 * Two groups; `line1` and `c1` name the first of them and carry the AST a
 * saved file would have beside their text, `line2` names neither. This is the
 * shape only a FILE produces — the editor never adds an AST to a line — and it
 * is the shape `withoutGroup` has to reason about.
 */
function groupUser(expr: TemplateCriterion['expr'] = GROUP_REQ): Template {
  let template = withGroup(withGroup(EMPTY_TEMPLATE, 'starter'), 'brick');
  template = withDescriptionLine(template);
  template = withLineText(template, 'line1', '{starter}');
  template = withDescriptionLine(template);
  template = withLineText(template, 'line2', 'monster');
  return {
    ...template,
    lines: template.lines.map((line) =>
      line.id === 'line1'
        ? { ...line, desc: { anyOf: [{ t: 'group' as const, groupId: 'g1' }] } }
        : line.id === 'line2'
          ? { ...line, desc: { anyOf: [{ t: 'clause' as const, clause: { kinds: ['monster'] } }] } }
          : line,
    ),
    criteria: [{ id: 'c1', name: 'opener', text: '1x {starter}', ...(expr ? { expr } : {}) }],
  };
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

  // The other half of the authoritative-AST pair (TDD §14): a stored AST may be
  // trusted because it always came from text that still means that. Deleting
  // the group changes what `{starter}` can mean, so the AST it produced is no
  // longer a faithful record of the text and must not outlive it — exactly as
  // `withLineText` drops it when the text itself changes.
  it('drops the stored AST of a line that named the group', () => {
    const template = groupUser();
    expect(descOf(template, 'line1')).toBeDefined();
    const after = withoutGroup(template, 'g1');
    expect(descOf(after, 'line1')).toBeUndefined();
    // The TEXT is untouched: re-parsing it is what produces the good message.
    expect(textOf(after, 'line1')).toBe('{starter}');
  });

  it('drops the stored AST of a criterion that named the group, keeping its name', () => {
    const after = withoutGroup(groupUser(), 'g1');
    expect(after.criteria[0]).toEqual({ id: 'c1', name: 'opener', text: '1x {starter}' });
  });

  it('drops it from a criterion that names the group deep inside an and/or', () => {
    const nested = groupUser({
      op: 'or',
      args: [
        { op: 'req', n: 1, desc: { anyOf: [{ t: 'clause', clause: { kinds: ['trap'] } }] } },
        {
          op: 'and',
          args: [{ op: 'atMost', n: 1, desc: { anyOf: [{ t: 'group', groupId: 'g1' }] } }],
        },
      ],
    });
    expect(withoutGroup(nested, 'g1').criteria[0]!.expr).toBeUndefined();
  });

  it('leaves the stored AST of a line and a criterion that did NOT name the group', () => {
    const template = groupUser();
    const after = withoutGroup(template, 'g2');
    expect(descOf(after, 'line1')).toEqual(descOf(template, 'line1'));
    expect(after.criteria[0]!.expr).toEqual(template.criteria[0]!.expr);
    expect(descOf(after, 'line2')).toEqual(descOf(template, 'line2'));
  });
});

/**
 * Deleting a group out from under a description, end to end: the edit is the
 * renderer's, the message is `analyze`'s, and the point of dropping the stored
 * AST is which message comes out. Keeping it left the line running as a
 * reference to a group that is gone — a stale-text warning plus "this line can
 * hold no card", neither of which says what happened.
 */
describe('a group deleted out from under a description', () => {
  function issuesOf(template: Template, line: string): string[] {
    const found = analyze(template, ctx).lines.find((row) => row.id === line);
    if (found === undefined) throw new Error(`no line ${line}`);
    return found.issues.map((issue) => `${issue.severity}: ${issue.message}`);
  }

  it('gives the line the one message that names the group, and no other', () => {
    expect(issuesOf(withoutGroup(groupUser(), 'g1'), 'line1')).toEqual([
      'error: no group is named "starter"; groups: {brick}',
    ]);
  });

  it('gives the criterion the same message', () => {
    const analysis = analyze(withoutGroup(groupUser(), 'g1'), ctx);
    expect(analysis.criteria[0]!.issues.map((issue) => issue.message)).toEqual([
      'no group is named "starter"; groups: {brick}',
    ]);
  });

  it('says nothing about the line that never named it', () => {
    expect(issuesOf(withoutGroup(groupUser(), 'g1'), 'line2')).toEqual([]);
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

describe('withSuggestedLine', () => {
  it('adds a description line holding exactly the text it was given', () => {
    const one = withSuggestedLine(EMPTY_TEMPLATE, 'level 4 or lower monster');
    expect(one.lines).toEqual([{ id: 'line1', text: 'level 4 or lower monster', min: 0, max: 3 }]);
  });

  it('does not touch the text: a near miss suggestion is `analyze`’s own words', () => {
    const odd = '#40044918';
    expect(textOf(withSuggestedLine(EMPTY_TEMPLATE, odd), 'line1')).toBe(odd);
  });

  it('adds it at the end, after the lines already there', () => {
    const four = withSuggestedLine(three(), 'level 4 or lower monster');
    expect(lineIds(four)).toEqual(['line1', 'line2', 'line3', 'line4']);
    expect(textOf(four, 'line4')).toBe('level 4 or lower monster');
  });

  it('gives the new line a copy range, so the deck can actually hold it', () => {
    expect(withSuggestedLine(EMPTY_TEMPLATE, 'monster').lines[0]).toMatchObject({
      min: 0,
      max: 3,
    });
  });

  it('leaves the template it was given alone', () => {
    const before = three();
    withSuggestedLine(before, 'monster');
    expect(before.lines).toHaveLength(3);
  });

  it('keeps the criteria, which is what asked for the line', () => {
    const one = withCriterionText(withCriterion(EMPTY_TEMPLATE), 'c1', '1x monster');
    expect(withSuggestedLine(one, 'monster').criteria).toEqual(one.criteria);
  });
});

describe('nextCriterionId', () => {
  it('does not collide with a criterion that is already there', () => {
    expect(nextCriterionId(EXAMPLE_TEMPLATE)).toBe('c3');
  });

  it('fills a gap left by a removal rather than growing forever', () => {
    expect(nextCriterionId(withoutCriterion(EXAMPLE_TEMPLATE, 'c1'))).toBe('c1');
  });

  it('starts at c1 for a template with no criteria', () => {
    expect(nextCriterionId(EMPTY_TEMPLATE)).toBe('c1');
  });
});

describe('withCriterion', () => {
  it('adds an empty criterion at the end', () => {
    expect(withCriterion(EMPTY_TEMPLATE).criteria).toEqual([{ id: 'c1', text: '' }]);
  });

  /**
   * As an empty LINE is (`withDescriptionLine`), and for the same reason. This
   * used to make the whole template structurally invalid, so `analyze` answered
   * `invalid` and the editor lost every other line's readout the moment a
   * criterion was added; `core` now accepts the empty draft and reports it as
   * an ordinary parse error on the criterion it is on.
   */
  it('stays a template `core` accepts, so the rest of the editor keeps working', () => {
    expect(validateTemplate(withCriterion(EMPTY_TEMPLATE))).toMatchObject({ ok: true });
  });

  it('gives each new criterion an id of its own, however fast they are added', () => {
    expect(criterionIds(withCriterion(withCriterion(EMPTY_TEMPLATE)))).toEqual(['c1', 'c2']);
  });

  it('adds no name: a criterion is named only if the user names it', () => {
    expect(withCriterion(EMPTY_TEMPLATE).criteria[0]).not.toHaveProperty('name');
  });

  it('leaves the template it was given alone', () => {
    const before = EXAMPLE_TEMPLATE.criteria;
    withCriterion(EXAMPLE_TEMPLATE);
    expect(before).toHaveLength(2);
  });
});

describe('withoutCriterion', () => {
  it('removes the criterion with that id', () => {
    expect(criterionIds(withoutCriterion(EXAMPLE_TEMPLATE, 'c1'))).toEqual(['c2']);
  });

  it('leaves the template alone when the id is not there', () => {
    expect(withoutCriterion(EXAMPLE_TEMPLATE, 'c9')).toBe(EXAMPLE_TEMPLATE);
  });
});

describe('withCriterionText', () => {
  it('replaces the text of that criterion and no other', () => {
    const next = withCriterionText(EXAMPLE_TEMPLATE, 'c2', '1x trap');
    expect(criterionTextOf(next, 'c2')).toBe('1x trap');
    expect(criterionTextOf(next, 'c1')).toBe(criterionTextOf(EXAMPLE_TEMPLATE, 'c1'));
  });

  it('keeps the criterion in its place, and keeps its name', () => {
    const next = withCriterionText(EXAMPLE_TEMPLATE, 'c1', '1x spell');
    expect(criterionIds(next)).toEqual(['c1', 'c2']);
    expect(next.criteria[0]).toMatchObject({ name: 'A, B and any monster' });
  });

  it('drops a stored AST the text no longer matches: the text is what gets parsed', () => {
    const stored: Template = {
      ...EMPTY_TEMPLATE,
      criteria: [{ id: 'c1', text: '1x monster', expr: { op: 'and', args: [] } as never }],
    };
    expect(withCriterionText(stored, 'c1', '1x spell').criteria[0]).not.toHaveProperty('expr');
  });

  it('leaves the template alone when the id is not there', () => {
    expect(withCriterionText(EXAMPLE_TEMPLATE, 'c9', '1x trap')).toBe(EXAMPLE_TEMPLATE);
  });
});

describe('withCriterionName', () => {
  it('names the criterion', () => {
    expect(withCriterionName(EMPTY_TEMPLATE_WITH_C1, 'c1', 'the good hand').criteria[0]).toEqual({
      id: 'c1',
      text: '',
      name: 'the good hand',
    });
  });

  it('trims the name', () => {
    expect(withCriterionName(EMPTY_TEMPLATE_WITH_C1, 'c1', '  spaced  ').criteria[0]).toMatchObject(
      { name: 'spaced' },
    );
  });

  it('drops the name entirely when it is cleared: a blank name is no name', () => {
    const named = withCriterionName(EMPTY_TEMPLATE_WITH_C1, 'c1', 'x');
    expect(withCriterionName(named, 'c1', '   ').criteria[0]).not.toHaveProperty('name');
  });

  it('keeps the text', () => {
    const one = withCriterionText(EMPTY_TEMPLATE_WITH_C1, 'c1', '1x monster');
    expect(withCriterionName(one, 'c1', 'a monster').criteria[0]).toMatchObject({
      text: '1x monster',
    });
  });

  it('gives back the same template when the name is the one it has', () => {
    const named = withCriterionName(EMPTY_TEMPLATE_WITH_C1, 'c1', 'x');
    expect(withCriterionName(named, 'c1', 'x')).toBe(named);
  });

  it('gives back the same template when a nameless criterion is cleared again', () => {
    expect(withCriterionName(EMPTY_TEMPLATE_WITH_C1, 'c1', '')).toBe(EMPTY_TEMPLATE_WITH_C1);
  });

  it('leaves the template alone when the id is not there', () => {
    expect(withCriterionName(EXAMPLE_TEMPLATE, 'c9', 'x')).toBe(EXAMPLE_TEMPLATE);
  });
});

describe('withMovedCriterion', () => {
  it('moves a criterion down one place', () => {
    expect(criterionIds(withMovedCriterion(EXAMPLE_TEMPLATE, 'c1', 1))).toEqual(['c2', 'c1']);
  });

  it('moves a criterion up one place', () => {
    expect(criterionIds(withMovedCriterion(EXAMPLE_TEMPLATE, 'c2', -1))).toEqual(['c2', 'c1']);
  });

  it('will not move the first criterion up off the top', () => {
    expect(withMovedCriterion(EXAMPLE_TEMPLATE, 'c1', -1)).toBe(EXAMPLE_TEMPLATE);
  });

  it('will not move the last criterion down off the bottom', () => {
    expect(withMovedCriterion(EXAMPLE_TEMPLATE, 'c2', 1)).toBe(EXAMPLE_TEMPLATE);
  });

  it('moves the middle criterion either way', () => {
    const three = withCriterion(EXAMPLE_TEMPLATE);
    expect(criterionIds(withMovedCriterion(three, 'c2', -1))).toEqual(['c2', 'c1', 'c3']);
    expect(criterionIds(withMovedCriterion(three, 'c2', 1))).toEqual(['c1', 'c3', 'c2']);
  });

  it('is its own inverse', () => {
    const there = withMovedCriterion(EXAMPLE_TEMPLATE, 'c1', 1);
    expect(withMovedCriterion(there, 'c1', -1).criteria).toEqual(EXAMPLE_TEMPLATE.criteria);
  });

  it('keeps every criterion, and each one whole', () => {
    const moved = withMovedCriterion(EXAMPLE_TEMPLATE, 'c1', 1);
    expect(moved.criteria).toHaveLength(2);
    expect(moved.criteria[1]).toEqual(EXAMPLE_TEMPLATE.criteria[0]);
  });

  it('leaves the template alone when the id is not there', () => {
    expect(withMovedCriterion(EXAMPLE_TEMPLATE, 'c9', 1)).toBe(EXAMPLE_TEMPLATE);
  });
});

describe('withImportedDeck', () => {
  const imported: Template = {
    ...EMPTY_TEMPLATE,
    deckSize: 41,
    lines: [
      { id: 'card1', card: { passcode: ASH.passcode, name: ASH.name }, min: 3, max: 3 },
      { id: 'card2', card: { passcode: MAXX.passcode, name: MAXX.name }, min: 1, max: 1 },
    ],
  };

  it('replaces the lines and the deck size with the deck\u2019s', () => {
    const after = withImportedDeck(EXAMPLE_TEMPLATE, imported);
    expect(after.lines).toEqual(imported.lines);
    expect(after.deckSize).toBe(41);
  });

  // A decklist says nothing about what a good hand looks like (PRD §9), so
  // importing one must not throw away the part the user wrote themselves.
  it('keeps the criteria, the groups, the hand size and the remainder', () => {
    const before = withGroupCard(withGroup(EXAMPLE_TEMPLATE, 'starter'), 'g1', MAXX);
    const after = withImportedDeck(withHandSize(before, 6), imported);
    expect(after.criteria).toBe(before.criteria);
    expect(after.groups).toBe(before.groups);
    expect(after.remainder).toBe(before.remainder);
    expect(after.hand).toEqual({ size: 6 });
  });

  it('gives back a template that validates', () => {
    expect(validateTemplate(withImportedDeck(EXAMPLE_TEMPLATE, imported))).toMatchObject({
      ok: true,
    });
  });

  it('does not share an array with either template it came from', () => {
    const after = withImportedDeck(EXAMPLE_TEMPLATE, imported);
    expect(after.lines).not.toBe(imported.lines);
    expect(after.lines).not.toBe(EXAMPLE_TEMPLATE.lines);
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
    template = withSuggestedLine(template, 'level 4 or lower monster');
    template = withCriterionText(withCriterion(template), 'c1', '1x monster');
    template = withCriterionName(template, 'c1', 'any monster');
    template = withCriterionText(withCriterion(template), 'c2', '1x spell');
    template = withMovedCriterion(template, 'c2', -1);
    expect(validateTemplate(template)).toMatchObject({ ok: true });
  });

  it('never shares an array with the template it came from', () => {
    const before = EXAMPLE_TEMPLATE.lines;
    const after = withLineRange(EXAMPLE_TEMPLATE, 'monster', { min: 4, max: 4 });
    expect(after.lines).not.toBe(before);
    expect(before.find((line) => line.id === 'monster')).toMatchObject({ min: 5, max: 5 });
  });
});

/**
 * The run mode and the criterion tags (PRD §5.5). `mode` is what the template
 * MEANS and `hand.size` is the size its criteria are expanded at; `core`
 * refuses a template whose two disagree, so the editor sets them together.
 */
describe('withMode', () => {
  it('sets the mode and the hand size that goes with it', () => {
    expect(withMode(EMPTY_TEMPLATE, 'second')).toMatchObject({
      mode: 'second',
      hand: { size: 6 },
    });
    expect(withMode(EMPTY_TEMPLATE, 'average')).toMatchObject({
      mode: 'average',
      hand: { size: 6 },
    });
    expect(withMode(withMode(EMPTY_TEMPLATE, 'average'), 'first')).toMatchObject({
      mode: 'first',
      hand: { size: 5 },
    });
  });

  it('gives back the SAME template when nothing moves', () => {
    const template = withMode(EMPTY_TEMPLATE, 'average');
    expect(withMode(template, 'average')).toBe(template);
  });

  it('sets the mode on a template that only stated a hand size', () => {
    // A file written before modes existed says `first` with `hand.size: 5`.
    expect(withMode({ ...EMPTY_TEMPLATE, hand: { size: 5 } }, 'first')).toMatchObject({
      mode: 'first',
      hand: { size: 5 },
    });
  });

  it('changes nothing else', () => {
    const before = { ...EMPTY_TEMPLATE, deckSize: 47, criteria: [{ id: 'c1', text: '1x spell' }] };
    const after = withMode(before, 'second');
    expect({ ...after, mode: undefined, hand: undefined }).toEqual({
      ...before,
      mode: undefined,
      hand: undefined,
    });
  });
});

describe('withCriterionWhen', () => {
  const template: Template = {
    ...EMPTY_TEMPLATE,
    criteria: [
      {
        id: 'c1',
        text: '1x spell',
        expr: {
          op: 'req',
          n: 1,
          desc: { anyOf: [{ t: 'clause', clause: { kinds: ['spell'] } }] },
        } as const,
      },
      { id: 'c2', text: '1x trap', name: 'a trap' },
    ],
  };

  it('tags the criterion it names, and no other', () => {
    const next = withCriterionWhen(template, 'c2', 'second');
    expect(next.criteria.map((criterion) => criterion.when)).toEqual([undefined, 'second']);
    expect(next.criteria[1]).toMatchObject({ id: 'c2', text: '1x trap', name: 'a trap' });
  });

  /**
   * The other half of the authoritative-AST rule (TDD §14): every edit that
   * changes what a criterion SAYS drops the parsed form beside it. A tag says
   * when the criterion is asked, not what it asks, so the two still agree and
   * the AST stays — otherwise re-tagging a criterion would quietly re-read it.
   */
  it('keeps the stored AST: the tag does not change what the criterion says', () => {
    expect(withCriterionWhen(template, 'c1', 'first').criteria[0]!.expr).toEqual(
      template.criteria[0]!.expr,
    );
  });

  it('gives back the SAME template when the tag does not move, `both` included', () => {
    expect(withCriterionWhen(template, 'c1', 'both')).toBe(template);
    const tagged = withCriterionWhen(template, 'c1', 'first');
    expect(withCriterionWhen(tagged, 'c1', 'first')).toBe(tagged);
    expect(withCriterionWhen(template, 'nobody', 'first')).toBe(template);
  });

  it('tags a criterion back to `both`, which is written out rather than removed', () => {
    const tagged = withCriterionWhen(template, 'c1', 'first');
    expect(withCriterionWhen(tagged, 'c1', 'both').criteria[0]!.when).toBe('both');
  });
});
