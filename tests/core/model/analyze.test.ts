import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  type Analysis,
  analyze,
  DEFAULT_COST,
  type Issue,
  SAMPLE_SIZE,
} from '../../../src/core/model/analyze';
import { compileProblem, REMAINDER_ID, resolveTemplate } from '../../../src/core/model/compile';
import type { Template, TemplateLine } from '../../../src/core/model/template';
import { createScorer } from '../../../src/core/prob/scorer';
import { same } from '../../helpers/assert';
import { CODE } from '../../helpers/fixture-cards';
import { rawRatiosOf } from '../../helpers/gen-ranged-problem';
import {
  FUZZ_GROUPS,
  genFuzzTemplate,
  genSmallTemplate,
  templateOf,
} from '../../helpers/gen-template';
import { motivatingContext, motivatingTemplate, ROTA, STRATOS } from '../../helpers/motivating';
import { seededRng } from '../../helpers/prng';

const ctx = motivatingContext(await initSqlJs());

const line = (id: string, text: string, min = 0, max = 3): TemplateLine => ({ id, text, min, max });
const card = (id: string, passcode: number, min = 0, max = 3): TemplateLine => ({
  id,
  card: { passcode, name: `card ${passcode}` },
  min,
  max,
});

/** `code` of each issue, errors first as `!code`. */
const codes = (issues: readonly Issue[]): string[] =>
  issues.map(({ severity, code }) => (severity === 'error' ? `!${code}` : code));

const lineOf = (a: Analysis, id: string) => a.lines.find((l) => l.id === id)!;
const requirementOf = (a: Analysis, text: string) => a.requirements.find((r) => r.text === text)!;
const limitOf = (a: Analysis, text: string) => a.limits.find((l) => l.text === text)!;
const criterionOf = (a: Analysis, id: string) => a.criteria.find((c) => c.id === id)!;

/** Every issue anywhere in the analysis. */
function allIssues(a: Analysis): Issue[] {
  return [
    ...a.issues,
    ...a.remainder.issues,
    ...[...a.lines, ...a.groups, ...a.requirements, ...a.limits, ...a.criteria].flatMap(
      (part) => part.issues,
    ),
  ];
}

describe('analyze', () => {
  describe('the motivating example, end to end (oracle A3)', () => {
    const a = analyze(motivatingTemplate(), ctx);

    it('finds nothing wrong with it', () => {
      expect(a.ok).toBe(true);
      expect(allIssues(a).filter((issue) => issue.severity !== 'notice')).toEqual([]);
      expect(a.deckSize).toBe(40);
      expect(a.handSize).toBe(5);
    });

    it('echoes each line, counts its matches and samples their names', () => {
      expect(lineOf(a, 'A')).toEqual({
        id: 'A',
        text: '[Elemental HERO Stratos]',
        min: 0,
        max: 3,
        parsed: { ok: true, canonical: `#${STRATOS}`, echo: 'Elemental HERO Stratos' },
        count: 1,
        samples: ['Elemental HERO Stratos'],
        issues: [],
      });
      const level4 = lineOf(a, 'level4');
      expect(level4.parsed).toEqual({
        ok: true,
        canonical: 'level 4 monster',
        echo: 'Level 4 · Monster',
      });
      expect(level4.count).toBeGreaterThan(SAMPLE_SIZE);
      expect(level4.samples).toHaveLength(SAMPLE_SIZE);
      expect(level4.samples).toContain('Elemental HERO Stratos');
    });

    it('shows which lines fill each requirement', () => {
      expect(a.requirements.map((r) => [r.text, r.filledBy])).toEqual([
        [`#${STRATOS}`, ['A']],
        [`#${ROTA}`, ['B']],
        ['monster', ['A', 'monster', 'level4', 'fire-bw']],
        ['level 4 or lower monster', ['A', 'level4']],
      ]);
      expect(requirementOf(a, 'monster').appearsIn).toEqual([
        { criterion: 'c1', alternative: 0, n: 1 },
      ]);
      expect(requirementOf(a, `#${STRATOS}`).appearsIn).toEqual([
        { criterion: 'c1', alternative: 0, n: 1 },
        { criterion: 'c2', alternative: 0, n: 1 },
      ]);
    });

    it('reports `monster` as a near miss for `level 4 or lower monster`: Level unstated', () => {
      const misses = requirementOf(a, 'level 4 or lower monster').nearMisses;
      expect(misses.find((miss) => miss.line === 'monster')).toEqual({
        line: 'monster',
        isRemainder: false,
        dimension: 'level',
        reason: 'unstated',
        explanation: '`monster`: Level unstated',
        suggestion: 'level 4 or lower monster',
      });
      // The Level 8 line is no near miss — it cannot hold such a card — and the remainder is one.
      expect(misses.map((miss) => miss.line)).toEqual(['monster', REMAINDER_ID]);
      expect(misses[1]).toMatchObject({
        isRemainder: true,
        explanation: '`card`: kind unstated',
        suggestion: 'level 4 or lower monster',
      });
    });

    it('reports criterion c2 as subsumed by c1, and not the other way round', () => {
      expect(criterionOf(a, 'c2').subsumed).toEqual([
        { alternative: 0, by: { criterion: 'c1', alternative: 0 } },
      ]);
      expect(criterionOf(a, 'c2').redundant).toBe(true);
      expect(codes(criterionOf(a, 'c2').issues)).toEqual(['subsumed']);
      expect(criterionOf(a, 'c2').issues[0]!.message).toMatch(/adds nothing.*"c1"/);
      expect(criterionOf(a, 'c1')).toMatchObject({ subsumed: [], redundant: false, issues: [] });
    });

    it('previews the expansion of each criterion', () => {
      expect(criterionOf(a, 'c1')).toMatchObject({
        name: 'A, B and any monster',
        parsed: { ok: true, canonical: `1x #${STRATOS} and 1x #${ROTA} and 1x monster` },
        alternatives: [`1x #${STRATOS}, 1x #${ROTA}, 1x monster`],
        dropped: 0,
        absentCards: [],
      });
    });

    it('derives the totals: known monsters 7–14, known spells 0–13, remainder 13–33', () => {
      expect(a.totals).toEqual({
        feasible: true,
        kinds: [
          {
            kind: 'monster',
            lines: ['A', 'monster', 'level4', 'fire-bw'],
            range: { min: 7, max: 14 },
          },
          { kind: 'spell', lines: ['B', 'spell', 'normal-spell'], range: { min: 0, max: 13 } },
          { kind: 'trap', lines: [], range: { min: 0, max: 0 } },
        ],
        lines: { min: 7, max: 27 },
        remainder: { min: 13, max: 33 },
      });
      expect(a.remainder).toEqual({
        id: REMAINDER_ID,
        canonical: 'card',
        echo: 'Any card',
        count: 22,
        min: 0,
        max: null,
        range: { min: 13, max: 33 },
        issues: [],
      });
    });

    it('shows the five classes, and that `spell`, `normal spell` and the remainder are irrelevant', () => {
      expect(a.classes).toEqual({
        classes: [
          { lines: ['spell', 'normal-spell', REMAINDER_ID], min: 0, max: 50 },
          { lines: ['A'], min: 0, max: 3 },
          { lines: ['B'], min: 0, max: 3 },
          { lines: ['monster', 'fire-bw'], min: 5, max: 8 },
          { lines: ['level4'], min: 2, max: 3 },
        ],
        alternatives: 2,
        irrelevant: ['spell', 'normal-spell', REMAINDER_ID],
        droppedLimits: [],
      });
    });

    it('counts the work: 4,096 raw ratios, 128 class vectors, and the terms of a score', () => {
      const resolved = resolveTemplate(motivatingTemplate(), ctx);
      if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
      const compiled = compileProblem(resolved.resolved);
      if (!compiled.ok) throw new Error('the motivating example compiles');
      const { terms, complemented } = createScorer(compiled.problem, 5);
      expect(a.work).toEqual({
        rawRatios: 4096,
        classVectors: 128,
        hands: [{ H: 5, terms, complemented }],
        estimatedMs: (128 * (0.05 + 0.006 * terms)) / 1000,
        cost: DEFAULT_COST,
      });
      expect(terms).toBeGreaterThan(0);
    });

    it('is a plain JSON value', () => {
      expect(JSON.parse(JSON.stringify(a))).toStrictEqual(a);
    });
  });

  describe('lines (oracle A4)', () => {
    it('reports an unknown word where it is, with the parser’s suggestion', () => {
      const a = analyze(templateOf([line('typo', 'level 4 monstr')], ['1x monster']), ctx);
      expect(lineOf(a, 'typo')).toMatchObject({
        parsed: { ok: false, span: { start: 8, end: 14 } },
        count: null,
        samples: [],
      });
      const [issue] = lineOf(a, 'typo').issues;
      expect(issue).toMatchObject({
        severity: 'error',
        code: 'parse',
        span: { start: 8, end: 14 },
      });
      expect(issue!.message).toMatch(/monstr.*monster/);
      expect(a.ok).toBe(false);
      // Everything that does not need the line is still there.
      expect(a.criteria[0]!.alternatives).toEqual(['1x monster']);
      expect(a.work.rawRatios).toBe(4);
      expect(a.classes).toBeNull();
      expect(a.work.classVectors).toBeNull();
    });

    it('only NOTES a generic description that matches no card: a line need not name cards that exist', () => {
      const a = analyze(
        templateOf([line('l7', 'level 7 FIRE beast-warrior monster')], ['1x monster']),
        ctx,
      );
      expect(lineOf(a, 'l7')).toMatchObject({ count: 0, samples: [] });
      expect(lineOf(a, 'l7').issues).toMatchObject([{ severity: 'notice', code: 'no-match' }]);
      expect(a.ok).toBe(true);
      // It is an ordinary line: it has its place in the classes and fills `1x monster`.
      expect(a.classes!.classes[1]).toEqual({ lines: ['l7'], min: 0, max: 3 });
      expect(requirementOf(a, 'monster').filledBy).toEqual(['l7']);
    });

    it('only WARNS about a picker card the database lacks', () => {
      const a = analyze(templateOf([card('gone', 12345)], [`1x monster`]), ctx);
      expect(lineOf(a, 'gone')).toMatchObject({
        text: '#12345',
        parsed: { ok: true, canonical: '#12345', echo: 'Unknown card #12345' },
        count: 0,
      });
      expect(codes(lineOf(a, 'gone').issues)).toEqual(['card-missing']);
      expect(lineOf(a, 'gone').issues[0]!.message).toMatch(/#12345 \(card 12345\)/);
      expect(a.ok).toBe(true);
    });

    it('caps a line that names one card at three copies, however it is written', () => {
      const a = analyze(
        templateOf(
          [
            card('picked', STRATOS, 0, 4),
            line('typed', '[Reinforcement of the Army]', 0, 4),
            line('choice', '[Elemental HERO Stratos] or [Reinforcement of the Army]', 0, 6),
            card('fine', CODE.tunerFairy, 0, 3),
          ],
          ['1x monster'],
        ),
        ctx,
      );
      expect(codes(lineOf(a, 'picked').issues)).toContain('!named-max');
      expect(codes(lineOf(a, 'typed').issues)).toContain('!named-max');
      expect(lineOf(a, 'typed').issues[0]!.message).toMatch(/`max` is 4.*at most 3 copies/);
      expect(codes(lineOf(a, 'choice').issues)).not.toContain('!named-max');
      expect(lineOf(a, 'fine').issues).toEqual([]);
    });

    it('rejects min > max, and counts no ratio through it', () => {
      const a = analyze(templateOf([line('m', 'monster', 3, 2)], ['1x monster']), ctx);
      expect(codes(lineOf(a, 'm').issues)).toEqual(['!min-over-max']);
      expect(a.work.rawRatios).toBe(0);
      expect(a.totals.feasible).toBe(false);
      expect(a.classes).toBeNull();
    });

    it('rejects lines that share a copy limit and together exceed it, naming them (TDD §4.3)', () => {
      // "Synthetic Cyber Harpy" is always treated as "Synthetic Harpy": one limit of three.
      const lines = (harpyMax: number, cyberMax: number) => [
        card('harpy', CODE.harpy, 0, harpyMax),
        line('cyber', '[Synthetic Cyber Harpy]', 0, cyberMax),
        card('other', CODE.tunerFairy, 0, 3),
      ];
      const over = analyze(templateOf(lines(3, 2), ['1x monster']), ctx);
      expect(codes(lineOf(over, 'harpy').issues)).toEqual(['!shared-limit']);
      expect(codes(lineOf(over, 'cyber').issues)).toEqual(['!shared-limit']);
      expect(lineOf(over, 'harpy').issues[0]!.message).toMatch(
        /"harpy", "cyber".*up to 5 copies.*at most 3/,
      );
      expect(lineOf(over, 'other').issues).toEqual([]);
      // Exactly three between them is legal.
      const atLimit = analyze(templateOf(lines(2, 1), ['1x monster']), ctx);
      expect(allIssues(atLimit)).toEqual([]);
    });

    it('warns about the same card on two lines', () => {
      const a = analyze(
        templateOf(
          [card('one', STRATOS, 0, 1), line('two', '[Elemental HERO Stratos]', 0, 2)],
          ['1x monster'],
        ),
        ctx,
      );
      expect(codes(lineOf(a, 'one').issues)).toEqual(['duplicate-card']);
      expect(codes(lineOf(a, 'two').issues)).toEqual(['duplicate-card']);
      expect(lineOf(a, 'one').issues[0]!.message).toMatch(/"one", "two"/);
      expect(a.ok).toBe(true);
      // Two and two is one card too many as well.
      const over = analyze(
        templateOf([card('one', STRATOS, 0, 2), card('two', STRATOS, 0, 2)], ['1x monster']),
        ctx,
      );
      expect(codes(lineOf(over, 'one').issues)).toEqual(['!shared-limit', 'duplicate-card']);
    });

    it('rejects a line that can hold no card: an empty group, a contradiction', () => {
      const a = analyze(
        templateOf([line('nobody', '{Empty}'), line('never', 'level 4 spell')], ['1x monster'], {
          groups: FUZZ_GROUPS,
        }),
        ctx,
      );
      // Not also "matches no card": that would say the same thing twice, less precisely.
      expect(codes(lineOf(a, 'nobody').issues)).toEqual(['!unsatisfiable']);
      expect(lineOf(a, 'nobody').issues[0]!.message).toMatch(/group.*Empty.*empty/);
      expect(codes(lineOf(a, 'never').issues)).toEqual(['!unsatisfiable']);
      expect(a.groups.find((g) => g.id === 'g-empty')).toMatchObject({ size: 0 });
      expect(codes(a.groups.find((g) => g.id === 'g-empty')!.issues)).toEqual(['empty-group']);
    });

    it('warns about a group with members the database lacks, on the group and on its lines', () => {
      const a = analyze(
        templateOf([line('b', '{Broken}'), line('s', '{Starters}')], ['1x monster'], {
          groups: FUZZ_GROUPS,
        }),
        ctx,
      );
      expect(a.groups.map((g) => [g.id, g.size, g.missing])).toEqual([
        ['g-starters', 2, []],
        ['g-empty', 0, []],
        ['g-broken', 2, [12345]],
      ]);
      expect(codes(a.groups[2]!.issues)).toEqual(['group-missing-members']);
      expect(codes(lineOf(a, 'b').issues)).toEqual(['group-missing-members']);
      expect(lineOf(a, 'b').issues[0]!.message).toMatch(/Broken.*#12345/);
      expect(lineOf(a, 's').issues).toEqual([]);
    });
  });

  describe('requirements and limits (oracle A4)', () => {
    const lines = [
      line('m', 'monster', 5, 5),
      line('t', 'trap', 0, 2),
      line('any', 'spell/trap', 1, 4),
      line('s', 'spell', 0, 3),
    ];

    it('warns about a requirement no line fills', () => {
      const a = analyze(templateOf(lines, ['1x level 4 monster']), ctx);
      const requirement = requirementOf(a, 'level 4 monster');
      expect(requirement.filledBy).toEqual([]);
      expect(codes(requirement.issues)).toEqual(['unfilled']);
      expect(requirement.nearMisses.map((miss) => miss.explanation)).toEqual([
        '`monster`: Level unstated',
        '`card`: kind unstated',
      ]);
    });

    it('shows what a limit counts, and the under-specified lines it ignores, with their total', () => {
      const a = analyze(templateOf(lines, ['1x monster, at most 1x trap']), ctx);
      const limit = limitOf(a, 'trap');
      expect(limit).toMatchObject({
        appearsIn: [{ criterion: 'c1', alternative: 0, n: 1 }],
        counts: ['t'],
        ignored: [
          { line: 'any', isRemainder: false, min: 1, max: 4 },
          // 40 less at least 6, and at most 14, on the lines.
          { line: REMAINDER_ID, isRemainder: true, min: 26, max: 34 },
        ],
        // The lines that cannot hold a trap take 5 to 10 cards; these two share the rest.
        ignoredRange: { min: 30, max: 35 },
        countsNothing: false,
      });
      expect(codes(limit.issues)).toEqual(['limit-ignores']);
      expect(limit.issues[0]).toMatchObject({ severity: 'notice' });
      expect(limit.issues[0]!.message).toBe(
        'a limit on `trap` ignores 30–35 cards of lines that do not say whether they match: "any", the remainder — if some do, give them a line that says so',
      );
      // `monster` and `spell` cannot hold a trap: neither counted nor ignored.
    });

    it('reads "13–33 unspecified cards" off the motivating example (PRD §6.3)', () => {
      const template = motivatingTemplate();
      template.criteria = [{ id: 'c1', text: '1x [Elemental HERO Stratos], at most 1x trap' }];
      const limit = limitOf(analyze(template, ctx), 'trap');
      expect(limit.ignored).toEqual([{ line: REMAINDER_ID, isRemainder: true, min: 13, max: 33 }]);
      expect(limit.ignoredRange).toEqual({ min: 13, max: 33 });
      // Nothing counts against it at all: it holds of every hand.
      expect(limit.countsNothing).toBe(true);
      expect(codes(limit.issues)).toEqual(['limit-counts-nothing', 'limit-ignores']);
    });

    it('keeps a description that is both required and limited in both lists', () => {
      const a = analyze(templateOf(lines, ['1x trap or (1x monster, no trap)']), ctx);
      expect(requirementOf(a, 'trap').filledBy).toEqual(['t']);
      expect(limitOf(a, 'trap').counts).toEqual(['t']);
      expect(limitOf(a, 'trap').appearsIn).toEqual([{ criterion: 'c1', alternative: 1, n: 0 }]);
    });
  });

  describe('criteria (oracle A4)', () => {
    const lines = [line('m', 'monster', 0, 5), line('s', 'spell', 0, 3)];

    it('reports a criterion that does not parse where it is, and goes on', () => {
      const a = analyze(templateOf(lines, ['1x monstr', '1x spell']), ctx);
      expect(criterionOf(a, 'c1')).toMatchObject({
        parsed: { ok: false, span: { start: 3, end: 9 } },
        alternatives: [],
      });
      expect(codes(criterionOf(a, 'c1').issues)).toEqual(['!parse']);
      expect(criterionOf(a, 'c2').alternatives).toEqual(['1x spell']);
      expect(requirementOf(a, 'spell').filledBy).toEqual(['s']);
      expect(a.classes).toBeNull();
    });

    it('previews the expansion, and counts what is dropped', () => {
      const a = analyze(
        templateOf(lines, ['(1x monster or 2x spell), at most 1x trap, (6x monster or 1x card)']),
        ctx,
      );
      expect(criterionOf(a, 'c1').alternatives).toEqual([
        '1x monster, 1x card, at most 1x trap',
        '2x spell, 1x card, at most 1x trap',
      ]);
      expect(criterionOf(a, 'c1').dropped).toBe(2);
    });

    it('reports the expansion cap, on the criterion and on the criteria together', () => {
      // `slots` four-way choices between distinct descriptions: 4^slots alternatives.
      const choices = (offset: number, slots: number) =>
        Array.from(
          { length: slots },
          (_, i) =>
            `(${[0, 1, 2, 3].map((j) => `1x ATK ${offset + 4 * i + j} monster`).join(' or ')})`,
        ).join(' and ');
      const one = analyze(templateOf(lines, [choices(0, 5)]), ctx);
      expect(codes(criterionOf(one, 'c1').issues)).toEqual(['!expansion-cap']);
      expect(criterionOf(one, 'c1').issues[0]!.message).toMatch(/more than 256 alternatives/);
      expect(one.classes).toBeNull();

      // 256 alternatives apiece is allowed; 512 together is not.
      const together = analyze(templateOf(lines, [choices(0, 4), choices(100, 4)]), ctx);
      expect(together.criteria.map((c) => c.alternatives.length)).toEqual([256, 256]);
      expect(codes(together.criteria.flatMap((c) => c.issues))).not.toContain('!expansion-cap');
      expect(codes(together.issues)).toContain('!expansion-cap');
      expect(together.classes).toBeNull();
    });

    it('says a criterion can never be met when every alternative was dropped', () => {
      const a = analyze(templateOf(lines, ['6x monster', '1x monster']), ctx);
      expect(criterionOf(a, 'c1')).toMatchObject({
        alternatives: [],
        dropped: 1,
        neverSatisfiable: { reason: 'every-alternative-dropped', unfilled: [] },
      });
      expect(codes(criterionOf(a, 'c1').issues)).toEqual(['never-satisfiable']);
      expect(criterionOf(a, 'c2')).not.toHaveProperty('neverSatisfiable');
    });

    it('says so when EVERY alternative has a requirement no line fills, and which', () => {
      const a = analyze(
        templateOf(lines, ['(1x level 4 monster, 1x spell) or 1x trap', '1x monster or 1x trap']),
        ctx,
      );
      expect(criterionOf(a, 'c1').neverSatisfiable).toEqual({
        reason: 'unfilled-requirement',
        unfilled: [['level 4 monster'], ['trap']],
      });
      expect(criterionOf(a, 'c1').issues[0]!.message).toMatch(/`level 4 monster`.*`trap`/);
      // One alternative that can be met is enough.
      expect(criterionOf(a, 'c2')).not.toHaveProperty('neverSatisfiable');
      expect(codes(criterionOf(a, 'c2').issues)).not.toContain('never-satisfiable');
    });

    it('notices an alternative subsumed within its own criterion, without calling the criterion redundant', () => {
      const a = analyze(templateOf(lines, ['1x monster or (1x monster, 1x spell)']), ctx);
      expect(criterionOf(a, 'c1').subsumed).toEqual([
        { alternative: 1, by: { criterion: 'c1', alternative: 0 } },
      ]);
      expect(criterionOf(a, 'c1').redundant).toBe(false);
      expect(codes(criterionOf(a, 'c1').issues)).toEqual(['subsumed']);
    });

    it('does not call a criterion redundant while one of its alternatives adds something', () => {
      const a = analyze(
        templateOf(lines, ['1x monster', '(1x monster, 1x spell) or 1x spell']),
        ctx,
      );
      expect(criterionOf(a, 'c2').subsumed).toEqual([
        { alternative: 0, by: { criterion: 'c1', alternative: 0 } },
      ]);
      expect(criterionOf(a, 'c2').redundant).toBe(false);
      expect(criterionOf(a, 'c2').issues.map((issue) => issue.message)).toEqual([
        'alternative 1 (`1x monster, 1x spell`) adds nothing: every hand that meets it already meets alternative 1 of criterion "c1"',
      ]);
    });

    it('reports the LATER of two identical criteria', () => {
      const a = analyze(templateOf(lines, ['1x monster, 1x spell', '1x spell, 1x monster']), ctx);
      expect(criterionOf(a, 'c1').subsumed).toEqual([]);
      expect(criterionOf(a, 'c2')).toMatchObject({
        subsumed: [{ alternative: 0, by: { criterion: 'c1', alternative: 0 } }],
        redundant: true,
      });
    });

    it('skips the subsumption check past 128 alternatives, and says so', () => {
      // Three four-way choices between distinct descriptions: 64 alternatives.
      const choices = (offset: number) =>
        [0, 4, 8]
          .map(
            (i) => `(${[0, 1, 2, 3].map((j) => `1x ATK ${offset + i + j} monster`).join(' or ')})`,
          )
          .join(' and ');
      // 64 alternatives and one more, which the first of them subsumes.
      const checked = analyze(
        templateOf(lines, [choices(0), '2x ATK 0 monster, 1x ATK 4 monster, 1x ATK 8 monster']),
        ctx,
      );
      expect(codes(checked.issues)).toEqual([]);
      expect(criterionOf(checked, 'c2').redundant).toBe(true);
      // 192 and one.
      const skipped = analyze(
        templateOf(lines, [choices(0), choices(100), choices(200), '1x ATK 0 monster']),
        ctx,
      );
      expect(codes(skipped.issues)).toEqual(['subsumption-skipped']);
      expect(skipped.issues[0]!.message).toMatch(/193 alternatives; past 128/);
      expect(skipped.criteria.flatMap((c) => c.subsumed)).toEqual([]);
      expect(skipped.classes).not.toBeNull();
    });

    it('warns about a card a criterion names and no line does', () => {
      const a = analyze(
        templateOf(
          [...lines, card('a', STRATOS), line('g', '{Starters}')],
          [
            `1x [Elemental HERO Stratos], 1x [Reinforcement of the Army]`,
            '1x [Synthetic Tuner Fairy] or 1x monster',
          ],
          { groups: FUZZ_GROUPS },
        ),
        ctx,
      );
      // Stratos has a line; Reinforcement of the Army is in a group that has one.
      expect(criterionOf(a, 'c1').absentCards).toEqual([]);
      expect(criterionOf(a, 'c2').absentCards).toEqual([
        { passcode: CODE.tunerFairy, name: 'Synthetic Tuner Fairy' },
      ]);
      expect(codes(criterionOf(a, 'c2').issues)).toContain('absent-card');
      expect(criterionOf(a, 'c2').issues[0]!.message).toMatch(
        /Synthetic Tuner Fairy \(#90000020\), which no line of the template names/,
      );
    });

    it('warns when there is no criterion at all', () => {
      const a = analyze(templateOf(lines, []), ctx);
      expect(codes(a.issues)).toEqual(['no-criteria']);
      expect(a.ok).toBe(true);
      expect(a.classes!.irrelevant).toEqual(['m', 's', REMAINDER_ID]);
    });
  });

  describe('totals (oracle A4)', () => {
    it('counts a line towards a kind only if it IMPLIES the kind', () => {
      const a = analyze(
        templateOf(
          [
            line('m', 'monster', 2, 4),
            line('l4', 'level 4', 1, 1),
            line('st', 'spell/trap', 0, 5),
            line('any', 'card', 0, 9),
            card('rota', ROTA, 1, 3),
          ],
          ['1x monster'],
        ),
        ctx,
      );
      expect(a.totals.kinds).toEqual([
        { kind: 'monster', lines: ['m', 'l4'], range: { min: 3, max: 5 } },
        { kind: 'spell', lines: ['rota'], range: { min: 1, max: 3 } },
        { kind: 'trap', lines: [], range: { min: 0, max: 0 } },
      ]);
    });

    it('squeezes a total by what the rest of the deck must and can hold', () => {
      const a = analyze(
        templateOf([line('m', 'monster', 0, 40), line('s', 'spell', 10, 12)], ['1x monster'], {
          remainder: { min: 5, max: 8 },
        }),
        ctx,
      );
      // 40 less 12 + 8 at the least, less 10 + 5 at the most.
      expect(a.totals.kinds[0]!.range).toEqual({ min: 20, max: 25 });
      expect(a.totals.remainder).toEqual({ min: 5, max: 8 });
    });

    it('rejects ranges whose minimums overfill the deck', () => {
      const a = analyze(
        templateOf([line('m', 'monster', 30, 35), line('s', 'spell', 12, 13)], ['1x monster']),
        ctx,
      );
      expect(codes(a.issues)).toEqual(['!infeasible']);
      expect(a.issues[0]!.message).toMatch(/at least 42 cards.*deck of 40/);
      expect(a.totals).toMatchObject({ feasible: false, remainder: null });
      expect(a.totals.kinds[0]).toEqual({ kind: 'monster', lines: ['m'], range: null });
      expect(a.work.rawRatios).toBe(0);
      expect(a.work.classVectors).toBe(0);
      expect(a.ok).toBe(false);
    });

    it('rejects ranges that cannot reach the deck size', () => {
      const a = analyze(
        templateOf([line('m', 'monster', 0, 20)], ['1x monster'], {
          remainder: { min: 0, max: 19 },
        }),
        ctx,
      );
      expect(codes(a.issues)).toEqual(['!infeasible']);
      expect(a.issues[0]!.message).toMatch(/at most 39 cards.*deck of 40/);
      expect(a.remainder.range).toBeNull();
    });
  });

  describe('the match memo', () => {
    it('gives the same analysis, and scans the database once per distinct description', () => {
      let scans = 0;
      const counting = {
        ...ctx,
        cards: Object.assign(Object.create(ctx.cards), {
          count: (pred: Parameters<typeof ctx.cards.count>[0]) => {
            scans++;
            return ctx.cards.count(pred);
          },
        }) as typeof ctx.cards,
      };
      const template = motivatingTemplate();
      // Seven lines and the remainder.
      const plain = analyze(template, counting);
      expect(scans).toBe(8);

      const memo = new Map();
      expect(analyze(template, { ...counting, memo })).toStrictEqual(plain);
      expect(scans).toBe(16);
      expect(memo.size).toBe(8);
      // An edit to one line scans for that line only.
      template.lines[2] = line('monster', 'level 5 monster', 5, 5);
      const edited = analyze(template, { ...counting, memo });
      expect(scans).toBe(17);
      expect(edited).toStrictEqual(analyze(template, ctx));
      // What comes out of the memo is a copy: a caller cannot corrupt it.
      lineOf(edited, 'A').samples.push('not a card');
      expect(lineOf(analyze(template, { ...counting, memo }), 'A').samples).toEqual([
        'Elemental HERO Stratos',
      ]);
    });

    it('keys a group by its members, not only its id', () => {
      const memo = new Map();
      const of = (cards: number[]) =>
        analyze(
          templateOf([line('g', '{Starters}')], ['1x monster'], {
            groups: [
              {
                id: 'g-starters',
                name: 'Starters',
                cards: cards.map((passcode) => ({ passcode, name: `card ${passcode}` })),
              },
            ],
          }),
          { ...ctx, memo },
        );
      expect(lineOf(of([STRATOS, ROTA]), 'g').count).toBe(2);
      expect(lineOf(of([STRATOS]), 'g').count).toBe(1);
    });
  });

  describe('classes and work', () => {
    it('reports more than 30 classes as an error, naming the count', () => {
      const lines = Array.from({ length: 30 }, (_, i) => line(`atk${i}`, `ATK ${i * 100} monster`));
      const criteria = lines.map((l) => `1x ${(l as { text: string }).text}`);
      const a = analyze(templateOf(lines, criteria), ctx);
      expect(codes(a.issues)).toContain('!compile');
      expect(a.issues.find((issue) => issue.code === 'compile')!.message).toMatch(/31 classes/);
      expect(a.classes).toBeNull();
      expect(a.work.classVectors).toBeNull();
      expect(a.work.rawRatios).toBeTypeOf('string');
    });

    it('lists the limits the engine leaves out', () => {
      const a = analyze(
        templateOf([line('m', 'monster')], ['1x monster, at most 1x trap, at most 5x monster']),
        ctx,
      );
      expect(a.classes!.droppedLimits).toEqual([
        { criterion: 0, text: 'trap', n: 1, reason: 'counts-nothing' },
        { criterion: 0, text: 'monster', n: 5, reason: 'never-binds' },
      ]);
    });

    it('prices the work with the cost model it is given', () => {
      const a = analyze(motivatingTemplate(), ctx, { cost: { perVectorUs: 1, perTermNs: 0 } });
      expect(a.work.cost).toEqual({ perVectorUs: 1, perTermNs: 0 });
      expect(a.work.estimatedMs).toBeCloseTo(0.128, 10);
    });

    it('stays exact, and instant, when the raw ratios are past 2^53', () => {
      // Thirty `monster` lines of 0–3 copies: about 4^30 ratios, one non-blank class.
      const lines = Array.from({ length: 30 }, (_, i) => line(`m${i}`, 'monster'));
      const start = performance.now();
      const a = analyze(templateOf(lines, ['1x monster']), ctx);
      const elapsed = performance.now() - start;

      // By multiplying out (1 + x + x² + x³)^30 and adding up the coefficients up to x^40.
      let poly = [1n];
      for (let i = 0; i < 30; i++) {
        const next = new Array<bigint>(poly.length + 3).fill(0n);
        poly.forEach((c, at) => {
          for (let n = 0; n <= 3; n++) next[at + n]! += c;
        });
        poly = next;
      }
      const expected = poly.slice(0, 41).reduce((sum, c) => sum + c, 0n);
      expect(expected > 2n ** 53n).toBe(true);
      expect(a.work.rawRatios).toBe(expected.toString());
      // One merged class of 0–90 against a remainder of 0–40: totals 0 to 40.
      expect(a.work.classVectors).toBe(41);
      expect(a.classes!.classes).toHaveLength(2);
      expect(elapsed).toBeLessThan(1000);
    });
  });
});

// ---------------------------------------------------------------------------
// Oracle A1: the counts, by DP, against plain listing of every raw ratio.
// ---------------------------------------------------------------------------

describe('counting raw ratios and class vectors without listing them (oracle A1)', () => {
  const TEMPLATES = 300;

  it('agrees with listing every raw ratio of 300 small templates, infeasible ones included', () => {
    let listed = 0;
    let infeasible = 0;
    let cut = 0;
    for (let seed = 0; seed < TEMPLATES; seed++) {
      const template = genSmallTemplate(seededRng(81_000 + seed));
      const a = analyze(template, ctx);
      const ranges = template.lines.map(({ min, max }) => ({ min, max }));
      const ratios = rawRatiosOf(ranges, template.remainder, template.deckSize);
      same(a.work.rawRatios, ratios.length, () => template);
      listed += ratios.length;
      if (ratios.length === 0) infeasible++;
      const unconstrained = ranges.reduce((product, { min, max }) => product * (max - min + 1), 1);
      if (ratios.length > 0 && ratios.length < unconstrained) cut++;
      same(a.totals.feasible, ratios.length > 0, () => template);

      // Classes by an independent route: the match matrix of `resolveTemplate`, rows as strings.
      const resolved = resolveTemplate(template, ctx);
      if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
      const rows = resolved.resolved.matrix.map((row) => row.map((f) => (f ? 1 : 0)).join(''));
      const keys = [...new Set(rows)];
      const vectors = new Set(
        ratios.map((counts) => {
          const left = template.deckSize - counts.reduce((sum, n) => sum + n, 0);
          const totals = new Array<number>(keys.length).fill(0);
          [...counts, left].forEach((n, at) => {
            totals[keys.indexOf(rows[at]!)]! += n;
          });
          return totals.join(',');
        }),
      );
      same(a.work.classVectors, vectors.size, () => template);

      // The remainder's derived range is exactly what is left over, ratio by ratio.
      if (ratios.length > 0) {
        const left = ratios.map((counts) => 40 - counts.reduce((sum, n) => sum + n, 0));
        expect(a.remainder.range).toEqual({ min: Math.min(...left), max: Math.max(...left) });
      } else expect(a.remainder.range).toBeNull();

      // What fills what is `resolveTemplate`'s matrix, by id.
      const fillers = (at: number) =>
        resolved.resolved.descriptions[at]!.lines.map((i) => resolved.resolved.lines[i]!.id);
      resolved.resolved.descriptions.forEach((description, at) => {
        if (description.inRequirement)
          expect(a.requirements.find((r) => r.text === description.text)!.filledBy).toEqual(
            fillers(at),
          );
        if (description.inLimit)
          expect(a.limits.find((l) => l.text === description.text)!.counts).toEqual(fillers(at));
      });

      // And the classes are `compileProblem`'s.
      const compiled = compileProblem(resolved.resolved);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      expect(a.classes!.classes).toEqual(
        compiled.problem.classes.map(({ lineIds, min, max }) => ({ lines: lineIds, min, max })),
      );
    }
    expect(listed).toBeGreaterThan(17_000);
    expect(infeasible).toBeGreaterThanOrEqual(90);
    expect(cut).toBeGreaterThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Oracle A5: never throws.
// ---------------------------------------------------------------------------

describe('analyze never throws (oracle A5)', () => {
  it('returns a consistent, plain JSON analysis for 2,000 fuzzed templates', () => {
    const seen = { ok: 0, parse: 0, internal: 0, classes: 0, infeasible: 0 };
    for (let seed = 0; seed < 2000; seed++) {
      const rng = seededRng(91_000 + seed);
      // Mostly garbage; a valid template now and then, so that every outcome is reached.
      const template: Template = rng.chance(0.1) ? genSmallTemplate(rng) : genFuzzTemplate(rng);
      let a: Analysis;
      try {
        a = analyze(template, ctx);
      } catch (failure) {
        throw new Error(`seed ${seed}: ${(failure as Error).stack}\n${JSON.stringify(template)}`);
      }
      const issues = allIssues(a);
      same(a.ok, !issues.some((issue) => issue.severity === 'error'), () => template);
      same(a.lines.length, template.lines.length, () => template);
      same(a.criteria.length, template.criteria.length, () => template);
      expect(JSON.parse(JSON.stringify(a))).toStrictEqual(a);

      if (a.ok) seen.ok++;
      if (a.classes !== null) seen.classes++;
      if (!a.totals.feasible) seen.infeasible++;
      if (issues.some((issue) => issue.code === 'parse')) seen.parse++;
      if (issues.some((issue) => issue.code === 'internal')) seen.internal++;
    }
    // Nothing fell through to the catch-all, and every kind of outcome was reached.
    expect(seen.internal).toBe(0);
    expect(seen.ok).toBeGreaterThan(20);
    expect(seen.classes).toBeGreaterThan(200);
    expect(seen.parse).toBeGreaterThan(500);
    expect(seen.infeasible).toBeGreaterThan(500);
  });
});
