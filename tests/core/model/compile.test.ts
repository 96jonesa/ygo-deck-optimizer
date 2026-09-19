import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  REMAINDER_ID,
  type ResolvedTemplate,
  resolveTemplate,
} from '../../../src/core/model/compile';
import type { Template, TemplateLine } from '../../../src/core/model/template';
import { CODE } from '../../helpers/fixture-cards';
import { motivatingContext, motivatingTemplate, ROTA, STRATOS } from '../../helpers/motivating';

const ctx = motivatingContext(await initSqlJs());

function templateOf(lines: TemplateLine[], criteria: string[], overrides: Partial<Template> = {}) {
  const template: Template = {
    version: 1,
    deckSize: 40,
    hand: { size: 5 },
    groups: [],
    lines,
    remainder: { min: 0, max: null },
    criteria: criteria.map((text, i) => ({ id: `c${i + 1}`, text })),
    ...overrides,
  };
  return template;
}

function resolved(template: Template): ResolvedTemplate {
  const result = resolveTemplate(template, ctx);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.resolved;
}

function errorsOf(template: Template): string[] {
  const result = resolveTemplate(template, ctx);
  return result.ok ? [] : result.errors;
}

/** The ids of the lines that fill the description written as `text` (canonical text). */
function fillersOf(r: ResolvedTemplate, text: string): string[] {
  const description = r.descriptions.find((d) => d.text === text);
  if (description === undefined)
    throw new Error(
      `no description ${text}; have: ${r.descriptions.map((d) => d.text).join(' | ')}`,
    );
  return description.lines.map((line) => r.lines[line]!.id);
}

const line = (id: string, text: string, min = 0, max = 3): TemplateLine => ({ id, text, min, max });

describe('resolveTemplate', () => {
  describe('the motivating example (PRD §4.2, §6.2)', () => {
    const r = resolved(motivatingTemplate());

    it('keeps the lines in order and puts the remainder last', () => {
      expect(r.lines.map((l) => l.id)).toEqual([
        'A',
        'B',
        'monster',
        'level4',
        'fire-bw',
        'spell',
        'normal-spell',
        REMAINDER_ID,
      ]);
      expect(r.lines.map((l) => l.isRemainder)).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(r.lines.at(-1)).toMatchObject({ text: 'card', echo: 'Any card', min: 0, max: null });
      expect(r.deckSize).toBe(40);
      expect(r.handSize).toBe(5);
    });

    it('finds the four distinct descriptions of the two criteria', () => {
      expect(r.descriptions.map((d) => d.text)).toEqual([
        `#${STRATOS}`,
        `#${ROTA}`,
        'monster',
        'level 4 or lower monster',
      ]);
      expect(r.descriptions.every((d) => d.inRequirement && !d.inLimit)).toBe(true);
    });

    it('does NOT let the `monster` line fill `level 4 or lower monster`: its Level is unstated', () => {
      expect(fillersOf(r, 'level 4 or lower monster')).not.toContain('monster');
      expect(fillersOf(r, 'level 4 or lower monster')).toEqual(['A', 'level4']);
    });

    it('lets a named Level 4 monster fill `monster` and `level 4 or lower monster`, unasked', () => {
      expect(fillersOf(r, 'monster')).toContain('A');
      expect(fillersOf(r, 'level 4 or lower monster')).toContain('A');
    });

    it('fills `monster` from every line known to be one', () => {
      expect(fillersOf(r, 'monster')).toEqual(['A', 'monster', 'level4', 'fire-bw']);
    });

    it("fills a requirement that names a card from that card's line only", () => {
      expect(fillersOf(r, `#${STRATOS}`)).toEqual(['A']);
      expect(fillersOf(r, `#${ROTA}`)).toEqual(['B']);
    });

    it('lets the remainder fill nothing', () => {
      expect(r.matrix.at(-1)).toEqual([false, false, false, false]);
    });

    it('lets `spell` and `normal spell` fill nothing: they are irrelevant to these criteria', () => {
      expect(r.matrix[5]).toEqual([false, false, false, false]);
      expect(r.matrix[6]).toEqual([false, false, false, false]);
    });

    it('has one matrix row per line and one column per description, agreeing with `lines`', () => {
      expect(r.matrix).toHaveLength(r.lines.length);
      for (const row of r.matrix) expect(row).toHaveLength(r.descriptions.length);
      r.descriptions.forEach((description, at) => {
        const fromMatrix = r.matrix.flatMap((row, i) => (row[at] ? [i] : []));
        expect(description.lines).toEqual(fromMatrix);
      });
    });

    it('echoes each line and counts its matches in the database', () => {
      expect(r.lines.map((l) => [l.text, l.echo, l.count])).toEqual([
        ['[Elemental HERO Stratos]', 'Elemental HERO Stratos', 1],
        ['[Reinforcement of the Army]', 'Reinforcement of the Army', 1],
        ['monster', 'Monster', ctx.cards.count((card) => (card.type & 0x1) !== 0)],
        [
          'level 4 monster',
          'Level 4 · Monster',
          ctx.cards.count((c) => c.level === 4 && (c.type & 0x1) !== 0),
        ],
        ['level 8 FIRE beast-warrior monster', 'Level 8 · FIRE · Beast-Warrior · Monster', 1],
        ['spell', 'Spell', ctx.cards.count((card) => (card.type & 0x2) !== 0)],
        // The stand-in for card B, and the fixture's Link Spell: a Spell with no sub-kind bit.
        ['normal spell', 'Normal Spell', 2],
        ['card', 'Any card', ctx.cards.count(() => true)],
      ]);
      expect(r.lines[3]!.count).toBeGreaterThan(1);
    });

    it('expands the two criteria into two flat alternatives of three slots', () => {
      expect(r.flat).toEqual([
        {
          reqs: [
            { n: 1, desc: 0 },
            { n: 1, desc: 1 },
            { n: 1, desc: 2 },
          ],
          limits: [],
        },
        {
          reqs: [
            { n: 1, desc: 0 },
            { n: 1, desc: 1 },
            { n: 1, desc: 3 },
          ],
          limits: [],
        },
      ]);
      expect(r.dropped).toBe(0);
      expect(r.criteria.map((c) => [c.id, c.name, c.canonical, c.alternatives])).toEqual([
        [
          'c1',
          'A, B and any monster',
          `1x #${STRATOS} and 1x #${ROTA} and 1x monster`,
          [r.flat[0]],
        ],
        [
          'c2',
          'A, B and a low-Level monster',
          `1x #${STRATOS} and 1x #${ROTA} and 1x level 4 or lower monster`,
          [r.flat[1]],
        ],
      ]);
      expect(r.warnings).toEqual([]);
    });
  });

  describe('lines', () => {
    it('rejects a generic line that matches no card: no Level 7 FIRE Beast-Warrior exists', () => {
      expect(
        errorsOf(templateOf([line('l1', 'level 7 FIRE beast-warrior monster')], ['1x monster'])),
      ).toEqual([
        'line "l1": `level 7 FIRE beast-warrior monster` matches no card in the database — check for a typo',
      ]);
    });

    it('names the line and carries the parser message when a description does not parse', () => {
      const errors = errorsOf(
        templateOf([line('ok', 'monster'), line('typo', 'level 4 monstr')], ['1x monster']),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^line "typo": /);
      expect(errors[0]).toMatch(/monster/); // the suggestion
      expect(errors[0]).toMatch(/\(at "monstr"\)$/);
    });

    it('reports every bad line and criterion, not just the first', () => {
      const errors = errorsOf(
        templateOf(
          [line('l1', 'monstr'), line('l2', '[No Such Card]')],
          ['1x monster', '1x', 'at most 1x trpa'],
        ),
      );
      expect(errors.map((e) => e.slice(0, e.indexOf(':')))).toEqual([
        'line "l1"',
        'line "l2"',
        'criterion "c2"',
        'criterion "c3"',
      ]);
    });

    it('resolves a picker-chosen card without parsing anything', () => {
      const r = resolved(
        templateOf(
          [
            {
              id: 'A',
              card: { passcode: STRATOS, name: 'whatever the file says' },
              min: 0,
              max: 3,
            },
          ],
          ['1x level 4 WIND Warrior monster'],
        ),
      );
      expect(r.lines[0]).toMatchObject({
        text: `#${STRATOS}`,
        echo: 'Elemental HERO Stratos',
        count: 1,
        desc: { anyOf: [{ t: 'card', passcode: STRATOS }] },
      });
      expect(r.matrix[0]).toEqual([true]);
    });

    it('warns, and does not fail, when a picker-chosen card is missing from the database', () => {
      const gone = { passcode: 12345, name: 'Card From Elsewhere' };
      const r = resolved(
        templateOf([{ id: 'gone', card: gone, min: 0, max: 3 }], [`1x #${STRATOS} or 1x monster`]),
      );
      expect(r.lines[0]).toMatchObject({ count: 0, echo: 'Unknown card #12345' });
      expect(r.matrix[0]).toEqual([false, false]);
      expect(r.warnings[0]).toMatch(
        /^line "gone": #12345 \(Card From Elsewhere\) is not in the card database/,
      );
    });

    it('caps a text line that names one card at three copies, but not a choice of cards', () => {
      expect(errorsOf(templateOf([line('A', `#${STRATOS}`, 0, 4)], ['1x monster']))).toEqual([
        'line "A": `max` is 4, but a deck holds at most 3 copies of one card',
      ]);
      expect(
        errorsOf(templateOf([line('AB', `#${STRATOS} or #${ROTA}`, 0, 6)], ['1x monster'])),
      ).toEqual([]);
    });

    it("carries the ranges through, the remainder's included", () => {
      const r = resolved(
        templateOf([line('m', 'monster', 5, 9)], ['1x monster'], {
          remainder: { min: 3, max: 20 },
        }),
      );
      expect(r.lines.map((l) => [l.min, l.max])).toEqual([
        [5, 9],
        [3, 20],
      ]);
    });

    // TODO(M2g): when the stored AST becomes authoritative this test flips.
    it('ignores a stored `desc` and parses the text', () => {
      const r = resolved(
        templateOf(
          [
            {
              id: 'm',
              text: 'monster',
              desc: { anyOf: [{ t: 'clause', clause: { kinds: ['trap'] } }] },
              min: 0,
              max: 3,
            },
          ],
          ['1x monster'],
        ),
      );
      expect(r.lines[0]!.desc).toEqual({
        anyOf: [{ t: 'clause', clause: { kinds: ['monster'] } }],
      });
      expect(r.matrix[0]).toEqual([true]);
    });
  });

  describe('groups', () => {
    const groups = [
      {
        id: 'g1',
        name: 'Starters',
        cards: [
          { passcode: STRATOS, name: 'Elemental HERO Stratos' },
          { passcode: CODE.tunerFairy, name: 'Synthetic Tuner Fairy' },
        ],
      },
    ];

    it('resolves {group} by name in lines and criteria, and judges it member by member', () => {
      const r = resolved(
        templateOf(
          [line('starters', '{starters}', 0, 6), line('A', `#${STRATOS}`), line('m', 'monster')],
          ['1x {Starters}', '1x level 4 or lower monster', '1x level 4 monster'],
          { groups },
        ),
      );
      expect(r.lines[0]).toMatchObject({ echo: 'Starters', count: 2 });
      // A card of the group line is one of the members, whichever: it fills what BOTH satisfy.
      expect(fillersOf(r, '{Starters}')).toEqual(['starters', 'A']);
      expect(fillersOf(r, 'level 4 or lower monster')).toEqual(['starters', 'A']);
      expect(fillersOf(r, 'level 4 monster')).toEqual(['A']);
    });

    it('rejects a group that is not in the template', () => {
      expect(
        errorsOf(templateOf([line('l', '{extenders}')], ['1x monster'], { groups }))[0],
      ).toMatch(/^line "l": /);
    });
  });

  describe('criteria', () => {
    const lines = [line('m', 'monster', 0, 9), line('s', 'spell', 0, 9), line('t', 'trap', 0, 9)];

    it('names the criterion and carries the parser message when it does not parse', () => {
      const errors = errorsOf(templateOf(lines, ['1x monster', '1x monster and']));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^criterion "c2": /);
    });

    it('expands nested `or`, sums repeated requirements, and indexes limits', () => {
      const r = resolved(
        templateOf(lines, [
          '1x monster and 1x monster and (1x spell or no trap)',
          '2x monster, 1x spell',
        ]),
      );
      expect(r.descriptions.map((d) => [d.text, d.inRequirement, d.inLimit])).toEqual([
        ['monster', true, false],
        ['spell', true, false],
        ['trap', false, true],
      ]);
      expect(r.criteria[0]!.alternatives).toEqual([
        {
          reqs: [
            { n: 2, desc: 0 },
            { n: 1, desc: 1 },
          ],
          limits: [],
        },
        { reqs: [{ n: 2, desc: 0 }], limits: [{ n: 0, desc: 2 }] },
      ]);
      // The second criterion repeats the first alternative: judged once.
      expect(r.criteria[1]!.alternatives).toEqual([r.criteria[0]!.alternatives[0]]);
      expect(r.flat).toEqual(r.criteria[0]!.alternatives);
    });

    it('counts the lines a limit counts, by the same relation', () => {
      const r = resolved(
        templateOf([...lines, line('ct', 'counter trap', 0, 3)], ['1x monster, at most 1x trap']),
      );
      expect(fillersOf(r, 'trap')).toEqual(['t', 'ct']);
    });

    it('lets the remainder fill a requirement for any card at all, and only that', () => {
      const r = resolved(templateOf(lines, ['1x card, 1x monster']));
      expect(fillersOf(r, 'card')).toEqual(['m', 's', 't', REMAINDER_ID]);
      expect(fillersOf(r, 'monster')).toEqual(['m']);
    });

    it('drops alternatives that need more cards than the hand, with a warning', () => {
      const r = resolved(templateOf(lines, ['6x monster or 1x spell']));
      expect(r.flat).toHaveLength(1);
      expect(r.dropped).toBe(1);
      expect(r.criteria[0]!.dropped).toBe(1);
      expect(r.warnings).toEqual([
        '1 alternative(s) need more than the 5 cards of a hand and can never be met',
      ]);
    });

    it('keeps a six-slot alternative at a hand of six', () => {
      const r = resolved(templateOf(lines, ['6x monster or 1x spell'], { hand: { size: 6 } }));
      expect(r.handSize).toBe(6);
      expect(r.flat).toHaveLength(2);
      expect(r.warnings).toEqual([]);
    });

    it('warns when nothing can ever succeed', () => {
      expect(resolved(templateOf(lines, [])).warnings).toEqual([
        'no criterion can ever be met: every hand fails',
      ]);
      expect(resolved(templateOf(lines, ['6x monster'])).warnings).toContain(
        'no criterion can ever be met: every hand fails',
      );
    });

    it('warns about a requirement no line fills', () => {
      const r = resolved(templateOf(lines, ['1x level 4 monster']));
      expect(r.warnings).toEqual(['no line fills the requirement `level 4 monster`']);
    });

    it('fails when the criteria expand past the cap', () => {
      // Nine two-way choices between distinct descriptions: 2^9 = 512 distinct alternatives.
      const choices = Array.from(
        { length: 9 },
        (_, i) => `(1x ATK ${2 * i} monster or 1x ATK ${2 * i + 1} monster)`,
      );
      const errors = errorsOf(templateOf(lines, [choices.join(' and ')], { hand: { size: 6 } }));
      expect(errors).toEqual([
        expect.stringMatching(
          /^criterion "c1": these criteria expand to more than 256 alternatives/,
        ),
      ]);
    });

    it('applies the cap to the criteria TOGETHER as well as one by one', () => {
      // Eight choices each: 256 alternatives apiece is allowed, 512 together is not.
      const criterion = (offset: number) =>
        Array.from(
          { length: 8 },
          (_, i) => `(1x ATK ${offset + 2 * i} monster or 1x ATK ${offset + 2 * i + 1} monster)`,
        ).join(' and ');
      expect(errorsOf(templateOf(lines, [criterion(0)], { hand: { size: 6 } }))).toEqual([]);
      expect(
        errorsOf(templateOf(lines, [criterion(0), criterion(100)], { hand: { size: 6 } })),
      ).toEqual([expect.stringMatching(/^these criteria expand to more than 256 alternatives/)]);
    });
  });
});
