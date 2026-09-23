import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import type { Expr } from '../../../src/core/criteria/ast';
import { printCriterion } from '../../../src/core/criteria/print';
import { canonicalize, type Description } from '../../../src/core/desc/ast';
import { implies } from '../../../src/core/desc/implies';
import { parse } from '../../../src/core/desc/parser';
import {
  type CompiledClassInfo,
  type CompileInput,
  type CompileResult,
  compileProblem,
  countRawRatios,
  expandClassVector,
  groupLookupOf,
  groupMembersOf,
  handSizesForMode,
  lineInterval,
  REMAINDER_ID,
  type ResolvedTemplate,
  resolveTemplate,
  soleCard,
} from '../../../src/core/model/compile';
import { type DrawSpec, MAX_CLASSES, validateProblem } from '../../../src/core/model/problem';
import {
  type Template,
  type TemplateLine,
  validateTemplate,
} from '../../../src/core/model/template';
import { handSucceeds } from '../../../src/core/prob/matcher';
import { createBlendScorer, createScorer, scoreBlend } from '../../../src/core/prob/scorer';
import { same } from '../../helpers/assert';
import { cardLevelNumerator } from '../../helpers/card-oracle';
import { choose } from '../../helpers/combinatorics';
import { fieldsOf } from '../../helpers/fields';
import { CODE } from '../../helpers/fixture-cards';
import { genExpr } from '../../helpers/gen-criteria';
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
    version: 2,
    deckSize: 40,
    hand: { size: 5 },
    groups: [],
    lines,
    remainder: { min: 0, max: null },
    criteria: criteria.map((text, i) => ({ id: `c${i + 1}`, ...fieldsOf(text) })),
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
        // The originator's line, verbatim. No such card exists, in the fixture or in reality;
        // a generic line does not need one (PRD §5.1).
        ['level 7 FIRE beast-warrior monster', 'Level 7 · FIRE · Beast-Warrior · Monster', 0],
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
    it('accepts a generic line that matches no card: no Level 7 FIRE Beast-Warrior exists, and none need to', () => {
      const result = resolveTemplate(
        templateOf([line('l1', 'level 7 FIRE beast-warrior monster')], ['1x monster']),
        ctx,
      );
      if (!result.ok) throw new Error(result.errors.join('; '));
      const [l1] = result.resolved.lines;
      expect(l1).toMatchObject({ id: 'l1', count: 0 });
      // Known to be a monster, so it fills `1x monster` like any other monster line.
      expect(result.resolved.descriptions.find((d) => d.text === 'monster')?.lines).toContain(0);
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

    it('lets a line that names one card hold more than three copies (PRD §5.1)', () => {
      expect(errorsOf(templateOf([line('A', `#${STRATOS}`, 0, 4)], ['1x monster']))).toEqual([]);
      expect(
        errorsOf(templateOf([line('AB', `#${STRATOS} or #${ROTA}`, 0, 6)], ['1x monster'])),
      ).toEqual([]);
    });

    /**
     * Accepted is not the same as SEARCHED. A cap left anywhere between the template
     * and the optimizer would narrow the class's RANGE, and the optimizer would then
     * never try a fourth copy — while the scorer, which scores whatever vector it is
     * handed, would go on answering correctly for four. So the range is the thing
     * pinned here; the score only confirms what four copies are worth:
     * `1 − C(36,5)/C(40,5)` = 281,016 / 658,008, where three would be 222,111.
     */
    it('carries a named card past three copies into the class range the optimizer searches', () => {
      const c = compiled(
        resolved(templateOf([line('A', `#${STRATOS}`, 4, 4)], [`1x #${STRATOS}`])),
      );
      expect(membersOf(c)).toEqual([[REMAINDER_ID], ['A']]);
      expect(rangesOf(c)).toEqual([
        [0, 40],
        [4, 4],
      ]);
      expect(createScorer(c.problem, 5).score([36, 4])).toEqual({
        num: 281016,
        den: 658008,
        successNum: 281016,
      });
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

    // The other half of the pair this test used to guard: the stored AST is
    // authoritative (TDD §14), so a file still MEANS what it meant however the
    // text beside it now reads — and the mismatch is said, not swallowed. The
    // editor drops a stale AST on every text edit (`withLineText`), so this
    // case only arises for a file, never for something being typed.
    it('means the stored `desc`, not the text, and warns that the two disagree', () => {
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
        anyOf: [{ t: 'clause', clause: { kinds: ['trap'] } }],
      });
      expect(r.matrix[0]).toEqual([false]);
      expect(r.warnings).toContain(
        'line "m": this line means the saved description `trap`; the text beside it now reads as `monster`. Editing the text replaces the saved one.',
      );
    });

    it('means the stored `desc` when the text no longer parses, rather than failing the line', () => {
      const r = resolved(
        templateOf(
          [
            {
              id: 'm',
              text: 'monstr',
              desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'] } }] },
              min: 0,
              max: 3,
            },
          ],
          ['1x monster'],
        ),
      );
      expect(r.matrix[0]).toEqual([true]);
      expect(r.warnings.some((w) => w.includes('no longer parses'))).toBe(true);
    });

    it('means the stored `expr` of a criterion, and warns the same way', () => {
      const r = resolved({
        ...templateOf([{ id: 'm', text: 'monster', min: 0, max: 3 }], []),
        criteria: [
          {
            id: 'c1',
            text: '1x trap',
            expr: {
              op: 'req',
              n: 1,
              desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'] } }] },
            },
          },
        ],
      });
      expect(r.descriptions.map((d) => d.text)).toEqual(['monster']);
      expect(r.warnings).toContain(
        'criterion "c1": this criterion means the saved expression `1x monster`; the text beside it now reads as `1x trap`. Editing the text replaces the saved one.',
      );
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
        successNum: 46185,
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

  // The construct as Andy asked for it, from the text he wrote, through the
  // whole stack: parse, expand, compile, judge. Stratos stands in for Ash — a
  // named card that is itself a monster — and the Beast-Warrior for the others.
  describe('`1x [name], 1-2x monster` end to end', () => {
    const template = templateOf(
      [
        { id: 'named', text: `#${STRATOS}`, min: 1, max: 3 },
        { id: 'monsters', text: 'Beast-Warrior monster', min: 0, max: 6 },
        { id: 'spells', text: 'spell', min: 0, max: 6 },
      ],
      ['1x [Elemental HERO Stratos], 1-2x monster'],
    );

    it('reads the criterion as written and keeps the ceiling', () => {
      const r = resolved(template);
      expect(r.criteria[0]!.canonical).toBe('1x #40044918 and 1-2x monster');
      expect(r.criteria[0]!.alternatives[0]!.reqs).toEqual([
        { n: 1, desc: 0 },
        { n: 1, max: 2, desc: 1 },
      ]);
    });

    /** Whether a hand of these lines succeeds, as class totals over the compiled problem. */
    function judges(lines: string[]): boolean {
      const r = resolved(template);
      const c = compileProblem(r);
      if (!c.ok) throw new Error(c.errors.join('\n'));
      const h = new Array<number>(c.problem.classes.length).fill(0);
      for (const id of lines) {
        const at = r.lines.findIndex((l) => l.id === id);
        h[c.classOfLine[at]!]!++;
      }
      return handSucceeds(c.problem, h, lines.length);
    }

    const NAMED = 'named';
    const MON = 'monsters';
    const SPELL = 'spells';

    it('passes Stratos, monster, monster', () => {
      expect(judges([NAMED, MON, MON])).toBe(true);
    });

    it('fails Stratos, monster, monster, monster: the fourth cannot be left unassigned', () => {
      expect(judges([NAMED, MON, MON, MON])).toBe(false);
    });

    it('fails Stratos, spell, spell: nothing is left for the range', () => {
      expect(judges([NAMED, SPELL, SPELL])).toBe(false);
    });

    it('passes Stratos, Stratos, monster: the second copy counts toward the range', () => {
      expect(judges([NAMED, NAMED, MON])).toBe(true);
    });

    it('fails monster, monster: the named requirement is unfilled', () => {
      expect(judges([MON, MON])).toBe(false);
    });
  });

  describe('range requirements', () => {
    const rows: Row[] = [
      { id: 'a', row: '100' },
      { id: 'b', row: '110' },
      { id: 'idle', row: '000' },
    ];

    it('keeps the whole requirement list beside the slots when a ceiling can bind', () => {
      const c = compiled(
        inputOf(rows, [{ reqs: [{ n: 1, max: 2, desc: 0 }, req(1)], limits: [] }]),
      );
      expect(c.problem.criteria).toEqual([
        {
          slots: [0b110, 0b100],
          limits: [],
          reqs: [
            { mask: 0b110, min: 1, max: 2 },
            { mask: 0b100, min: 1, max: null },
          ],
        },
      ]);
      expect(c.droppedCeilings).toEqual([]);
    });

    it('leaves the requirement list out when no ceiling survives', () => {
      const c = compiled(inputOf(rows, [{ reqs: [req(0), req(1)], limits: [] }]));
      expect(c.problem.criteria).toEqual([{ slots: [0b110, 0b100], limits: [] }]);
    });

    it('DROPS a ceiling no hand can exceed (max >= the largest hand) and says so', () => {
      const flat: Flat = [{ reqs: [{ n: 1, max: 5, desc: 0 }], limits: [] }];
      const c = compiled(inputOf(rows, flat));
      // The requirement stays; only its ceiling goes, making it a plain `1x`.
      expect(c.problem.criteria).toEqual([{ slots: [0b110], limits: [] }]);
      expect(c.droppedCeilings).toEqual([
        { criterion: 0, desc: 0, n: 1, max: 5, reason: 'never-binds' },
      ]);
      // At a hand of six, five can be exceeded and the ceiling is kept.
      const six = compiled(inputOf(rows, flat, {}, { handSize: 6 }));
      expect(six.problem.criteria[0]!.reqs).toEqual([{ mask: 0b110, min: 1, max: 5 }]);
      expect(six.droppedCeilings).toEqual([]);
    });

    it('DROPS a ceiling no line can reach and says so', () => {
      const c = compiled(
        inputOf(rows, [{ reqs: [{ n: 0, max: 1, desc: 2 }, req(0)], limits: [] }]),
      );
      expect(c.problem.criteria).toEqual([{ slots: [0b110], limits: [] }]);
      expect(c.droppedCeilings).toEqual([
        { criterion: 0, desc: 2, n: 0, max: 1, reason: 'counts-nothing' },
      ]);
    });

    it('puts a dropped ceiling back among the unbounded: its surplus is free again', () => {
      // `0-5x a` at a hand of five never binds, so a card of `a` may be left
      // over — which the matcher only allows because the requirement is free.
      const c = compiled(
        inputOf(rows, [
          {
            reqs: [
              { n: 0, max: 5, desc: 0 },
              { n: 0, max: 1, desc: 1 },
            ],
            limits: [],
          },
        ]),
      );
      expect(c.problem.criteria[0]!.reqs).toEqual([
        { mask: 0b110, min: 0, max: null },
        { mask: 0b100, min: 0, max: 1 },
      ]);
    });

    it('contributes no slot for a lower bound of zero', () => {
      const c = compiled(inputOf(rows, [{ reqs: [{ n: 0, max: 1, desc: 0 }], limits: [] }]));
      expect(c.problem.criteria[0]!.slots).toEqual([]);
      expect(c.problem.criteria[0]!.reqs).toEqual([{ mask: 0b110, min: 0, max: 1 }]);
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

/**
 * Which hands a run scores, and which criteria each of them is judged against
 * (PRD §5.5) — the whole of what tells the three modes apart.
 *
 * The CLASSES are not among it. They come from the union of every criterion
 * the template has, in every mode, so that one class vector means one deck:
 * in both halves of an average (which is what makes the mean an average of
 * anything), and across the three modes (which is what makes their answers
 * comparable). What a mode changes is which ALTERNATIVES count.
 */
describe('handSizesForMode', () => {
  /** Three criteria, one of each tag; `c1` and `c3` differ, so the parts differ. */
  function tagged(overrides: Partial<Template> = {}): Template {
    return templateOf(
      [
        { id: 'A', text: `#${STRATOS}`, min: 0, max: 3 },
        { id: 'B', text: `#${ROTA}`, min: 0, max: 3 },
        { id: 'm', text: 'monster', min: 0, max: 20 },
      ],
      [],
      {
        hand: { size: 6 },
        mode: 'average',
        criteria: [
          { id: 'c1', text: `1x #${STRATOS}`, when: 'first' },
          { id: 'c2', text: '1x monster' },
          { id: 'c3', text: `1x #${ROTA}`, when: 'second' },
        ],
        ...overrides,
      },
    );
  }

  const resolvedOf = (template: Template): ResolvedTemplate => {
    const resolved = resolveTemplate(template, ctx);
    if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
    return resolved.resolved;
  };

  it('carries every criterion’s tag onto the resolved criterion, defaulted', () => {
    expect(resolvedOf(tagged()).criteria.map((criterion) => criterion.when)).toEqual([
      'first',
      'both',
      'second',
    ]);
  });

  it('says which criteria each alternative of the union came from', () => {
    const resolved = resolvedOf(tagged());
    expect(resolved.flatSources).toEqual([[0], [1], [2]]);
    expect(resolved.flat).toHaveLength(3);
  });

  it('gives a single mode one part, at its own hand, over its own criteria', () => {
    const resolved = resolvedOf(tagged({ mode: 'first', hand: { size: 5 } }));
    expect(handSizesForMode(resolved, 'first')).toEqual([{ H: 5, weight: 1, criteria: [0, 1] }]);
    expect(handSizesForMode(resolved, 'second')).toEqual([{ H: 6, weight: 1, criteria: [1, 2] }]);
  });

  it('gives an average both parts, weighted evenly, each over its own criteria', () => {
    expect(handSizesForMode(resolvedOf(tagged()), 'average')).toEqual([
      { H: 5, weight: 1, criteria: [0, 1] },
      { H: 6, weight: 1, criteria: [1, 2] },
    ]);
  });

  it('takes the weights of an uneven blend, in the order of the parts', () => {
    expect(handSizesForMode(resolvedOf(tagged()), 'average', [3, 2])).toEqual([
      { H: 5, weight: 3, criteria: [0, 1] },
      { H: 6, weight: 2, criteria: [1, 2] },
    ]);
  });

  it('gives every alternative to every part when nothing is tagged', () => {
    const plain = tagged({
      criteria: [
        { id: 'c1', text: '1x monster' },
        { id: 'c2', text: `1x #${ROTA}` },
      ],
    });
    expect(handSizesForMode(resolvedOf(plain), 'average')).toEqual([
      { H: 5, weight: 1, criteria: [0, 1] },
      { H: 6, weight: 1, criteria: [0, 1] },
    ]);
  });

  it('gives an alternative TWO criteria wrote to both parts', () => {
    // The same criterion, tagged each way: `expandAll` merges them into one
    // alternative, and its sources are what still say both parts want it.
    const shared = tagged({
      criteria: [
        { id: 'c1', text: '1x monster', when: 'first' },
        { id: 'c2', text: '1x monster', when: 'second' },
      ],
    });
    const resolved = resolvedOf(shared);
    expect(resolved.flat).toHaveLength(1);
    expect(resolved.flatSources).toEqual([[0, 1]]);
    expect(handSizesForMode(resolved, 'average')).toEqual([
      { H: 5, weight: 1, criteria: [0] },
      { H: 6, weight: 1, criteria: [0] },
    ]);
  });

  it('gives a part with no criteria of its own an EMPTY list, not every alternative', () => {
    const oneSided = tagged({
      criteria: [{ id: 'c1', text: '1x monster', when: 'first' }],
    });
    expect(handSizesForMode(resolvedOf(oneSided), 'average')).toEqual([
      { H: 5, weight: 1, criteria: [0] },
      { H: 6, weight: 1, criteria: [] },
    ]);
  });

  /**
   * Classes come from the criteria the run JUDGES. A single mode is therefore
   * compiled to exactly the problem it would have been had the other hand's
   * criteria never been written — which is the whole point of letting someone
   * split the list in two.
   */
  describe('the classes a mode is compiled to', () => {
    const compiledIn = (resolved: ResolvedTemplate, mode: 'first' | 'second' | 'average') => {
      const result = compileProblem(resolved, { handSizes: handSizesForMode(resolved, mode) });
      if (!result.ok) throw new Error(result.errors.join('\n'));
      return result;
    };

    it('keeps only the alternatives the run judges, renumbered from zero', () => {
      const resolved = resolvedOf(tagged());
      const first = compiledIn(resolved, 'first').problem;
      expect(first.criteria).toHaveLength(2);
      expect(first.handSizes).toEqual([{ H: 5, weight: 1, criteria: [0, 1] }]);
      expect(compiledIn(resolved, 'second').problem.handSizes).toEqual([
        { H: 6, weight: 1, criteria: [0, 1] },
      ]);
      expect(compiledIn(resolved, 'second').problem.criteria).toHaveLength(2);
      // An average judges every criterion, so nothing is renumbered.
      expect(compiledIn(resolved, 'average').problem.handSizes).toEqual([
        { H: 5, weight: 1, criteria: [0, 1] },
        { H: 6, weight: 1, criteria: [1, 2] },
      ]);
      expect(compiledIn(resolved, 'average').problem.criteria).toHaveLength(3);
    });

    it('is the same problem as a template that only ever had those criteria', () => {
      const resolved = resolvedOf(tagged());
      const alone = resolveTemplate(
        {
          ...tagged({ mode: 'first', hand: { size: 5 } }),
          criteria: [
            { id: 'c1', text: `1x #${STRATOS}`, when: 'first' },
            { id: 'c2', text: '1x monster' },
          ],
        },
        ctx,
      );
      if (!alone.ok) throw new Error(alone.errors.join('\n'));
      const mine = compiledIn(resolved, 'first');
      const theirs = compileProblem(alone.resolved, {
        handSizes: handSizesForMode(alone.resolved, 'first'),
      });
      if (!theirs.ok) throw new Error(theirs.errors.join('\n'));
      expect(mine.problem.classes).toEqual(theirs.problem.classes);
      expect(mine.classOfLine).toEqual(theirs.classOfLine);
      expect(mine.problem.criteria).toEqual(theirs.problem.criteria);
    });

    it('tells FEWER classes apart than the average, which judges both sets', () => {
      const resolved = resolvedOf(tagged());
      const classes = (['first', 'second', 'average'] as const).map(
        (mode) => compiledIn(resolved, mode).problem.classes.length,
      );
      const [first, second, average] = classes as [number, number, number];
      expect(first).toBeLessThan(average);
      expect(second).toBeLessThan(average);
    });

    /**
     * The safety property. Coarsening the partition to the criteria actually
     * judged cannot move a probability — merged lines are indistinguishable to
     * every criterion that survives — so a single mode's best is what it was
     * when the classes came from both sets.
     */
    it('scores every deck exactly as the union\u2019s finer classes did', () => {
      const resolved = resolvedOf(tagged());
      const union = compileProblem(resolved, {
        handSizes: [{ H: 5, weight: 1, criteria: [0, 1, 2] }],
      });
      const own = compiledIn(resolved, 'first');
      if (!union.ok) throw new Error(union.errors.join('\n'));
      // The union's problem judges c3 too, so hold BOTH to the going-first
      // criteria and compare the numbers they give the same decks.
      const fine = createBlendScorer({
        ...union.problem,
        handSizes: [{ H: 5, weight: 1, criteria: [0, 1] }],
      });
      const coarse = createBlendScorer(own.problem);
      const best = (scorer: typeof fine, compiled: typeof own) => {
        let top = -1;
        const walk = (cls: number, left: number, totals: number[]): void => {
          if (cls === compiled.problem.classes.length) {
            if (left === 0) top = Math.max(top, scorer.rankKey(totals));
            return;
          }
          const { min, max } = compiled.problem.classes[cls]!;
          for (let n = min; n <= Math.min(max, left); n++) walk(cls + 1, left - n, [...totals, n]);
        };
        walk(0, compiled.problem.deckSize, []);
        return top;
      };
      expect(best(coarse, own)).toBe(best(fine, union));
      expect(best(coarse, own)).toBeGreaterThan(0);
    });
  });

  it('refuses a criteria index the template has no alternative for', () => {
    const resolved = resolvedOf(tagged());
    const result = compileProblem(resolved, {
      handSizes: [{ H: 6, weight: 1, criteria: [0, 99] }],
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors[0]).toMatch(
      /there is no criterion 99: the template expanded to 3 alternative/,
    );
  });
});

describe('lineInterval', () => {
  // A class of two lines, 1–3 and 0–2: its total runs from 1 to 5.
  const cls = { min: 1, max: 5 };
  const first = { min: 1, max: 3 };
  const second = { min: 0, max: 2 };

  it('is what the line can hold while the others make up the rest of the class total', () => {
    expect(lineInterval(cls, first, 1)).toEqual({ min: 1, max: 1 });
    expect(lineInterval(cls, second, 1)).toEqual({ min: 0, max: 0 });
    expect(lineInterval(cls, first, 3)).toEqual({ min: 1, max: 3 });
    expect(lineInterval(cls, second, 3)).toEqual({ min: 0, max: 2 });
    // At 5 both are at their maximum; at 4 each is one short of it at most.
    expect(lineInterval(cls, first, 5)).toEqual({ min: 3, max: 3 });
    expect(lineInterval(cls, first, 4)).toEqual({ min: 2, max: 3 });
    expect(lineInterval(cls, second, 4)).toEqual({ min: 1, max: 2 });
  });

  it('is the whole total for a class of one line', () => {
    expect(lineInterval({ min: 0, max: 3 }, { min: 0, max: 3 }, 2)).toEqual({ min: 2, max: 2 });
  });

  it('is empty for a total outside the class range', () => {
    for (const total of [0, 6]) {
      const { min, max } = lineInterval(cls, first, total);
      expect(min).toBeGreaterThan(max);
    }
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

/**
 * Weighting, from the template to the compiled problem (PRD §5.6). The switch
 * is applied TWICE on purpose — where the weights come from, and again in
 * `compileProblem` — so a compiled problem can never carry weights the run is
 * not meant to read, whichever of the two a caller goes through.
 */
describe('weighted criteria through resolve and compile', () => {
  const weightedTemplate = (weights: number[], weighted = true): Template => {
    const template = templateOf(
      [line('mon', 'monster', 0, 10), line('sp', 'spell', 0, 10)],
      ['1x monster', '1x spell'],
    );
    return {
      ...template,
      weighted,
      criteria: template.criteria.map((criterion, at) => ({ ...criterion, weight: weights[at] })),
    };
  };

  it('carries each criterion its weight, and puts it on the alternatives it produced', () => {
    const r = resolved(weightedTemplate([4, 1]));
    expect(r.weighted).toBe(true);
    expect(r.criteria.map((criterion) => criterion.weight)).toEqual([4, 1]);
    // `flat` is the criteria expanded together: the heavy one's alternative
    // carries 4, the light one's carries nothing (1 is left out).
    const byWeight = r.flat.map((alternative) => alternative.weight);
    expect(byWeight).toEqual([4, undefined]);
    // A criterion's OWN `alternatives` stay unweighted: they are what the
    // per-criterion breakdown scores, and that is a probability.
    for (const criterion of r.criteria)
      for (const alternative of criterion.alternatives)
        expect(alternative).not.toHaveProperty('weight');
  });

  it('reads no weight at all with the switch off, and resolves to the template it always was', () => {
    const off = weightedTemplate([4, 1], false);
    const never = templateOf(
      [line('mon', 'monster', 0, 10), line('sp', 'spell', 0, 10)],
      ['1x monster', '1x spell'],
    );
    const a = resolved(off);
    const b = resolved(never);
    expect(a.weighted).toBe(false);
    expect(a.criteria.map((criterion) => criterion.weight)).toEqual([1, 1]);
    expect(a.flat).toEqual(b.flat);
  });

  /**
   * The rule that only the shared expansion can show: `expandAll` removes
   * duplicate alternatives ACROSS criteria, and a hand meeting the survivor
   * meets every criterion that produced it — so it is worth the highest of
   * their weights, not the first one's and not their sum.
   */
  it('gives an alternative two criteria share the HIGHEST of their weights', () => {
    const template = templateOf(
      [line('mon', 'monster', 0, 10)],
      ['1x monster', '1x monster or 2x monster'],
    );
    const shared: Template = {
      ...template,
      weighted: true,
      criteria: [
        { ...template.criteria[0]!, weight: 2 },
        { ...template.criteria[1]!, weight: 9 },
      ],
    };
    const r = resolved(shared);
    // `1x monster` came from both criteria; `2x monster` from the second alone.
    expect(r.flatSources[0]).toEqual([0, 1]);
    expect(r.flat[0]!.weight).toBe(9);
    expect(r.flat.find((_, at) => r.flatSources[at]!.join() === '1')!.weight).toBe(9);
    // Reversed, the answer is the same: it is a maximum, not a first or a last.
    const flipped = resolved({
      ...shared,
      criteria: [
        { ...shared.criteria[0]!, weight: 9 },
        { ...shared.criteria[1]!, weight: 2 },
      ],
    });
    expect(flipped.flat[0]!.weight).toBe(9);
  });

  it('compiles the weights onto the criteria the engine judges, and only with the switch on', () => {
    const on = compileProblem(resolved(weightedTemplate([4, 1])));
    if (!on.ok) throw new Error(on.errors.join('\n'));
    expect(on.weighted).toBe(true);
    expect(on.problem.criteria.map((criterion) => criterion.weight)).toEqual([4, undefined]);

    // The same resolved template compiled with the switch off: no weight survives.
    const off = compileProblem({ ...resolved(weightedTemplate([4, 1])), weighted: false });
    if (!off.ok) throw new Error(off.errors.join('\n'));
    expect(off.weighted).toBe(false);
    expect(off.problem.criteria.every((criterion) => criterion.weight === undefined)).toBe(true);
    // And it is the problem the unweighted template compiles to, byte for byte.
    const never = compileProblem(resolved(weightedTemplate([1, 1], false)));
    if (!never.ok) throw new Error(never.errors.join('\n'));
    expect(off.problem).toEqual(never.problem);
  });

  it('refuses, as a compile error, a weight the deck and hand cannot score exactly', () => {
    const huge = weightedTemplate([13_688_586_241, 1]);
    // The FILE validator would never let this through; `compileProblem` is the
    // engine's own guard, and it says no rather than rounding.
    const result = compileProblem(resolved(huge));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the weight to be refused');
    expect(result.errors.join('\n')).toMatch(/past 2\^53/);
  });
});

/**
 * The SIXTH CARD through resolve and compile (PRD §5.6). The split lives in the
 * criterion's TEXT and its AST, so nothing new travels beside them — and the one
 * new thing a `Problem` gains, `drawn`, is derived from the alternatives a hand
 * judges rather than declared twice.
 */
describe('the sixth card through resolve and compile', () => {
  const secondTemplate = (texts: string[], hand = 6): Template => {
    const template = templateOf(
      [line('mon', 'monster', 0, 10), line('sp', 'spell', 0, 10), line('tr', 'trap', 0, 10)],
      texts,
    );
    return {
      ...template,
      hand: { size: hand },
      mode: hand === 6 ? 'second' : 'first',
      criteria: template.criteria.map((criterion) => ({ ...criterion, when: 'second' })),
    };
  };

  it('resolves the two sides into columns of ONE match matrix', () => {
    const r = resolved(secondTemplate(['1x monster then 1x trap']));
    expect(r.criteria[0]!.canonical).toBe('opening 5: 1x monster · drawn: 1x trap');
    expect(r.flat).toEqual([
      { reqs: [{ n: 1, desc: 0 }], limits: [], sixth: { reqs: [{ n: 1, desc: 1 }], limits: [] } },
    ]);
    // `trap` is a column like any other, so the classes tell traps apart.
    expect(r.descriptions.map((d) => d.text)).toEqual(['monster', 'trap']);
    expect(fillersOf(r, 'trap')).toEqual(['tr']);
  });

  it('compiles the sixth card into its own masks, and marks the hand as drawing one', () => {
    const compiled = compileProblem(resolved(secondTemplate(['1x monster then 1x trap'])), {
      handSizes: [{ H: 6, weight: 1 }],
    });
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const [criterion] = compiled.problem.criteria;
    expect(criterion!.sixth).toBeDefined();
    expect(criterion!.slots).toHaveLength(1);
    expect(criterion!.sixth!.slots).toHaveLength(1);
    // The two masks name different classes: a monster is not a trap.
    expect(criterion!.slots[0]).not.toBe(criterion!.sixth!.slots[0]);
    expect(compiled.problem.handSizes).toEqual([{ H: 6, weight: 1, drawn: true }]);
    expect(() => validateProblem(compiled.problem)).not.toThrow();
  });

  it('leaves a template with no split exactly as it was: no `drawn` anywhere', () => {
    const compiled = compileProblem(resolved(secondTemplate(['1x monster and 1x trap'])), {
      handSizes: [{ H: 6, weight: 1 }],
    });
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    expect(compiled.problem.handSizes).toEqual([{ H: 6, weight: 1 }]);
    for (const criterion of compiled.problem.criteria)
      expect(criterion).not.toHaveProperty('sixth');
  });

  it('honours a `drawn` the caller asked for, so every row of a run shares one denominator', () => {
    const compiled = compileProblem(resolved(secondTemplate(['1x monster and 1x trap'])), {
      handSizes: [{ H: 6, weight: 1, drawn: true }],
    });
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    expect(compiled.problem.handSizes).toEqual([{ H: 6, weight: 1, drawn: true }]);
  });

  it('marks only the part that judges the split, in an average', () => {
    const template = secondTemplate(['1x monster then 1x trap', '1x spell']);
    const both: Template = {
      ...template,
      mode: 'average',
      criteria: [
        { ...template.criteria[0]!, when: 'second' },
        { ...template.criteria[1]!, when: 'first' },
      ],
    };
    const r = resolved(both);
    const compiled = compileProblem(r, { handSizes: handSizesForMode(r, 'average') });
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    expect(compiled.problem.handSizes.map(({ H, drawn }) => ({ H, drawn }))).toEqual([
      { H: 5, drawn: undefined },
      { H: 6, drawn: true },
    ]);
  });

  it('drops a sixth-card ceiling and limit that one card can never break, and says so', () => {
    // `at most 1x trap` and `0-1x trap` both hold of any single card.
    const compiled = compileProblem(
      resolved(secondTemplate(['1x monster then at most 1x trap', '1x monster then 0-1x trap'])),
      { handSizes: [{ H: 6, weight: 1 }] },
    );
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    expect(compiled.droppedLimits).toEqual([
      { criterion: 0, desc: 1, n: 1, reason: 'never-binds', sixth: true },
    ]);
    expect(compiled.droppedCeilings).toEqual([
      { criterion: 1, desc: 1, n: 0, max: 1, reason: 'never-binds', sixth: true },
    ]);
  });

  it('keeps `no trap` of the card drawn, which is the whole point of a limit there', () => {
    const compiled = compileProblem(resolved(secondTemplate(['1x monster then no trap'])), {
      handSizes: [{ H: 6, weight: 1 }],
    });
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    expect(compiled.droppedLimits).toEqual([]);
    expect(compiled.problem.criteria[0]!.sixth).toMatchObject({ slots: [] });
    expect(compiled.problem.criteria[0]!.sixth!.limits).toHaveLength(1);
  });

  it('judges the five-card part over five cards, so `6x` there can never be met', () => {
    expect(resolved(secondTemplate(['5x monster then 1x trap'])).criteria[0]!.dropped).toBe(0);
    expect(resolved(secondTemplate(['6x monster then 1x trap'])).criteria[0]!.dropped).toBe(1);
    // Unsplit, all six cards are available.
    expect(resolved(secondTemplate(['6x monster'])).criteria[0]!.dropped).toBe(0);
  });

  describe('a split criterion must be tagged going second', () => {
    const tagged = (when: 'first' | 'second' | 'both'): Template => {
      const template = secondTemplate(['1x monster then 1x trap']);
      return { ...template, criteria: [{ ...template.criteria[0]!, when }] };
    };

    it('resolves when it is', () => {
      expect(errorsOf(tagged('second'))).toEqual([]);
    });

    it('refuses `both`, naming what to do about it', () => {
      expect(errorsOf(tagged('both'))).toEqual([
        'criterion "c1": the opening-5 and drawn-cards fields split the hand you draw going second, but this one is judged for both hands, and going first the hand is five cards and none of them is drawn after — tag it going second, or move what they say into the whole-hand field and empty them',
      ]);
    });

    it('refuses `first`', () => {
      expect(errorsOf(tagged('first'))[0]).toContain('this one is judged going first');
    });

    it('refuses it however the template is tagged: a run going first has such criteria too', () => {
      // The template's MODE is a different thing from a criterion's tag, and a
      // going-first template may hold going-second criteria.
      const goingFirst = { ...tagged('both'), hand: { size: 5 }, mode: 'first' as const };
      expect(errorsOf(goingFirst)[0]).toContain('tag it going second');
    });
  });

  it('refuses a drawn part asked for more than one card, where nothing draws', () => {
    expect(errorsOf(secondTemplate(['1x monster then 2x trap']))[0]).toContain(
      'the card you draw is one card',
    );
  });
});

// ---------------------------------------------------------------------------
// `finally` through resolve and compile (PRD §5.5, YGO-41)
// ---------------------------------------------------------------------------

describe('a `finally` clause through resolve and compile', () => {
  const secondTemplate = (texts: string[]): Template => {
    const template = templateOf(
      [line('mon', 'monster', 0, 10), line('sp', 'spell', 0, 10), line('tr', 'trap', 0, 10)],
      texts,
    );
    return {
      ...template,
      hand: { size: 6 },
      mode: 'second',
      criteria: template.criteria.map((criterion) => ({ ...criterion, when: 'second' })),
    };
  };

  const compiledOf = (texts: string[]) => {
    const compiled = compileProblem(resolved(secondTemplate(texts)), {
      handSizes: [{ H: 6, weight: 1 }],
    });
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    return compiled;
  };

  it('resolves all three windows into columns of ONE match matrix', () => {
    const r = resolved(secondTemplate(['1x monster then no trap finally at most 1x spell']));
    expect(r.criteria[0]!.canonical).toBe(
      'opening 5: 1x monster · drawn: no trap · whole hand: at most 1x spell',
    );
    expect(r.flat).toEqual([
      {
        reqs: [{ n: 1, desc: 0 }],
        limits: [],
        sixth: { reqs: [], limits: [{ n: 0, desc: 1 }] },
        whole: { reqs: [], limits: [{ n: 1, desc: 2 }] },
      },
    ]);
    expect(r.descriptions.map((d) => d.text)).toEqual(['monster', 'trap', 'spell']);
    // A description named ONLY in the `finally` part is a column like any other.
    expect(fillersOf(r, 'spell')).toEqual(['sp']);
  });

  it('compiles the `finally` part into its own masks, and marks the hand as drawing', () => {
    const compiled = compiledOf(['1x monster finally at most 1x trap']);
    const [criterion] = compiled.problem.criteria;
    expect(criterion!.whole).toBeDefined();
    expect(criterion!).not.toHaveProperty('sixth');
    expect(criterion!.whole!.limits).toHaveLength(1);
    // Its own part is still about the cards OPENED ON, which is why the hand draws.
    expect(compiled.problem.handSizes).toEqual([{ H: 6, weight: 1, drawn: true }]);
    expect(() => validateProblem(compiled.problem)).not.toThrow();
  });

  /**
   * THE ROOM OF THE `finally` WINDOW IS THE WHOLE HAND, which is what makes `at
   * most 6x` a vacuous `finally` at a hand of six — and `at most 5x` a binding
   * one, where the same ceiling over the five it opens on would be vacuous.
   */
  it('weighs a `finally` limit against six cards and the opening part against five', () => {
    const vacuous = compiledOf(['1x monster finally at most 6x trap']);
    expect(vacuous.droppedLimits).toEqual([
      { criterion: 0, desc: 1, n: 6, reason: 'never-binds', whole: true },
    ]);
    expect(vacuous.problem.criteria[0]!.whole!.limits).toEqual([]);
    const binding = compiledOf(['1x monster finally at most 5x trap']);
    expect(binding.droppedLimits).toEqual([]);
    expect(binding.problem.criteria[0]!.whole!.limits).toHaveLength(1);
    // The criterion's OWN window is the five it opens on, where 5 is vacuous.
    const opening = compiledOf(['at most 5x trap finally 1x monster']);
    expect(opening.droppedLimits).toEqual([{ criterion: 0, desc: 0, n: 5, reason: 'never-binds' }]);
  });

  it('judges the opening part over five cards, `then` or no `then`', () => {
    expect(resolved(secondTemplate(['5x monster finally 1x trap'])).criteria[0]!.dropped).toBe(0);
    expect(resolved(secondTemplate(['6x monster finally 1x trap'])).criteria[0]!.dropped).toBe(1);
    // And the `finally` part itself gets all six.
    expect(resolved(secondTemplate(['1x monster finally 6x trap'])).criteria[0]!.dropped).toBe(0);
    expect(resolved(secondTemplate(['1x monster finally 7x trap'])).criteria[0]!.dropped).toBe(1);
  });

  it('must be tagged going second, in the same words a `then` must', () => {
    const template = secondTemplate(['1x monster finally 1x trap']);
    for (const when of ['first', 'both'] as const) {
      const tagged: Template = { ...template, criteria: [{ ...template.criteria[0]!, when }] };
      expect(errorsOf(tagged)[0], when).toContain(
        'the opening-5 and drawn-cards fields split the hand',
      );
      expect(errorsOf(tagged)[0], when).toContain('tag it going second');
    }
  });

  /**
   * A REGRESSION, and it predates `finally`: `compileProblem` decides which
   * match-matrix columns are DEAD — mentioned only by criteria this run does not
   * judge — and it used to read the top-level window alone. A description named
   * only after `then` or `finally` by a criterion the run DOES judge, and named
   * again by one it does not, was then dropped from the class partition, its mask
   * became 0, and that half of the criterion became unmeetable. Nothing threw;
   * the run answered a different question.
   */
  it('keeps a class a description named only after `then` or `finally` needs', () => {
    const template = templateOf(
      [line('mon', 'monster', 0, 10), line('tr', 'trap', 0, 10)],
      ['1x monster then 1x trap', '1x monster finally 1x trap', '1x trap'],
    );
    const going: Template = {
      ...template,
      hand: { size: 6 },
      mode: 'second',
      criteria: [
        { ...template.criteria[0]!, when: 'second' },
        { ...template.criteria[1]!, when: 'second' },
        // The going-FIRST criterion names `trap` too, and this run never judges it.
        { ...template.criteria[2]!, when: 'first' },
      ],
    };
    const r = resolved(going);
    const compiled = compileProblem(r, {
      handSizes: [{ H: 6, weight: 1, criteria: [0, 1] }],
    });
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    // `trap` still tells a class apart, so neither half asks a mask of 0 — which
    // is what a criterion that can never be met looks like from the outside.
    for (const criterion of compiled.problem.criteria) {
      expect(criterion.slots).not.toContain(0);
      expect(criterion.sixth?.slots ?? []).not.toContain(0);
      expect(criterion.whole?.slots ?? []).not.toContain(0);
    }
    const scored = createScorer(compiled.problem, 6).score(
      compiled.problem.classes.map(({ lineIds }) =>
        lineIds.includes('mon') ? 10 : lineIds.includes('tr') ? 10 : 20,
      ),
    );
    expect(scored.num).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Draw cards through resolve and compile (PRD §5.7)
// ---------------------------------------------------------------------------

describe('draw cards through resolve and compile', () => {
  const drawLine = (id: string, text: string, draw: DrawSpec, min = 0, max = 3): TemplateLine => ({
    id,
    text,
    min,
    max,
    draw,
  });

  describe('classes', () => {
    /**
     * `compile` sends any all-false line to the BLANK class by a shortcut on
     * the row alone. A `3x [Pot of Greed]` no criterion mentions has exactly
     * that row — and a blank class of cards that DRAW would make its draws
     * vanish, so the run would report today's number for tomorrow's deck. The
     * shortcut has to know about drawing, and this is the test that says so.
     */
    it('never puts a DRAW line in the blank class, however little any criterion says about it', () => {
      const template = templateOf(
        [line('starter', 'monster'), drawLine('pot', 'spell', { n: 2 })],
        ['1x monster'],
      );
      const c = compiled(resolved(template));
      // The remainder joins the blank class as it always does; the draw line
      // gets a class of its own, which is the whole point.
      expect(membersOf(c)[0]).toEqual([REMAINDER_ID]);
      const pot = c.classes.find((cls) => cls.lines.some((member) => member.id === 'pot'));
      expect(pot?.draw).toEqual({ n: 2 });
      expect(c.problem.classes.some(({ draw }) => draw !== undefined)).toBe(true);
    });

    it('carries what a class draws onto the problem it compiles to', () => {
      const template = templateOf(
        [drawLine('pot', 'spell', { n: 2, oncePerTurn: true }), line('starter', 'monster')],
        ['1x monster'],
      );
      const c = compiled(resolved(template));
      const at = c.classOfLine[0]!;
      expect(c.problem.classes[at]!.draw).toEqual({ n: 2, oncePerTurn: true });
    });

    it('merges two ordinary draw lines that draw the same and match the same', () => {
      const template = templateOf(
        [drawLine('pot', 'spell', { n: 2 }, 0, 1), drawLine('other', 'spell', { n: 2 }, 0, 1)],
        ['1x monster'],
      );
      const c = compiled(resolved(template));
      expect(membersOf(c)).toContainEqual(['pot', 'other']);
    });

    it('keeps two draw lines apart when they draw different numbers', () => {
      const template = templateOf(
        [drawLine('pot', 'spell', { n: 2 }), drawLine('upstart', 'spell', { n: 1 })],
        ['1x monster'],
      );
      expect(membersOf(compiled(resolved(template)))).toContainEqual(['pot']);
      expect(membersOf(compiled(resolved(template)))).toContainEqual(['upstart']);
    });

    /**
     * ONCE-PER-TURN is a property of the CARD. Two once-per-turn lines are two
     * different cards, each with its own once, and one class holding both would
     * let a single copy stand for the pair.
     */
    it('never merges two once-per-turn lines, even when they are alike in every other way', () => {
      const spec: DrawSpec = { n: 2, oncePerTurn: true };
      const template = templateOf(
        [drawLine('one', 'spell', spec, 0, 1), drawLine('two', 'spell', spec, 0, 1)],
        ['1x monster'],
      );
      const c = compiled(resolved(template));
      expect(membersOf(c)).toContainEqual(['one']);
      expect(membersOf(c)).toContainEqual(['two']);
    });
  });

  describe('the largest hand', () => {
    it('is what the criteria are expanded for, so an alternative bigger than the opening survives', () => {
      // Three copies of a draw-2 reach a hand of eight, and `6x monster` is
      // then perfectly satisfiable where a hand of five could never meet it.
      const template = templateOf(
        [drawLine('pot', 'spell', { n: 2 }), line('starter', 'monster', 0, 20)],
        ['6x monster'],
      );
      const r = resolved(template);
      expect(r.handSize).toBe(5);
      expect(r.judgedHand).toBe(8);
      expect(r.flat).toHaveLength(1);
      expect(compiled(r).problem.criteria[0]!.slots).toHaveLength(6);
    });

    it('is the hand size itself without draw cards, so nothing about those templates moves', () => {
      const r = resolved(templateOf([line('starter', 'monster')], ['6x monster']));
      expect(r.judgedHand).toBe(5);
      expect(r.flat).toHaveLength(0);
    });

    it('is what a ceiling can bind against: one at the largest hand never binds', () => {
      const template = templateOf(
        [drawLine('pot', 'spell', { n: 2 }), line('starter', 'monster', 0, 20)],
        ['1-8x monster'],
      );
      const c = compiled(resolved(template));
      expect(c.droppedCeilings.map(({ max, reason }) => [max, reason])).toEqual([
        [8, 'never-binds'],
      ]);
    });

    it('refuses to compile criteria expanded for a smaller hand than the draws can build', () => {
      const r = resolved(templateOf([line('starter', 'monster')], ['1x monster']));
      const narrow = compileProblem({
        ...r,
        judgedHand: 5,
        lines: r.lines.map((own) =>
          own.id === 'starter' ? { ...own, draw: { n: 2 } as DrawSpec } : own,
        ),
      });
      expect(narrow.ok).toBe(false);
      if (!narrow.ok) expect(narrow.errors[0]).toMatch(/cannot be judged/);
    });
  });

  describe('the stop flag', () => {
    const withToggle = (stop: boolean) =>
      templateOf([drawLine('pot', 'spell', { n: 2 }), line('starter', 'monster')], ['1x monster'], {
        criteria: [{ id: 'c1', text: '1x monster', stop }],
      });

    it('is left off the compiled criterion when the player would not stop, which is the default', () => {
      const c = compiled(resolved(withToggle(false)));
      expect(c.problem.criteria[0]).not.toHaveProperty('stop');
      expect(resolved(withToggle(false)).criteria[0]!.stop).toBe(false);
    });

    it('reaches the compiled criterion when the player would stop', () => {
      const c = compiled(resolved(withToggle(true)));
      expect(c.problem.criteria[0]!.stop).toBe(true);
      expect(resolved(withToggle(true)).criteria[0]!.stop).toBe(true);
    });

    /**
     * It does not change what an alternative ASKS, so two criteria of the same
     * text are still ONE alternative — stopped for if EITHER of them stops,
     * exactly as such an alternative is worth the HIGHEST of their weights.
     */
    it('merges two criteria of the same text, and the merged one stops if either does', () => {
      const template = templateOf(
        [drawLine('pot', 'spell', { n: 2 }), line('starter', 'monster')],
        [],
        {
          criteria: [
            { id: 'draws-past', text: '1x monster' },
            { id: 'stops', text: '1x monster', stop: true },
          ],
        },
      );
      const r = resolved(template);
      expect(r.flat).toHaveLength(1);
      expect(r.flat[0]!.stop).toBe(true);
      expect(r.flatSources).toEqual([[0, 1]]);
      expect(compiled(r).problem.criteria[0]!.stop).toBe(true);
    });

    it('leaves the merged alternative alone when neither criterion stops', () => {
      const template = templateOf(
        [drawLine('pot', 'spell', { n: 2 }), line('starter', 'monster')],
        [],
        {
          criteria: [
            { id: 'a', text: '1x monster' },
            { id: 'b', text: '1x monster' },
          ],
        },
      );
      const r = resolved(template);
      expect(r.flat).toHaveLength(1);
      expect(r.flat[0]).not.toHaveProperty('stop');
    });
  });

  /**
   * `then` BESIDE DRAW CARDS, end to end (PRD §5.6, §5.7). It reads the whole
   * DRAWN SET — the card drawn for turn and everything the draw cards fetched —
   * so the hand is marked `drawn` and the criterion compiles with a part of its
   * own, where the two were once refused together.
   */
  describe('`then` beside draw cards', () => {
    const withThen = (text: string, draw: DrawSpec = { n: 2 }) =>
      templateOf([drawLine('pot', 'spell', draw), line('starter', 'monster')], [], {
        hand: { size: 6 },
        mode: 'second',
        criteria: [{ id: 'c1', ...fieldsOf(text), when: 'second' }],
      });

    it('compiles, and marks the hand as one dealt in two pieces', () => {
      const result = compileProblem(resolved(withThen('then 1x monster')));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errors.join('\n'));
      expect(result.problem.handSizes[0]).toMatchObject({ H: 6, drawn: true });
      expect(result.problem.criteria[0]!.sixth).toBeDefined();
    });

    /**
     * `then 2x monster` is a question no ONE card can answer, and the reason
     * `then` was capped at one slot. Two Pots fetch four cards, so the drawn set
     * holds up to five and the question is now answerable — by the hands that
     * drew, and by no hand that did not.
     */
    it('accepts `then 2x`, which only the cards a draw card fetched can hold', () => {
      const result = compileProblem(resolved(withThen('then 2x monster')));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errors.join('\n'));
      expect(result.problem.criteria[0]!.sixth!.slots).toHaveLength(2);
    });

    it('still refuses more than the draw cards can ever fetch', () => {
      // Three copies of a draw-2 from a hand of six: a prefix of 12, so the
      // drawn set holds seven cards and never an eighth.
      expect(errorsOf(withThen('then 8x monster'))[0]).toContain('you draw at most 7 cards here');
    });

    /**
     * A CEILING BINDS AGAINST THE WINDOW IT IS IN, and with draw cards the
     * three windows are three different sizes: the whole hand is nine cards
     * here, the cards opened on are five however deep the prefix goes, and the
     * drawn set is seven. A ceiling of five on the opening part can never bind
     * and is dropped; the same ceiling on an unsplit criterion is kept, because
     * the hand it counts holds nine.
     */
    it('drops a ceiling the cards opened on could never break, and keeps it on the whole hand', () => {
      const split = compileProblem(resolved(withThen('0-5x monster then 1x monster')));
      if (!split.ok) throw new Error(split.errors.join('\n'));
      expect(split.droppedCeilings.map(({ n, max, reason }) => ({ n, max, reason }))).toEqual([
        { n: 0, max: 5, reason: 'never-binds' },
      ]);
      expect(split.problem.criteria[0]!.reqs).toBeUndefined();

      const whole = compileProblem(
        resolved(
          templateOf([drawLine('pot', 'spell', { n: 2 }), line('starter', 'monster')], [], {
            hand: { size: 6 },
            mode: 'second',
            criteria: [{ id: 'c1', text: '0-5x monster', when: 'second' }],
          }),
        ),
      );
      if (!whole.ok) throw new Error(whole.errors.join('\n'));
      expect(whole.droppedCeilings).toEqual([]);
      expect(whole.problem.criteria[0]!.reqs).toBeDefined();
    });

    it('scores it end to end, against one denominator', () => {
      const c = compiled(resolved(withThen('1x monster then 1x monster')));
      const totals = c.problem.classes.map(({ min }) => min);
      totals[0] = c.problem.deckSize - totals.reduce((sum, count) => sum + count, 0);
      const score = createBlendScorer(c.problem).score(totals);
      expect(score.parts.map((part) => part.prefix)).toEqual([6, 8, 10, 12]);
      expect(score.pDisplay).toBeGreaterThanOrEqual(0);
      expect(score.pDisplay).toBeLessThanOrEqual(1);
    });
  });

  it('scores a template with draw cards end to end', () => {
    const template = templateOf(
      [drawLine('pot', 'spell', { n: 2 }), line('starter', 'monster', 0, 20)],
      ['1x monster'],
    );
    const c = compiled(resolved(template));
    const totals = c.problem.classes.map(({ min }) => min);
    totals[0] = c.problem.deckSize - totals.reduce((sum, count) => sum + count, 0);
    const score = createBlendScorer(c.problem).score(totals);
    expect(score.parts.map((part) => part.prefix)).toEqual([5, 7, 9, 11]);
    expect(score.pDisplay).toBeGreaterThanOrEqual(0);
    expect(score.pDisplay).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// `n× unique D` through resolve and compile (PRD §5.3, TDD §8)
// ---------------------------------------------------------------------------

describe('unique requirements through resolve and compile', () => {
  // Starters A, B and C; C is ALSO an extender, beside E.
  const A = CODE.vanillaDragon;
  const B = CODE.tunerFairy;
  const C = CODE.ritualSoldier;
  const E = STRATOS;
  const cardOf = (passcode: number) => ({ passcode, name: `#${passcode}` });
  const GROUPS: Template['groups'] = [
    { id: 'g-starter', name: 'Starter', cards: [A, B, C].map(cardOf) },
    { id: 'g-extender', name: 'Extender', cards: [C, E].map(cardOf) },
    { id: 'g-harpies', name: 'Harpies', cards: [CODE.harpy, CODE.treatedAsHarpy].map(cardOf) },
    // Four different starters, for a ceiling on `unique`: A, B, C and E.
    { id: 'g-four', name: 'Four', cards: [A, B, C, E].map(cardOf) },
  ];
  /** A line of exactly `copies` copies of the card with this passcode. */
  const named = (id: string, passcode: number, copies: number): TemplateLine => ({
    id,
    text: `#${passcode}`,
    min: copies,
    max: copies,
  });
  const uniqueTemplate = (lines: TemplateLine[], criteria: string[], deckSize = 40): Template =>
    templateOf(lines, criteria, { groups: GROUPS, deckSize });

  /** Compiled going first, lines held at the counts they are pinned to. */
  const compiledOf = (template: Template) => {
    const result = compileProblem(resolved(template));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return result;
  };
  const compileErrorsOf = (template: Template) => {
    const result = compileProblem(resolved(template));
    return result.ok ? [] : result.errors;
  };

  /** The engine's exact numerator at a hand of five, every line at its pinned count. */
  function numeratorOf(template: Template): { num: number; den: number } {
    const c = compiledOf(template);
    const totals = classTotalsOf(
      c,
      template.lines.map(({ min }) => min),
      template.deckSize,
    );
    const { num, den } = createScorer(c.problem, 5).score(totals);
    return { num, den };
  }

  const impliesCtx = { cards: ctx.cards, groups: groupMembersOf(GROUPS) };
  /** What the card oracle is told of each line: its copies, and which CARD it is. */
  function oracleNumerator(template: Template, identities: (string | number)[]): number {
    const r = resolved(template);
    const descOf = new Map<string | number, Description>();
    r.lines.forEach((line, at) => {
      descOf.set(at < identities.length ? identities[at]! : 'remainder', line.desc);
    });
    return cardLevelNumerator(
      template.lines.map(({ min }, at) => ({ copies: min, identity: identities[at]! })),
      { copies: 0, identity: 'remainder' },
      template.deckSize,
      5,
      r.criteria.map(({ expr }) => expr),
      (identity, desc) => implies(descOf.get(identity)!, desc, impliesCtx),
    );
  }

  describe('the exact targets, computed before any code by an assignment search', () => {
    const threeStarters = [named('a', A, 3), named('b', B, 3), named('c', C, 3)];
    const withExtender = [...threeStarters, named('e', E, 3)];

    it.each([
      ['3 unique {Starter}', threeStarters, 15_174],
      ['2 unique {Starter}', threeStarters, 163_062],
      ['3x {Starter}', threeStarters, 43_092],
      ['3 unique {Starter}, 1x {Extender}', withExtender, 3411],
      ['3 unique {Starter}', withExtender, 15_174],
    ] as const)('scores `%s` at exactly the target', (text, lines, target) => {
      const template = uniqueTemplate([...lines], [text]);
      expect(numeratorOf(template)).toEqual({ num: target, den: 658_008 });
      // The card oracle agrees, by a route through none of classes, masks or Gale.
      expect(
        oracleNumerator(
          template,
          // Each line names its own card: its text is `#passcode`, one per card.
          [...lines].map((l) => ('text' in l ? l.text : l.id)),
        ),
      ).toBe(target);
    });

    it('reads 15,174 as the inclusion–exclusion it is', () => {
      expect(choose(40, 5) - 3 * choose(37, 5) + 3 * choose(34, 5) - choose(31, 5)).toBe(15_174);
    });
  });

  /**
   * A ceiling on `unique` counts DIFFERENT cards (Andy, 2026-09-22). Targets from
   * the lead's independent judge — an exhaustive search over assignments of
   * concrete cards written straight from the rule, no formula — for four
   * starters at three copies each in a deck of 40, hands of five.
   */
  describe('a ceiling on unique: the exact targets', () => {
    const four = [named('a', A, 3), named('b', B, 3), named('c', C, 3), named('e', E, 3)];

    it.each([
      ['exactly 2 unique {Four}', 220_284],
      ['2-3 unique {Four}', 270_612],
      ['0-1 unique {Four}', 384_804],
      ['exactly 4 unique {Four}', 2592],
      ['exactly 2 unique {Four}, 1x {Four}', 96_300],
      ['2 unique {Four}', 273_204],
    ] as const)('scores `%s` at exactly the target', (text, target) => {
      const template = uniqueTemplate([...four], [text]);
      expect(numeratorOf(template)).toEqual({ num: target, den: 658_008 });
      expect(oracleNumerator(template, [A, B, C, E])).toBe(target);
    });

    it('reads `exactly 4 unique` as the inclusion–exclusion it is: all four present', () => {
      let sum = 0;
      for (let k = 0; k <= 4; k++) sum += (-1) ** k * choose(4, k) * choose(40 - 3 * k, 5);
      expect(sum).toBe(2592);
    });

    it('makes `[a, b]` the hands meeting `a` less those meeting `b + 1`', () => {
      const at = (text: string) => numeratorOf(uniqueTemplate([...four], [text])).num;
      expect(at('2-3 unique {Four}')).toBe(at('2 unique {Four}') - at('4 unique {Four}'));
      expect(at('exactly 2 unique {Four}')).toBe(at('2 unique {Four}') - at('3 unique {Four}'));
      expect(at('0-1 unique {Four}')).toBe(658_008 - at('2 unique {Four}'));
    });

    it('compiles the ceiling onto the unique requirement, and drops one no hand reaches', () => {
      const c = compiledOf(uniqueTemplate([...four], ['2-3 unique {Four}']));
      expect(c.problem.criteria).toEqual([
        { slots: [], limits: [], uniques: [{ mask: 0b11110, n: 2, max: 3 }] },
      ]);
      const wide = compiledOf(uniqueTemplate([...four], ['2-5 unique {Four}']));
      expect(wide.problem.criteria).toEqual([
        { slots: [], limits: [], uniques: [{ mask: 0b11110, n: 2 }] },
      ]);
      expect(wide.droppedCeilings).toEqual([
        { criterion: 0, desc: 0, n: 2, max: 5, reason: 'never-binds', unique: true },
      ]);
      // `0-5 unique` asks nothing once its ceiling goes, and is left out whole.
      const nothing = compiledOf(uniqueTemplate([...four], ['0-5 unique {Four}, 1x {Four}']));
      expect(nothing.problem.criteria[0]).not.toHaveProperty('uniques');
    });
  });

  it('compiles a unique requirement beside the slots, never into them', () => {
    const c = compiledOf(
      uniqueTemplate(
        [named('a', A, 3), named('b', B, 3), named('c', C, 3), named('e', E, 3)],
        ['3 unique {Starter}, 1x {Extender}'],
      ),
    );
    expect(membersOf(c)).toEqual([['remainder'], ['a'], ['b'], ['c'], ['e']]);
    expect(c.problem.criteria).toEqual([
      { slots: [0b11000], limits: [], uniques: [{ mask: 0b01110, n: 3 }] },
    ]);
  });

  describe('identity', () => {
    it('gives every card a unique requirement can take a class of its own', () => {
      // Without `unique` the three starters are one class; with it, three.
      const lines = [named('a', A, 3), named('b', B, 3), named('c', C, 3)];
      expect(membersOf(compiledOf(uniqueTemplate(lines, ['3x {Starter}'])))).toEqual([
        ['remainder'],
        ['a', 'b', 'c'],
      ]);
      expect(membersOf(compiledOf(uniqueTemplate(lines, ['3 unique {Starter}'])))).toEqual([
        ['remainder'],
        ['a'],
        ['b'],
        ['c'],
      ]);
    });

    it('scores two lines naming ONE passcode as one card, and merges them into one class', () => {
      const split = uniqueTemplate(
        [named('a1', A, 2), named('a2', A, 1), named('b', B, 3), named('c', C, 3)],
        ['3 unique {Starter}'],
      );
      const whole = uniqueTemplate(
        [named('a', A, 3), named('b', B, 3), named('c', C, 3)],
        ['3 unique {Starter}'],
      );
      expect(membersOf(compiledOf(split))).toEqual([['remainder'], ['a1', 'a2'], ['b'], ['c']]);
      expect(numeratorOf(split)).toEqual(numeratorOf(whole));
      expect(numeratorOf(split).num).toBe(15_174);
      // Told the two lines are DIFFERENT cards, the oracle finds more hands: the
      // merge is what keeps a second copy of A from passing for a fourth starter.
      const distinct = oracleNumerator(split, ['a1', 'a2', 'b', 'c']);
      expect(oracleNumerator(split, [A, A, B, C])).toBe(15_174);
      expect(distinct).toBeGreaterThan(15_174);
    });

    it('counts an "always treated as" pair as TWO cards: they have passcodes of their own', () => {
      const pair = uniqueTemplate(
        [named('harpy', CODE.harpy, 1), named('cyber', CODE.treatedAsHarpy, 1)],
        ['2 unique {Harpies}'],
        12,
      );
      const c = compiledOf(pair);
      expect(membersOf(c)).toEqual([['remainder'], ['harpy'], ['cyber']]);
      const { num } = createScorer(c.problem, 5).score(classTotalsOf(c, [1, 1], 12));
      // Both drawn: the other three of five from the ten others.
      expect(num).toBe(choose(10, 3));
      expect(oracleNumerator(pair, [CODE.harpy, CODE.treatedAsHarpy])).toBe(choose(10, 3));
    });

    it('splits nothing for a run that does not judge the unique requirement', () => {
      const lines = [named('a', A, 3), named('b', B, 3), named('c', C, 3)];
      const template: Template = {
        ...uniqueTemplate(lines, ['1x {Starter}', '3 unique {Starter}']),
        hand: { size: 6 },
        mode: 'average',
      };
      template.criteria = [
        { ...template.criteria[0]!, when: 'first' },
        { ...template.criteria[1]!, when: 'second' },
      ];
      const r = resolved(template);
      const going = (mode: 'first' | 'second') =>
        membersOf(compiled(r, { handSizes: handSizesForMode(r, mode) }));
      expect(going('first')).toEqual([['remainder'], ['a', 'b', 'c']]);
      expect(going('second')).toEqual([['remainder'], ['a'], ['b'], ['c']]);
    });

    it('says `unique` is why when it takes the classes past the cap', () => {
      const many = Array.from({ length: MAX_CLASSES }, (_, i) => 91_000_000 + i);
      const template = templateOf(
        many.map((passcode, i) => ({ id: `m${i}`, card: cardOf(passcode), min: 1, max: 1 })),
        ['2 unique {Many}'],
        { groups: [{ id: 'g-many', name: 'Many', cards: many.map(cardOf) }] },
      );
      const [message] = compileErrorsOf(template);
      expect(message).toContain(`tell ${MAX_CLASSES + 1} classes of card apart`);
      expect(message).toContain(
        'a `unique` requirement makes every different card it can take a class of its own',
      );
      expect(message).toContain('without that it would be 2');
      // Without `unique` the same template is two classes and compiles.
      expect(compileErrorsOf({ ...template, criteria: [{ id: 'c1', text: '2x {Many}' }] })).toEqual(
        [],
      );
    });
  });

  describe('a line that is not one card', () => {
    const starters = [named('a', A, 3), named('b', B, 3)];

    it.each([
      ['a group', 'g', '{Starter}'],
      ['an `or`', 'g', `#${A} or #${C}`],
      ['a generic description', 'g', 'level 4 or lower monster'],
    ])('refuses %s that could fill a unique requirement, naming the line', (_, id, text) => {
      const template = uniqueTemplate(
        [...starters, { id, text, min: 0, max: 3 }],
        ['2 unique ({Starter} or level 4 or lower monster)'],
      );
      expect(compileErrorsOf(template)).toEqual([
        `line "g" could be any of several cards, so how many different ones it holds is unknown — split it into one line per card to use it in a \`unique\` requirement`,
      ]);
    });

    it('refuses the unspecified cards when they could fill one', () => {
      expect(compileErrorsOf(uniqueTemplate(starters, ['2 unique card']))).toEqual([
        'the unspecified cards could be any cards at all, so how many different ones they hold is unknown — a `unique` requirement cannot count them; give the cards it should count lines of their own, one line per card',
      ]);
    });

    it('lets a vague line be, when no unique requirement is one it could fill', () => {
      const template = uniqueTemplate(
        [...starters, { id: 'mon', text: 'monster', min: 0, max: 3 }],
        ['2 unique {Starter}, 1x monster'],
      );
      expect(compileErrorsOf(template)).toEqual([]);
    });

    it('refuses it whichever hand the unique requirement is for', () => {
      const template: Template = {
        ...uniqueTemplate(
          [...starters, { id: 'g', text: '{Starter}', min: 0, max: 3 }],
          ['1x monster', '2 unique {Starter}'],
        ),
        hand: { size: 6 },
        mode: 'average',
      };
      template.criteria = [
        { ...template.criteria[0]!, when: 'first' },
        { ...template.criteria[1]!, when: 'second' },
      ];
      const r = resolved(template);
      const result = compileProblem(r, { handSizes: handSizesForMode(r, 'first') });
      expect(result.ok).toBe(false);
    });
  });

  /**
   * Going second, every window: the identities have to reach a `then` and a
   * `finally` part too, whose descriptions are columns like any other.
   */
  it('scores unique requirements after `then` and `finally` against the card-level oracle', () => {
    const lines = [named('a1', A, 2), named('a2', A, 1), named('b', B, 1), named('c', C, 1)];
    const identities = [A, A, B, C];
    for (const text of [
      'then 1 unique {Starter} finally 3 unique {Starter}',
      '2 unique {Starter} then 1x {Starter}',
      '1x {Starter} finally 2 unique {Starter} and at most 2x {Starter}',
      '2 unique {Starter} finally 3 unique {Starter}',
      // A ceiling on different cards, in each window.
      'exactly 2 unique {Starter} then 1x {Starter}',
      '1x {Starter} finally exactly 2 unique {Starter}',
      '0-1 unique {Starter} finally 2-3 unique {Starter}',
      'exactly 1 unique {Starter} then 1x card finally exactly 2 unique {Starter}, 1-2x {Starter}',
    ]) {
      const template: Template = {
        ...uniqueTemplate(lines, [text], 10),
        hand: { size: 6 },
        mode: 'second',
      };
      template.criteria = [{ ...template.criteria[0]!, when: 'second' }];
      const r = resolved(template);
      const c = compiled(r, { handSizes: [{ H: 6, weight: 1 }] });
      const { num, den } = createScorer(c.problem, 6).score(classTotalsOf(c, [2, 1, 1, 1], 10));
      expect(den, text).toBe(6 * choose(10, 6));
      const descOf = new Map<string | number, Description>([
        [A, r.lines[0]!.desc],
        [B, r.lines[2]!.desc],
        [C, r.lines[3]!.desc],
        ['remainder', r.lines[4]!.desc],
      ]);
      const oracle = cardLevelNumerator(
        lines.map(({ min }, at) => ({ copies: min, identity: identities[at]! })),
        { copies: 0, identity: 'remainder' },
        10,
        6,
        [r.criteria[0]!.expr],
        (identity, desc) => implies(descOf.get(identity)!, desc, impliesCtx),
        true,
      );
      expect(num, text).toBe(oracle);
      expect(num, text).toBeGreaterThan(0);
    }
  });

  /**
   * O1: every hand of a small deck with DUPLICATE copies — two lines naming one
   * card, an "always treated as" pair, a generic line beside them — dealt as
   * concrete cards and judged off the criterion's tree, against the engine's
   * exact numerator, for generated criteria with `unique` in them.
   */
  it('agrees with the card-level oracle on every hand of 150 generated criteria', () => {
    const lines: TemplateLine[] = [
      named('a1', A, 2),
      named('a2', A, 1),
      named('b', B, 2),
      named('c', C, 1),
      named('e', E, 1),
      named('harpy', CODE.harpy, 1),
      named('cyber', CODE.treatedAsHarpy, 1),
      { id: 'mon', text: 'monster', min: 2, max: 2 },
    ];
    const identities = [A, A, B, C, E, CODE.harpy, CODE.treatedAsHarpy, 'mon'];
    // What a `unique` requirement may ask for: descriptions only named lines fill.
    const uniquePool = ['{Starter}', '{Extender}', '{Harpies}', `#${A} or #${B}`, `#${A}`].map(
      (text) => descOfText(text),
    );
    const plainPool = [
      ...uniquePool,
      descOfText('monster'),
      descOfText('level 4 or lower monster'),
    ];
    const rng = seededRng(0x0e1d01e);
    let unique = 0;
    let nonzero = 0;
    for (let i = 0; i < 150; i++) {
      const raw = genExpr(rng, {
        desc: (r) => r.pick(plainPool),
        maxDepth: 2,
        maxArgs: 3,
        limitChance: 0.2,
        rangeChance: 0.15,
        uniqueChance: 0.5,
      });
      const expr = withUniquePool(raw, () => rng.pick(uniquePool));
      if (JSON.stringify(expr).includes('"unique":true')) unique++;
      const text = printCriterion(expr, descCtx);
      const template = uniqueTemplate(lines, [text], 14);
      const engine = numeratorOf(template).num;
      same(engine, oracleNumerator(template, identities), () => text);
      if (engine > 0) nonzero++;
    }
    expect(unique).toBeGreaterThan(100);
    expect(nonzero).toBeGreaterThan(75);
  });

  /**
   * O1 again, with ceilings on both kinds of requirement in a large share: a
   * ceiling on `unique` counts different cards, and the card-level oracle
   * judges each hand's leftovers by the cards each requirement actually took.
   */
  it('agrees with the card-level oracle on every hand of 150 generated criteria with ceilings on unique', () => {
    const lines: TemplateLine[] = [
      named('a1', A, 2),
      named('a2', A, 1),
      named('b', B, 2),
      named('c', C, 1),
      named('e', E, 1),
      named('harpy', CODE.harpy, 1),
      named('cyber', CODE.treatedAsHarpy, 1),
      { id: 'mon', text: 'monster', min: 2, max: 2 },
    ];
    const identities = [A, A, B, C, E, CODE.harpy, CODE.treatedAsHarpy, 'mon'];
    const uniquePool = ['{Starter}', '{Four}', '{Extender}', '{Harpies}', `#${A} or #${B}`].map(
      (text) => descOfText(text),
    );
    const plainPool = [...uniquePool, descOfText('monster')];
    const rng = seededRng(0x0e1d02a);
    let cappedUnique = 0;
    let cappedPlain = 0;
    let nonzero = 0;
    for (let i = 0; i < 150; i++) {
      const raw = genExpr(rng, {
        desc: (r) => r.pick(plainPool),
        maxDepth: 2,
        maxArgs: 3,
        limitChance: 0.15,
        rangeChance: 0.5,
        uniqueChance: 0.3,
        uniqueRangeChance: 0.6,
      });
      const expr = withUniquePool(raw, () => rng.pick(uniquePool));
      const json = JSON.stringify(expr);
      if (/"max":\d+,"unique":true/.test(json)) cappedUnique++;
      if (/"max":\d+,"desc"/.test(json)) cappedPlain++;
      const text = printCriterion(expr, descCtx);
      const template = uniqueTemplate(lines, [text], 14);
      const engine = numeratorOf(template).num;
      same(engine, oracleNumerator(template, identities), () => text);
      if (engine > 0) nonzero++;
    }
    expect(cappedUnique).toBeGreaterThan(75);
    expect(cappedPlain).toBeGreaterThan(40);
    expect(nonzero).toBeGreaterThan(60);
  });

  const descCtx = {
    cards: ctx.cards,
    setnames: ctx.setnames,
    groups: groupLookupOf(GROUPS),
  };
  function descOfText(text: string): Description {
    const result = parse(text, descCtx);
    if (!result.ok) throw new Error(`${text}: ${result.message}`);
    return canonicalize(result.desc);
  }
  /** `expr` with every `unique` requirement's description drawn from `pick` instead. */
  function withUniquePool(expr: Expr, pick: () => Description): Expr {
    if (expr.op === 'and' || expr.op === 'or')
      return { op: expr.op, args: expr.args.map((arg) => withUniquePool(arg, pick)) };
    if (expr.op === 'req' && expr.unique === true) return { ...expr, desc: pick() };
    return expr;
  }
});

/**
 * I5: a template with no `unique` in it compiles to the problem it always did.
 * Knowing which card a line is may change nothing until a `unique` requirement
 * asks — the partition, the masks and every key of the problem are what they
 * were without the field at all.
 */
describe('compiling without a unique requirement (I5)', () => {
  it('is byte for byte the same problem whether or not the lines say which card they are', () => {
    let merged = 0;
    for (const { input } of rangedProblems()) {
      const withCards: CompileInput = {
        ...input,
        lines: input.lines.map((l, at) => (l.isRemainder ? l : { ...l, card: 1_000 + (at % 3) })),
      };
      const before = compiled(input);
      const after = compiled(withCards);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(JSON.stringify(after.problem)).not.toContain('uniques');
      if (before.classes.slice(1).some((cls) => cls.lines.length > 1)) merged++;
    }
    // Lines that would part by card, were a `unique` requirement asking, stay merged.
    expect(merged).toBeGreaterThanOrEqual(200);
  });
});

describe('soleCard', () => {
  const card = (passcode: number) => ({ t: 'card', passcode }) as const;

  it('is the passcode of a description that names one card and nothing else', () => {
    expect(soleCard({ anyOf: [card(CODE.harpy)] })).toBe(CODE.harpy);
  });

  it('is nothing for an `or`, a group — even of one member — or a clause', () => {
    expect(soleCard({ anyOf: [card(1), card(2)] })).toBeUndefined();
    expect(soleCard({ anyOf: [{ t: 'group', groupId: 'g-one' }] })).toBeUndefined();
    expect(soleCard({ anyOf: [{ t: 'clause', clause: { kinds: ['monster'] } }] })).toBeUndefined();
  });

  it('is what resolving a template records on each line, and never on the remainder', () => {
    const r = resolved(
      templateOf(
        [
          line('named', `#${CODE.harpy}`),
          { id: 'picked', card: { passcode: CODE.tunerFairy, name: 'x' }, min: 0, max: 3 },
          line('generic', 'monster'),
        ],
        ['1x monster'],
      ),
    );
    expect(r.lines.map(({ card: passcode }) => passcode)).toEqual([
      CODE.harpy,
      CODE.tunerFairy,
      undefined,
      undefined,
    ]);
    expect(Object.keys(r.lines[2]!)).not.toContain('card');
  });
});

// ---------------------------------------------------------------------------
// A criterion's three fields through resolve and compile (PRD §5.5)
// ---------------------------------------------------------------------------

describe('the criterion fields through resolve and compile', () => {
  /**
   * The deck of the brief's targets: going second, 3 level 4 monsters, 3 level
   * 8 monsters, 8 traps and 26 other cards — every count pinned, so the run is
   * one deck and its score one exact fraction over 6 · C(40, 6) = 23,030,280.
   */
  const deck = (criteria: Template['criteria']): Template =>
    templateOf(
      [
        line('fours', 'level 4 monster', 3, 3),
        line('eights', 'level 8 monster', 3, 3),
        line('traps', 'trap', 8, 8),
      ],
      [],
      {
        hand: { size: 6 },
        mode: 'second',
        remainder: { min: 26, max: 26 },
        criteria: criteria.map((criterion) => ({ ...criterion, when: 'second' as const })),
      },
    );

  const scoreOf = (template: Template) => {
    const c = compiled(resolved(template));
    const totals = c.problem.classes.map(({ min }) => min);
    const [part] = scoreBlend(c.problem, totals).parts;
    return { num: part!.num, den: part!.den };
  };

  it('scores the opening five and the whole hand: 7,464,666 / 23,030,280', () => {
    const fields = scoreOf(
      deck([{ id: 'c1', opening: '1x level 4 monster', text: 'at most 1x level 8 monster' }]),
    );
    expect(fields).toEqual({ num: 7_464_666, den: 23_030_280 });
    // The same fraction as the version 1 keyword text it replaces.
    const keywords = validateTemplate({
      ...deck([]),
      version: 1,
      criteria: [
        {
          id: 'c1',
          text: '1x level 4 monster finally at most 1x level 8 monster',
          when: 'second',
        },
      ],
    });
    if (!keywords.ok) throw new Error(keywords.errors.join('\n'));
    expect(scoreOf(keywords.template)).toEqual(fields);
  });

  it('scores all three fields: 1,548,888 / 23,030,280, the shipped example’s number', () => {
    const three = deck([
      {
        id: 'c1',
        opening: '1x level 4 monster',
        drawn: '1x trap',
        text: 'at most 1x level 8 monster',
      },
    ]);
    expect(scoreOf(three)).toEqual({ num: 1_548_888, den: 23_030_280 });
    const example = validateTemplate(
      JSON.parse(
        readFileSync(new URL('../../../examples/going-second.json', import.meta.url), 'utf8'),
      ),
    );
    if (!example.ok) throw new Error(example.errors.join('\n'));
    expect(scoreOf(example.template)).toEqual({ num: 1_548_888, den: 23_030_280 });
  });

  /**
   * THE OPENING FIVE ALONE, which no keyword text could write: the first five
   * cards hold a level 4 monster, whatever the sixth is. Its number comes from
   * the hypergeometric directly — 1 − C(37, 5) / C(40, 5) — over the same
   * denominator, 6 · C(40, 6) orderings of which card is drawn last.
   */
  it('scores the opening five alone as a question about the first five cards', () => {
    const den = 6 * choose(40, 6);
    const expected = (den / choose(40, 5)) * (choose(40, 5) - choose(37, 5));
    const opening = scoreOf(deck([{ id: 'c1', opening: '1x level 4 monster', text: '' }]));
    expect(opening).toEqual({ num: expected, den });
    expect(expected).toBe(7_773_885);
    // Which is NOT the whole hand's `1x level 4 monster`, a different question.
    const whole = scoreOf(deck([{ id: 'c1', text: '1x level 4 monster' }]));
    expect(whole.num / whole.den).toBeGreaterThan(opening.num / opening.den);
  });

  it('compiles the whole hand alone to the PLAIN problem a going-first criterion has', () => {
    const second = compiled(resolved(deck([{ id: 'c1', text: '1x level 4 monster' }])));
    expect(second.problem.criteria[0]).not.toHaveProperty('sixth');
    expect(second.problem.criteria[0]).not.toHaveProperty('whole');
    expect(second.problem.handSizes[0]).not.toHaveProperty('drawn');
  });

  it('names the field a parse error is in', () => {
    const result = resolveTemplate(
      deck([{ id: 'c1', opening: '1x level 4 monster', drawn: '2x trap', text: '' }]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatch(/^criterion "c1" \(drawn\): the card you draw is one card/);
  });
});
