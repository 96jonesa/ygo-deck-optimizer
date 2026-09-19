import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  type CompiledClassInfo,
  type CompileInput,
  type CompileResult,
  compileProblem,
  countRawRatios,
  expandClassVector,
  REMAINDER_ID,
  type ResolvedTemplate,
  resolveTemplate,
} from '../../../src/core/model/compile';
import { MAX_CLASSES, validateProblem } from '../../../src/core/model/problem';
import type { Template, TemplateLine } from '../../../src/core/model/template';
import { createBlendScorer, createScorer } from '../../../src/core/prob/scorer';
import { same } from '../../helpers/assert';
import { CODE } from '../../helpers/fixture-cards';
import {
  genRangedProblem,
  lineIdOf,
  type RangedProblem,
  rawRatiosOf,
} from '../../helpers/gen-ranged-problem';
import { motivatingContext, motivatingTemplate, ROTA, STRATOS } from '../../helpers/motivating';
import { seededRng } from '../../helpers/prng';
import { problemFromMatrix } from '../../helpers/problem-from-matrix';

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

// ---------------------------------------------------------------------------
// compileProblem, expandClassVector, countRawRatios
// ---------------------------------------------------------------------------

type Flat = CompileInput['flat'];

/** A line and its match matrix row, written `'101'`: fills columns 0 and 2. */
interface Row {
  id: string;
  row: string;
  min?: number;
  max?: number;
}

const bits = (row: string): boolean[] => [...row].map((bit) => bit === '1');

/** A `CompileInput` written by hand: the lines, then the remainder's row and range. */
function inputOf(
  rows: readonly Row[],
  flat: Flat,
  remainder: { row?: string; min?: number; max?: number | null } = {},
  overrides: Partial<CompileInput> = {},
): CompileInput {
  const columns = rows[0]?.row.length ?? remainder.row?.length ?? 0;
  return {
    deckSize: 40,
    handSize: 5,
    lines: [
      ...rows.map(({ id, min = 0, max = 3 }) => ({ id, isRemainder: false, min, max })),
      {
        id: REMAINDER_ID,
        isRemainder: true,
        min: remainder.min ?? 0,
        max: remainder.max === undefined ? null : remainder.max,
      },
    ],
    matrix: [...rows.map(({ row }) => bits(row)), bits(remainder.row ?? '0'.repeat(columns))],
    flat,
    ...overrides,
  };
}

type Compiled = Extract<CompileResult, { ok: true }>;

function compiled(input: CompileInput, opts?: Parameters<typeof compileProblem>[1]): Compiled {
  const result = compileProblem(input, opts);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result;
}

/** `[['remainder', 's'], ['a'], …]`: the member lines of each class, blank first. */
const membersOf = ({ classes }: Compiled): string[][] =>
  classes.map((cls) => cls.lines.map((member) => member.id));

const rangesOf = ({ classes }: Compiled): [number, number][] =>
  classes.map(({ min, max }) => [min, max]);

const req = (desc: number, n = 1) => ({ n, desc });

describe('compileProblem', () => {
  describe('the motivating example (TDD §11.1, oracle C3)', () => {
    const c = compiled(resolved(motivatingTemplate()));

    it('compiles to exactly the five classes the criteria can tell apart', () => {
      expect(membersOf(c)).toEqual([
        ['spell', 'normal-spell', REMAINDER_ID],
        ['A'],
        ['B'],
        ['monster', 'fire-bw'],
        ['level4'],
      ]);
    });

    it('sums the ranges of merged lines, the unbounded remainder clamped to the deck', () => {
      expect(rangesOf(c)).toEqual([
        [0, 7 + 3 + 40],
        [0, 3],
        [0, 3],
        [5, 8],
        [2, 3],
      ]);
    });

    it('turns the requirements into class masks; the blank bit is in none', () => {
      const [blank, A, B, merged, level4] = [1, 2, 4, 8, 16];
      expect(c.problem.criteria).toEqual([
        { slots: [A, B, A | merged | level4], limits: [] },
        { slots: [A, B, A | level4], limits: [] },
      ]);
      for (const { slots } of c.problem.criteria)
        for (const mask of slots) expect(mask & blank).toBe(0);
    });

    it('scores 46185/658008 with every line at its maximum', () => {
      expect(createScorer(c.problem, 5).score([23, 3, 3, 8, 3])).toEqual({
        num: 46185,
        den: 658008,
      });
    });

    it('maps every line, the remainder last, to its class', () => {
      expect(c.classOfLine).toEqual([1, 2, 3, 4, 3, 0, 0, 0]);
    });

    it('judges at the hand size of the template unless told otherwise', () => {
      expect(c.problem.handSizes).toEqual([{ H: 5, weight: 1 }]);
      expect(c.problem.deckSize).toBe(40);
    });
  });

  describe('classes', () => {
    const flat: Flat = [{ reqs: [req(0), req(1)], limits: [] }];

    it('merges lines with identical rows, and only those', () => {
      const c = compiled(
        inputOf(
          [
            { id: 'a', row: '10', min: 1, max: 2 },
            { id: 'b', row: '01' },
            { id: 'c', row: '10', min: 2, max: 5 },
            { id: 'd', row: '11' },
          ],
          flat,
        ),
      );
      expect(membersOf(c)).toEqual([[REMAINDER_ID], ['a', 'c'], ['b'], ['d']]);
      expect(rangesOf(c)[1]).toEqual([3, 7]);
      expect(c.classes[1]!.lines).toEqual([
        { id: 'a', line: 0, min: 1, max: 2 },
        { id: 'c', line: 2, min: 2, max: 5 },
      ]);
    });

    it('orders classes by their first line, in template order, after the blank class', () => {
      const c = compiled(
        inputOf(
          [
            { id: 'z', row: '01' },
            { id: 'idle', row: '00' },
            { id: 'y', row: '10' },
            { id: 'x', row: '01' },
          ],
          flat,
        ),
      );
      expect(membersOf(c)).toEqual([['idle', REMAINDER_ID], ['z', 'x'], ['y']]);
      expect(c.classOfLine).toEqual([1, 0, 2, 1, 0]);
    });

    it('sends every all-false line to the blank class, with the remainder', () => {
      const c = compiled(
        inputOf(
          [
            { id: 'a', row: '10' },
            { id: 'idle', row: '00', min: 2, max: 4 },
          ],
          flat,
          { min: 5, max: 30 },
        ),
      );
      expect(membersOf(c)).toEqual([['idle', REMAINDER_ID], ['a']]);
      expect(rangesOf(c)[0]).toEqual([7, 34]);
      expect(c.problem.classes[0]).toEqual({ lineIds: ['idle', REMAINDER_ID], min: 7, max: 34 });
    });

    it('does NOT force the remainder into the blank class: it fills `1x card`', () => {
      const c = compiled(inputOf([{ id: 'a', row: '11' }], flat, { row: '01', min: 0, max: null }));
      // The blank class is there, at index 0, and holds nothing.
      expect(membersOf(c)).toEqual([[], ['a'], [REMAINDER_ID]]);
      expect(rangesOf(c)).toEqual([
        [0, 0],
        [0, 3],
        [0, 40],
      ]);
      expect(c.problem.criteria[0]!.slots).toEqual([0b010, 0b110]);
      expect(c.classOfLine).toEqual([1, 2]);
    });

    it('merges the remainder with a line that has its row', () => {
      const c = compiled(
        inputOf(
          [
            { id: 'a', row: '11' },
            { id: 'any', row: '01', min: 1, max: 4 },
          ],
          flat,
          { row: '01', min: 2, max: 10 },
        ),
      );
      expect(membersOf(c)).toEqual([[], ['a'], ['any', REMAINDER_ID]]);
      expect(rangesOf(c)[2]).toEqual([3, 14]);
    });

    it('compiles the real thing: the remainder fills `1x card` of a resolved template', () => {
      const c = compiled(
        resolved(templateOf([line('m', 'monster'), line('s', 'spell')], ['1x card, 1x monster'])),
      );
      expect(membersOf(c)).toEqual([[], ['m'], ['s', REMAINDER_ID]]);
    });

    it('keeps a bounded remainder as it is, and clamps only `max: null`', () => {
      const bounded = compiled(inputOf([{ id: 'a', row: '10' }], flat, { min: 3, max: 50 }));
      expect(rangesOf(bounded)[0]).toEqual([3, 50]);
      const open = compiled(
        inputOf([{ id: 'a', row: '10' }], flat, { min: 3, max: null }, { deckSize: 47 }),
      );
      expect(rangesOf(open)[0]).toEqual([3, 47]);
    });

    it('keeps the range well-formed when an unbounded remainder must exceed the deck', () => {
      const c = compiled(inputOf([{ id: 'a', row: '10' }], flat, { min: 41, max: null }));
      expect(rangesOf(c)[0]).toEqual([41, 41]);
    });

    it('hands the engine a valid problem, its classes matching the detailed ones', () => {
      const c = compiled(
        inputOf(
          [
            { id: 'a', row: '10' },
            { id: 'b', row: '10' },
          ],
          flat,
        ),
      );
      expect(() => validateProblem(c.problem)).not.toThrow();
      expect(c.problem.classes).toEqual(
        c.classes.map(({ lines, min, max }) => ({ lineIds: lines.map((l) => l.id), min, max })),
      );
      expect(c.classes.map((cls) => cls.fills)).toEqual([[], [0]]);
    });

    it('refuses more than 30 classes, the blank class included, naming the count', () => {
      // 30 lines with pairwise different rows over 5 columns, none all-false: 31 classes.
      const rows = Array.from({ length: MAX_CLASSES }, (_, i) => ({
        id: `l${i}`,
        row: (i + 1).toString(2).padStart(5, '0'),
      }));
      const wide: Flat = [{ reqs: [0, 1, 2, 3, 4].map((desc) => req(desc)), limits: [] }];
      const result = compileProblem(inputOf(rows, wide));
      expect(result).toEqual({
        ok: false,
        errors: [expect.stringMatching(/31 classes.*at most 30/)],
      });
      // One fewer is fine.
      expect(compileProblem(inputOf(rows.slice(1), wide)).ok).toBe(true);
    });

    it('rejects a line whose range is not 0 <= min <= max, naming it', () => {
      const result = compileProblem(inputOf([{ id: 'a', row: '10', min: 3, max: 2 }], flat));
      expect(result).toEqual({ ok: false, errors: [expect.stringMatching(/line "a".*3.*2/)] });
    });
  });

  describe('slots and limits', () => {
    const rows: Row[] = [
      { id: 'a', row: '100' },
      { id: 'b', row: '110' },
      { id: 'idle', row: '000' },
    ];

    it('expands n× into n slots of the same mask', () => {
      const c = compiled(inputOf(rows, [{ reqs: [req(0, 3), req(1)], limits: [] }]));
      expect(c.problem.criteria).toEqual([{ slots: [0b110, 0b110, 0b110, 0b100], limits: [] }]);
    });

    it('keeps a slot no line fills: the criterion can then never be met', () => {
      const c = compiled(inputOf(rows, [{ reqs: [req(2)], limits: [] }]));
      expect(c.problem.criteria).toEqual([{ slots: [0], limits: [] }]);
    });

    it('turns a limit into the mask of the classes it counts', () => {
      const c = compiled(inputOf(rows, [{ reqs: [req(0)], limits: [{ n: 1, desc: 1 }] }]));
      expect(c.problem.criteria).toEqual([{ slots: [0b110], limits: [{ mask: 0b100, n: 1 }] }]);
      expect(c.droppedLimits).toEqual([]);
    });

    it('DROPS a limit that counts nothing — it always holds — and says so', () => {
      const c = compiled(
        inputOf(rows, [
          {
            reqs: [req(0)],
            limits: [
              { n: 0, desc: 2 },
              { n: 1, desc: 1 },
            ],
          },
        ]),
      );
      expect(c.problem.criteria[0]!.limits).toEqual([{ mask: 0b100, n: 1 }]);
      expect(c.droppedLimits).toEqual([{ criterion: 0, desc: 2, n: 0, reason: 'counts-nothing' }]);
    });

    it('DROPS a limit no hand can break (n >= the largest hand) and says so', () => {
      const flat: Flat = [
        {
          reqs: [req(0)],
          limits: [
            { n: 5, desc: 0 },
            { n: 4, desc: 0 },
          ],
        },
      ];
      const c = compiled(inputOf(rows, flat));
      expect(c.problem.criteria[0]!.limits).toEqual([{ mask: 0b110, n: 4 }]);
      expect(c.droppedLimits).toEqual([{ criterion: 0, desc: 0, n: 5, reason: 'never-binds' }]);
      // At a hand of six, five can be exceeded.
      const six = compiled(inputOf(rows, flat, {}, { handSize: 6 }));
      expect(six.problem.criteria[0]!.limits).toEqual([
        { mask: 0b110, n: 5 },
        { mask: 0b110, n: 4 },
      ]);
    });
  });

  describe('hand sizes', () => {
    const flat: Flat = [{ reqs: [req(0)], limits: [] }];
    const rows: Row[] = [{ id: 'a', row: '1' }];

    it('takes a first/second blend', () => {
      const blend = [
        { H: 5, weight: 3 },
        { H: 6, weight: 2 },
      ];
      const c = compiled(inputOf(rows, flat, {}, { handSize: 6 }), { handSizes: blend });
      expect(c.problem.handSizes).toEqual(blend);
      expect(() => createBlendScorer(c.problem)).not.toThrow();
    });

    it('refuses a hand larger than the one the criteria were expanded for', () => {
      // Alternatives of six slots were dropped when resolving at five.
      const result = compileProblem(inputOf(rows, flat), { handSizes: [{ H: 6, weight: 1 }] });
      expect(result).toEqual({
        ok: false,
        errors: [expect.stringMatching(/hand of 6.*expanded for a hand of 5/)],
      });
    });

    it('reports what `validateProblem` finds, as an error and not a throw', () => {
      const result = compileProblem(inputOf(rows, flat), { handSizes: [{ H: 5, weight: 0.5 }] });
      expect(result).toEqual({ ok: false, errors: [expect.stringMatching(/weight/)] });
    });
  });
});

describe('expandClassVector', () => {
  const flat: Flat = [{ reqs: [req(0), req(1)], limits: [] }];
  const c = compiled(
    inputOf(
      [
        { id: 'a', row: '10', min: 1, max: 2 },
        { id: 'b', row: '01', min: 0, max: 3 },
        { id: 'c', row: '10', min: 2, max: 5 },
        { id: 'd', row: '10', min: 0, max: 1 },
      ],
      flat,
      { min: 30, max: null },
    ),
  );

  it('states the count of a single-line class', () => {
    const [blank, merged, b] = expandClassVector(c.classes, [32, 5, 3]);
    expect(blank).toEqual({
      cls: 0,
      total: 32,
      splits: 1,
      lines: [{ id: REMAINDER_ID, min: 32, max: 32 }],
      text: '32 copies of `remainder`',
    });
    expect(b).toMatchObject({ cls: 2, total: 3, splits: 1, text: '3 copies of `b`' });
    expect(merged!.cls).toBe(1);
  });

  it('gives a merged class as "any split", with the interval each line can take', () => {
    // a in 1-2, c in 2-5, d in 0-1, totalling 4: a + c + d = 4.
    const [, merged] = expandClassVector(c.classes, [33, 4, 3]);
    expect(merged).toEqual({
      cls: 1,
      total: 4,
      // (1,2,1) (1,3,0) (2,2,0)
      splits: 3,
      lines: [
        { id: 'a', min: 1, max: 2 },
        { id: 'c', min: 2, max: 3 },
        { id: 'd', min: 0, max: 1 },
      ],
      text: '4 copies among `a`, `c`, `d` — any split',
    });
  });

  it('pins every line at the ends of the class range', () => {
    const [, least] = expandClassVector(c.classes, [37, 3, 0]);
    expect(least).toMatchObject({
      splits: 1,
      lines: [
        { id: 'a', min: 1, max: 1 },
        { id: 'c', min: 2, max: 2 },
        { id: 'd', min: 0, max: 0 },
      ],
    });
    const [, most] = expandClassVector(c.classes, [32, 8, 0]);
    expect(most).toMatchObject({
      splits: 1,
      lines: [
        { id: 'a', min: 2, max: 2 },
        { id: 'c', min: 5, max: 5 },
        { id: 'd', min: 1, max: 1 },
      ],
    });
  });

  it('says "1 copy", and that an empty blank class holds nothing', () => {
    const open = compiled(inputOf([{ id: 'a', row: '11' }], flat, { row: '01' }));
    const [blank, a] = expandClassVector(open.classes, [0, 1, 39]);
    expect(a!.text).toBe('1 copy of `a`');
    expect(blank).toEqual({ cls: 0, total: 0, splits: 1, lines: [], text: 'no cards' });
  });

  it('gives a total outside the class range no split at all', () => {
    const [, merged] = expandClassVector(c.classes, [31, 9, 0]);
    expect(merged).toEqual({
      cls: 1,
      total: 9,
      splits: 0,
      lines: [],
      text: '9 copies among `a`, `c`, `d` — outside the range 3–8',
    });
  });

  it('wants one total per class', () => {
    expect(() => expandClassVector(c.classes, [40, 0])).toThrow(RangeError);
  });
});

describe('countRawRatios', () => {
  const flat: Flat = [{ reqs: [req(0), req(1)], limits: [] }];
  const c = compiled(
    inputOf(
      [
        { id: 'a', row: '10', min: 1, max: 2 },
        { id: 'b', row: '01', min: 0, max: 3 },
        { id: 'c', row: '10', min: 2, max: 5 },
        { id: 'idle', row: '00', min: 0, max: 2 },
      ],
      flat,
      { min: 30, max: null },
    ),
  );

  it('multiplies the ways to split each class total among its lines', () => {
    // {a, c} = 4: (1,3) (2,2). Blank {idle, remainder} = 33: idle 0, 1 or 2.
    expect(countRawRatios(c.classes, [33, 4, 3])).toBe(2 * 3);
    // Blank 30: the remainder's minimum leaves idle 0 only.
    expect(countRawRatios(c.classes, [30, 7, 3])).toBe(1);
  });

  it('is 0 for a class total outside its range', () => {
    expect(countRawRatios(c.classes, [29, 8, 3])).toBe(0);
    expect(countRawRatios(c.classes, [35, 2, 3])).toBe(0);
  });

  it('does not ask the totals to fill the deck: that is the caller’s vector', () => {
    expect(countRawRatios(c.classes, [31, 3, 0])).toBe(2);
  });

  it('wants one total per class', () => {
    expect(() => countRawRatios(c.classes, [40])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Oracles over generated templates-as-match-problems with line ranges. The
// reference is the UNMERGED problem of tests/helpers/problem-from-matrix.ts —
// every line its own class — and plain listing of every raw ratio.
// ---------------------------------------------------------------------------

const RANGED_PROBLEMS = 400;

function rangedProblems(): RangedProblem[] {
  return Array.from({ length: RANGED_PROBLEMS }, (_, i) => genRangedProblem(seededRng(52_000 + i)));
}

/** Class totals of a raw ratio, by the `classOfLine` map: the remainder is the last line. */
function classTotalsOf(c: Compiled, counts: readonly number[], deckSize: number): number[] {
  const totals = new Array<number>(c.classes.length).fill(0);
  const remainder = deckSize - counts.reduce((sum, n) => sum + n, 0);
  [...counts, remainder].forEach((n, line) => {
    totals[c.classOfLine[line]!]! += n;
  });
  return totals;
}

describe('class merging never changes a numerator (oracle C1)', () => {
  it('scores every raw ratio of 400 generated templates exactly as the unmerged problem does', () => {
    let ratios = 0;
    let merges = 0;
    const seen = { identicalRows: 0, allFalseRow: 0, remainderFills: 0, emptyBlank: 0 };
    for (const ranged of rangedProblems()) {
      const { input, ranges, remainder, generated, features } = ranged;
      for (const feature of Object.keys(seen) as (keyof typeof seen)[])
        if (features[feature]) seen[feature]++;
      const H = generated.handSize;
      const c = compiled(input);
      if (c.classes.slice(1).some((cls) => cls.lines.length > 1)) merges++;
      const merged = createScorer(c.problem, H);
      const reference = problemFromMatrix(generated.problem, [H]);
      const unmerged = createScorer(reference.problem, H);
      same(merged.den, unmerged.den, () => input);

      for (const counts of rawRatiosOf(ranges, remainder, input.deckSize)) {
        const totals = classTotalsOf(c, counts, input.deckSize);
        same(merged.numerator(totals), unmerged.numerator(reference.totals(counts)), () => ({
          input,
          counts,
          totals,
        }));
        // Every valid raw ratio lands inside the class ranges.
        c.classes.forEach(({ min, max }, cls) => {
          if (totals[cls]! < min || totals[cls]! > max)
            throw new Error(`class ${cls} total ${totals[cls]} outside ${min}-${max}`);
        });
        ratios++;
      }
    }
    // The shapes that merging turns on were all generated, and often.
    // (`merges` counts templates in which a NON-blank class holds several lines.)
    expect(seen.identicalRows).toBeGreaterThanOrEqual(300);
    expect(seen.allFalseRow).toBeGreaterThanOrEqual(200);
    expect(seen.remainderFills).toBeGreaterThanOrEqual(90);
    expect(seen.emptyBlank).toBeGreaterThanOrEqual(60);
    expect(merges).toBeGreaterThanOrEqual(200);
    expect(ratios).toBeGreaterThanOrEqual(7_000);
  });

  it('builds each class from the lines with its row: ranges summed, masks by row', () => {
    for (const { input } of rangedProblems()) {
      const c = compiled(input);
      const key = (line: number) => input.matrix[line]!.map((f) => (f ? 1 : 0)).join('');
      input.lines.forEach((_, line) => {
        const cls = c.classOfLine[line]!;
        // The blank class is exactly the all-false rows.
        same(cls === 0, !key(line).includes('1'), () => ({ input, line }));
        input.lines.forEach((__, other) => {
          same(c.classOfLine[other] === cls, key(other) === key(line), () => ({
            input,
            line,
            other,
          }));
        });
      });
      c.classes.forEach((cls, index) => {
        const members = input.lines.filter((_, line) => c.classOfLine[line] === index);
        expect(cls.lines.map((l) => l.id)).toEqual(members.map((l) => l.id));
        expect(cls.min).toBe(members.reduce((sum, l) => sum + l.min, 0));
        expect(cls.max).toBe(members.reduce((sum, l) => sum + (l.max ?? input.deckSize), 0));
      });
    }
  });
});

describe('the raw ratios behind a class vector (oracle C2)', () => {
  it('counts, and bounds line by line, exactly the raw ratios that map to each vector', () => {
    let vectors = 0;
    for (const { input, ranges, remainder } of rangedProblems()) {
      const c = compiled(input);
      // Group every valid raw ratio — the remainder included — by its class vector.
      const byVector = new Map<string, number[][]>();
      for (const counts of rawRatiosOf(ranges, remainder, input.deckSize)) {
        const key = classTotalsOf(c, counts, input.deckSize).join(',');
        const left = input.deckSize - counts.reduce((sum, n) => sum + n, 0);
        byVector.set(key, [...(byVector.get(key) ?? []), [...counts, left]]);
      }

      // Every class vector: a total within each class range, filling the deck.
      let total = 0;
      const visit = (totals: number[], used: number): void => {
        if (totals.length === c.classes.length) {
          if (used !== input.deckSize) return;
          const behind = byVector.get(totals.join(',')) ?? [];
          same(countRawRatios(c.classes, totals), behind.length, () => ({ input, totals }));
          // A class range is a sum of intervals: every total in it can be split.
          if (behind.length === 0) throw new Error(`no raw ratio behind ${totals.join(',')}`);
          total += behind.length;
          vectors++;

          const expanded = expandClassVector(c.classes, totals);
          let product = 1;
          for (const { lines, splits } of expanded) {
            product *= splits as number;
            for (const { id, min, max } of lines) {
              const line = input.lines.findIndex((l) => l.id === id);
              const taken = new Set(behind.map((ratio) => ratio[line]!));
              // The interval is exactly the counts the line takes: no gaps, nothing beyond.
              same(Math.min(...taken), min, () => ({ input, totals, id }));
              same(Math.max(...taken), max, () => ({ input, totals, id }));
              same(taken.size, max - min + 1, () => ({ input, totals, id }));
            }
          }
          same(product, behind.length, () => ({ input, totals }));
          return;
        }
        const { min, max } = c.classes[totals.length]!;
        for (let t = min; t <= Math.min(max, input.deckSize - used); t++)
          visit([...totals, t], used + t);
      };
      visit([], 0);
      // Σ over class vectors of countRawRatios = the brute-force count of valid raw ratios.
      same(total, rawRatiosOf(ranges, remainder, input.deckSize).length, () => input);
    }
    expect(vectors).toBeGreaterThanOrEqual(3_500);
  });

  it('names lines by the ids the template gave them', () => {
    const [ranged] = rangedProblems();
    const c = compiled(ranged!.input);
    const ids = c.classes.flatMap((cls: CompiledClassInfo) => cls.lines.map((l) => l.id));
    expect([...ids].sort()).toEqual(
      [...ranged!.ranges.map((_, line) => lineIdOf(line)), REMAINDER_ID].sort(),
    );
  });
});
