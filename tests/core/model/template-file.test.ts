import { describe, expect, it } from 'vitest';
import type { CardRecord } from '../../../src/core/cards/record';
import type { DescContext } from '../../../src/core/desc/context';
import { groupLookupOf } from '../../../src/core/model/compile';
import type { Template } from '../../../src/core/model/template';
import { validateTemplate } from '../../../src/core/model/template';
import {
  namedPasscodes,
  snapshotNotices,
  templateToFile,
} from '../../../src/core/model/template-file';
import { cardRecord, FakeCards, SETNAMES } from '../../helpers/desc-context';

const ASH = cardRecord({ code: 14558127, name: 'Ash Blossom & Joyous Spring', level: 3, atk: 0 });
const BLUE = cardRecord({ code: 89631139, name: 'Blue-Eyes White Dragon', level: 8, atk: 3000 });
const CARDS = new FakeCards([ASH, BLUE]);

function templateOf(overrides: Partial<Template> = {}): Template {
  const template: Template = {
    version: 1,
    deckSize: 40,
    hand: { size: 5 },
    groups: [],
    lines: [],
    remainder: { min: 0, max: null },
    criteria: [],
    ...overrides,
  };
  return template;
}

function ctxFor(template: Template, cards = CARDS): DescContext {
  return { cards, setnames: SETNAMES, groups: groupLookupOf(template.groups) };
}

function snapshotOf(card: CardRecord) {
  return {
    type: card.type,
    attribute: card.attribute,
    race: card.race,
    level: card.level,
    atk: card.atk,
    def: card.def,
    setcodes: [...card.setcodes],
  };
}

describe('namedPasscodes', () => {
  it('collects picker lines, group members, and passcodes written into text', () => {
    const template = templateOf({
      lines: [
        { id: 'c1', card: { passcode: 14558127, name: 'Ash' }, min: 0, max: 3 },
        { id: 'l1', text: '#89631139 or monster', min: 0, max: 3 },
      ],
      groups: [{ id: 'g1', name: 'starters', cards: [{ passcode: 89631139, name: 'Blue' }] }],
      criteria: [{ id: 'k1', text: '1x #14558127' }],
    });
    expect(namedPasscodes(template, ctxFor(template))).toEqual([14558127, 89631139]);
  });

  it('skips a line or criterion that does not parse rather than failing', () => {
    const template = templateOf({
      lines: [{ id: 'l1', text: 'monstr', min: 0, max: 3 }],
      criteria: [{ id: 'k1', text: '1x #14558127' }],
    });
    expect(namedPasscodes(template, ctxFor(template))).toEqual([14558127]);
  });
});

describe('templateToFile', () => {
  const template = templateOf({
    lines: [
      { id: 'c1', card: { passcode: 14558127, name: 'Ash' }, min: 0, max: 3 },
      { id: 'l1', text: 'level 4 monster', min: 2, max: 3 },
    ],
    criteria: [{ id: 'k1', name: 'combo', text: '1x #14558127 and 1x level 4 monster' }],
  });

  it('writes the AST beside every text that parses', () => {
    const { template: file, warnings } = templateToFile(template, ctxFor(template));
    expect(warnings).toEqual([]);
    expect(file.lines[1]).toEqual({
      id: 'l1',
      min: 2,
      max: 3,
      text: 'level 4 monster',
      desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [4] } }] },
    });
    expect(file.criteria[0]).toMatchObject({ id: 'k1', name: 'combo' });
    expect(file.criteria[0]!.expr).toBeDefined();
  });

  it('writes a snapshot of every named card, by passcode', () => {
    const { template: file } = templateToFile(template, ctxFor(template));
    expect(file.cardSnapshot).toEqual({ '14558127': snapshotOf(ASH) });
  });

  it('writes a file that validates and reads back as itself', () => {
    const { template: file } = templateToFile(template, ctxFor(template));
    const reread = validateTemplate(JSON.parse(JSON.stringify(file)));
    expect(reread).toEqual({ ok: true, template: file });
  });

  it('is idempotent: saving what was saved changes nothing', () => {
    const once = templateToFile(template, ctxFor(template)).template;
    const twice = templateToFile(once, ctxFor(once)).template;
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('keeps the text alone when it does not parse, and names the line', () => {
    const broken = templateOf({
      lines: [{ id: 'l1', text: 'level 4 monstr', min: 0, max: 3 }],
      criteria: [{ id: 'k1', text: '1x monstr' }],
    });
    const { template: file, warnings } = templateToFile(broken, ctxFor(broken));
    expect(file.lines[0]).toEqual({ id: 'l1', min: 0, max: 3, text: 'level 4 monstr' });
    expect(file.criteria[0]).toEqual({ id: 'k1', text: '1x monstr', when: 'both' });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('line "l1" does not parse');
    expect(warnings[1]).toContain('criterion "k1" does not parse');
  });

  it('saves what a stale line MEANS, not what its text now reads as', () => {
    const stale = templateOf({
      lines: [
        {
          id: 'l1',
          text: 'trap',
          desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'] } }] },
          min: 0,
          max: 3,
        },
      ],
    });
    const { template: file } = templateToFile(stale, ctxFor(stale));
    expect(file.lines[0]).toMatchObject({
      desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'] } }] },
    });
  });

  /**
   * The mode and the criteria's tags are the run itself (PRD §5.5), so a file
   * that did not carry them would open as a different run than the one that
   * was saved. Both are written out IN FULL — `both` included — because a
   * field left to a default means whatever the default means next year.
   */
  describe('the mode and the criterion tags', () => {
    const tagged = templateOf({
      hand: { size: 6 },
      mode: 'average',
      criteria: [
        { id: 'k1', text: '1x #14558127', when: 'first' },
        { id: 'k2', text: '1x #89631139', when: 'second' },
        { id: 'k3', text: '1x monster' },
      ],
    });

    it('writes the mode, and the hand size that goes with it', () => {
      const { template: file } = templateToFile(tagged, ctxFor(tagged));
      expect(file.mode).toBe('average');
      expect(file.hand).toEqual({ size: 6 });
    });

    it('writes the mode a file that predates modes MEANT, rather than nothing', () => {
      const old = templateOf({ hand: { size: 6 }, criteria: [{ id: 'k1', text: '1x monster' }] });
      expect(templateToFile(old, ctxFor(old)).template.mode).toBe('second');
    });

    it('writes every tag out, the default one too', () => {
      const { template: file } = templateToFile(tagged, ctxFor(tagged));
      expect(file.criteria.map((criterion) => criterion.when)).toEqual(['first', 'second', 'both']);
    });

    it('round trips: what is written reads back as the same template', () => {
      const { template: file } = templateToFile(tagged, ctxFor(tagged));
      const reread = validateTemplate(JSON.parse(JSON.stringify(file)));
      expect(reread).toEqual({ ok: true, template: file });
      expect(reread.ok && reread.template.mode).toBe('average');
      expect(reread.ok && reread.template.criteria.map((c) => c.when)).toEqual([
        'first',
        'second',
        'both',
      ]);
    });
  });

  it('records nothing for a named card this install lacks', () => {
    const absent = templateOf({
      lines: [{ id: 'c1', card: { passcode: 99999999, name: 'Gone' }, min: 0, max: 3 }],
    });
    expect(templateToFile(absent, ctxFor(absent)).template.cardSnapshot).toEqual({});
  });
});

describe('snapshotNotices', () => {
  const template = templateOf({
    lines: [{ id: 'c1', card: { passcode: 14558127, name: 'Ash Blossom' }, min: 0, max: 3 }],
  });

  it('says nothing when the install agrees with the file', () => {
    expect(
      snapshotNotices({ ...template, cardSnapshot: { '14558127': snapshotOf(ASH) } }, CARDS),
    ).toEqual([]);
  });

  it('says nothing when the file recorded nothing', () => {
    expect(snapshotNotices(template, CARDS)).toEqual([]);
  });

  it('names the card and the fields that moved', () => {
    const saved = { ...snapshotOf(ASH), level: 4, atk: 100 };
    expect(snapshotNotices({ ...template, cardSnapshot: { '14558127': saved } }, CARDS)).toEqual([
      "Ash Blossom (#14558127) differs from the file's record of it (level 4 → 3; atk 100 → 0); this install's card data is what runs",
    ]);
  });

  it('reports a setcode change, which no other field would show', () => {
    const saved = { ...snapshotOf(ASH), setcodes: [0x64] };
    const [notice] = snapshotNotices({ ...template, cardSnapshot: { '14558127': saved } }, CARDS);
    expect(notice).toContain('setcodes [100] → []');
  });

  it('reports a card the install no longer holds', () => {
    const saved = { '99999999': snapshotOf(ASH) };
    const [notice] = snapshotNotices({ ...template, cardSnapshot: saved }, CARDS);
    expect(notice).toBe(
      "#99999999 is not in this install's card database, but the file recorded it: what this line matches may differ from what it matched when the file was saved",
    );
  });
});

/**
 * Weighting, as the file records it (PRD §5.6). Two different rules, and each
 * for a reason worth stating: the SWITCH is written out always, `false`
 * included, because it decides what the answer means; a WEIGHT is written only
 * where it says something, because 1 is the identity of a maximum rather than a
 * default that could be reinterpreted.
 */
describe('templateToFile and weighting', () => {
  const weighted = templateOf({
    weighted: true,
    criteria: [
      { id: 'k1', text: '1x monster', weight: 4 },
      { id: 'k2', text: '1x spell' },
    ],
  });

  it('writes the switch out in full, on or off', () => {
    expect(templateToFile(weighted, ctxFor(weighted)).template.weighted).toBe(true);
    const off = templateOf({ criteria: weighted.criteria });
    expect(templateToFile(off, ctxFor(off)).template.weighted).toBe(false);
  });

  it('writes a weight only where it is not 1', () => {
    const { template: file } = templateToFile(weighted, ctxFor(weighted));
    expect(file.criteria[0]!.weight).toBe(4);
    expect(file.criteria[1]).not.toHaveProperty('weight');
  });

  it('keeps the weights when the switch is off, so turning it back on restores them', () => {
    const off = templateOf({ weighted: false, criteria: weighted.criteria });
    const { template: file } = templateToFile(off, ctxFor(off));
    expect(file.weighted).toBe(false);
    expect(file.criteria[0]!.weight).toBe(4);
  });

  it('adds nothing but the switch to an unweighted template', () => {
    // The one new field, and no `weight` anywhere: a file of a template that
    // does not weight its criteria is the file it was, plus `"weighted": false`.
    const plain = templateOf({ criteria: [{ id: 'k1', text: '1x monster' }] });
    const { template: file } = templateToFile(plain, ctxFor(plain));
    expect(Object.keys(file).filter((key) => key === 'weighted')).toEqual(['weighted']);
    expect(file.criteria.every((criterion) => criterion.weight === undefined)).toBe(true);
  });

  it('reads back as itself, weights and all', () => {
    const { template: file } = templateToFile(weighted, ctxFor(weighted));
    const reread = validateTemplate(JSON.parse(JSON.stringify(file)));
    if (!reread.ok) throw new Error(reread.errors.join('\n'));
    expect(reread.template.weighted).toBe(true);
    expect(reread.template.criteria.map((criterion) => criterion.weight)).toEqual([4, undefined]);
  });
});
