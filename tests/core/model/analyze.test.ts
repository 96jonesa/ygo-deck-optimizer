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
import type { DrawSpec } from '../../../src/core/model/problem';
import type { Template, TemplateLine } from '../../../src/core/model/template';
import { createScorer } from '../../../src/core/prob/scorer';
import { countToNumber } from '../../../src/core/util/count';
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
        // The motivating example has no range requirement, so none was dropped.
        droppedCeilings: [],
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
        hands: [{ H: 5, part: 'first', weight: 1, terms, complemented, groups: 1 }],
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

    it('lets a line that names one card hold more than three copies, however it is written', () => {
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
      // No copy limit is enforced (PRD §5.1): picked, typed or a choice, four is fine.
      for (const id of ['picked', 'typed', 'choice', 'fine'])
        expect(lineOf(a, id).issues, id).toEqual([]);
      expect(a.ok).toBe(true);
    });

    it('rejects min > max, and counts no ratio through it', () => {
      const a = analyze(templateOf([line('m', 'monster', 3, 2)], ['1x monster']), ctx);
      expect(codes(lineOf(a, 'm').issues)).toEqual(['!min-over-max']);
      expect(a.work.rawRatios).toBe(0);
      expect(a.totals.feasible).toBe(false);
      expect(a.classes).toBeNull();
    });

    it('lets lines that would share a copy limit in the game hold more than three between them (TDD §4.3)', () => {
      // "Synthetic Cyber Harpy" is always treated as "Synthetic Harpy", which EDOPro
      // counts as one card for its limit. No limit is enforced here, so five between
      // them is as fine as three.
      const over = analyze(
        templateOf(
          [
            card('harpy', CODE.harpy, 0, 3),
            line('cyber', '[Synthetic Cyber Harpy]', 0, 2),
            card('other', CODE.tunerFairy, 0, 3),
          ],
          ['1x monster'],
        ),
        ctx,
      );
      expect(allIssues(over)).toEqual([]);
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
      // Two and two is four copies of one card: still only the duplicate is worth a word.
      const over = analyze(
        templateOf([card('one', STRATOS, 0, 2), card('two', STRATOS, 0, 2)], ['1x monster']),
        ctx,
      );
      expect(codes(lineOf(over, 'one').issues)).toEqual(['duplicate-card']);
      expect(over.ok).toBe(true);
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

    // A stored AST is authoritative (TDD §14): the analysis has to be ABOUT the
    // description the run will compile, and to say when that is not the text on
    // screen. `analyze` and `resolveTemplate` share `lineMeaning` precisely so
    // the two can never answer this differently.
    it('analyzes a stale line as its STORED description, and flags it', () => {
      const a = analyze(
        templateOf(
          [
            {
              id: 'stale',
              text: 'monster',
              desc: { anyOf: [{ t: 'clause', clause: { kinds: ['trap'] } }] },
              min: 0,
              max: 3,
            },
          ],
          ['1x trap'],
        ),
        ctx,
      );
      expect(lineOf(a, 'stale').parsed).toMatchObject({ ok: true, canonical: 'trap' });
      expect(codes(lineOf(a, 'stale').issues)).toEqual(['stale-text']);
      expect(requirementOf(a, 'trap').filledBy).toEqual(['stale']);
      // A warning, not an error: the file means something, and it still runs.
      expect(a.ok).toBe(true);
    });

    it('analyzes a stale criterion as its STORED expression, and flags it', () => {
      const a = analyze(
        {
          ...templateOf([line('m', 'monster', 5, 5)], []),
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
        },
        ctx,
      );
      expect(criterionOf(a, 'c1').parsed).toMatchObject({ ok: true, canonical: '1x monster' });
      expect(codes(criterionOf(a, 'c1').issues)).toEqual(['stale-text']);
      expect(a.requirements.map((r) => r.text)).toEqual(['monster']);
      expect(a.ok).toBe(true);
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

    describe('range requirements', () => {
      it('carries the ceiling into the appearance and the expansion preview', () => {
        const a = analyze(templateOf(lines, ['1x monster, 1-2x trap']), ctx);
        expect(requirementOf(a, 'trap').appearsIn).toEqual([
          { criterion: 'c1', alternative: 0, n: 1, max: 2 },
        ]);
        expect(criterionOf(a, 'c1').alternatives).toEqual(['1x monster, 1-2x trap']);
        // A requirement with no ceiling leaves the key out.
        expect(requirementOf(a, 'monster').appearsIn).toEqual([
          { criterion: 'c1', alternative: 0, n: 1 },
        ]);
      });

      it('reports what a CEILING cannot see, as a limit does', () => {
        const a = analyze(templateOf(lines, ['1x monster, 1-2x trap']), ctx);
        const requirement = requirementOf(a, 'trap');
        expect(requirement).toMatchObject({
          bounded: true,
          filledBy: ['t'],
          ignored: [
            { line: 'any', isRemainder: false, min: 1, max: 4 },
            { line: REMAINDER_ID, isRemainder: true, min: 26, max: 34 },
          ],
          ignoredRange: { min: 30, max: 35 },
        });
        expect(codes(requirement.issues)).toEqual(['requirement-ignores']);
        expect(requirement.issues[0]).toMatchObject({ severity: 'notice' });
        expect(requirement.issues[0]!.message).toContain('the ceiling on `trap` ignores 30–35');
      });

      it('says nothing of the kind for a requirement with no ceiling', () => {
        const a = analyze(templateOf(lines, ['1x monster, 1x trap']), ctx);
        expect(requirementOf(a, 'trap')).toMatchObject({
          bounded: false,
          ignored: [],
          ignoredRange: null,
          issues: [],
        });
      });

      it('lists a ceiling the engine leaves out because no hand can exceed it', () => {
        const a = analyze(templateOf(lines, ['1-5x monster']), ctx);
        expect(a.classes?.droppedCeilings).toEqual([
          { criterion: 0, text: 'monster', n: 1, max: 5, reason: 'never-binds' },
        ]);
        // It is still a range as far as the reader is concerned.
        expect(requirementOf(a, 'monster').bounded).toBe(true);
      });
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

/**
 * What the analysis says about the MODE (PRD §5.5): which run it is, which
 * criteria that run judges, and what the two parts cost. The editor groups the
 * criteria by `when` and dims the ones the run leaves out, and reads both
 * facts off here — it works out neither (TDD §3).
 */
describe('analyze: modes and criterion tags', () => {
  function tagged(mode: 'first' | 'second' | 'average'): Template {
    return templateOf(
      [card('A', STRATOS, 0, 3), card('B', ROTA, 0, 3), line('m', 'monster', 0, 20)],
      [
        { id: 'c1', text: `1x #${STRATOS}`, when: 'first' },
        { id: 'c2', text: '1x monster' },
        { id: 'c3', text: `1x #${ROTA}`, when: 'second' },
      ],
      { hand: { size: mode === 'first' ? 5 : 6 }, mode },
    );
  }

  it('says which run it is, defaulting a file that predates modes off its hand', () => {
    expect(analyze(tagged('average'), ctx).mode).toBe('average');
    expect(analyze(motivatingTemplate(), ctx).mode).toBe('first');
  });

  it('carries every criterion’s tag, defaulted to `both`', () => {
    const a = analyze(tagged('average'), ctx);
    expect(a.criteria.map((criterion) => criterion.when)).toEqual(['first', 'both', 'second']);
  });

  it('says which criteria the RUN judges, and which it leaves out', () => {
    expect(analyze(tagged('first'), ctx).criteria.map((c) => c.counted)).toEqual([
      true,
      true,
      false,
    ]);
    expect(analyze(tagged('second'), ctx).criteria.map((c) => c.counted)).toEqual([
      false,
      true,
      true,
    ]);
    expect(analyze(tagged('average'), ctx).criteria.map((c) => c.counted)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('costs each part over ITS OWN success set, both over the union’s classes', () => {
    const a = analyze(tagged('average'), ctx);
    expect(a.work.hands).toHaveLength(2);
    expect(a.work.hands!.map(({ H, part, weight }) => ({ H, part, weight }))).toEqual([
      { H: 5, part: 'first', weight: 1 },
      { H: 6, part: 'second', weight: 1 },
    ]);
    // The two parts judge different criteria, so they sum different numbers of terms.
    expect(a.work.hands![0]!.terms).not.toBe(a.work.hands![1]!.terms);
  });

  it('counts FEWER class vectors in a single mode than in the average', () => {
    // The classes come from the criteria the run judges, so a going-first run
    // is the problem it would have been had the going-second criteria never
    // been written: it does not pay to tell apart cards it cannot see.
    const [first, second, average] = (['first', 'second', 'average'] as const).map((mode) =>
      Number(analyze(tagged(mode), ctx).work.classVectors),
    ) as [number, number, number];
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(average);
    expect(second).toBeLessThan(average);
  });

  it('costs a single mode no more work than the average does', () => {
    const work = (mode: 'first' | 'second' | 'average') => analyze(tagged(mode), ctx).work;
    const terms = (mode: 'first' | 'second' | 'average') =>
      work(mode).hands!.reduce((sum, hand) => sum + hand.terms, 0);
    expect(terms('first')).toBeLessThanOrEqual(terms('average'));
    expect(work('first').estimatedMs!).toBeLessThan(work('average').estimatedMs!);
  });

  it('warns when a part the run scores has no criterion of its own', () => {
    const oneSided = templateOf(
      [card('A', STRATOS, 0, 3)],
      [{ id: 'c1', text: `1x #${STRATOS}`, when: 'first' }],
      { hand: { size: 6 }, mode: 'average' },
    );
    expect(analyze(oneSided, ctx).issues.map((issue) => issue.message)).toContain(
      'no criterion is judged going second (a hand of 6), so that half of the average is 0',
    );
    // In a single mode the same gap means every hand fails, and says so.
    const second = analyze({ ...oneSided, mode: 'second' }, ctx);
    expect(second.issues.map((issue) => issue.message)).toContain(
      'no criterion is judged going second (a hand of 6): every hand fails, whatever the ratio',
    );
    // It is a warning, not an error: the template still runs and still answers.
    expect(second.ok).toBe(true);
  });

  it('says nothing about parts when there is no criterion at all: one warning, not three', () => {
    const empty = templateOf([card('A', STRATOS, 0, 3)], []);
    expect(analyze(empty, ctx).issues.filter((issue) => issue.code === 'no-criteria')).toEqual([
      {
        severity: 'warning',
        code: 'no-criteria',
        message: 'there is no criterion: every hand fails',
      },
    ]);
  });

  it('is an ERROR for a template whose mode and hand size disagree', () => {
    const wrong = { ...tagged('average'), hand: { size: 5 } };
    const a = analyze(wrong, ctx);
    expect(a.ok).toBe(false);
    expect(a.issues.map((issue) => issue.message)).toContain(
      'going first and second is judged at a hand of 6, but the hand size is 5',
    );
  });

  it('stays a plain JSON value', () => {
    const a = analyze(tagged('average'), ctx);
    expect(JSON.parse(JSON.stringify(a))).toStrictEqual(a);
  });
});

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

/**
 * Weighting, as the editor sees it (PRD §5.6). The analysis is where the two
 * defaults live — the switch off, a criterion worth 1 — so the editor reads the
 * number that is in force rather than working one out for itself (TDD §3).
 */
describe('analyze: weighted criteria', () => {
  const weighted = (weights: (number | undefined)[], on = true): Template => {
    const base = templateOf(
      [line('mon', 'monster', 0, 10), line('sp', 'spell', 0, 10)],
      ['1x monster', '1x spell'],
    );
    return {
      ...base,
      weighted: on,
      criteria: base.criteria.map((criterion, at) =>
        weights[at] === undefined ? criterion : { ...criterion, weight: weights[at] },
      ),
    };
  };

  it('says whether the run is weighted, and what each criterion is worth', () => {
    const a = analyze(weighted([6, undefined]), ctx);
    expect(a.weighted).toBe(true);
    expect(a.criteria.map((criterion) => criterion.weight)).toEqual([6, 1]);
    expect(a.ok).toBe(true);
  });

  it('reports every criterion as worth 1 while the switch is off, whatever it says', () => {
    // The number the editor shows is the one in force: a weight nobody reads is
    // not a weight, and showing it as one would be the readout inventing a rule.
    const a = analyze(weighted([6, 2], false), ctx);
    expect(a.weighted).toBe(false);
    expect(a.criteria.map((criterion) => criterion.weight)).toEqual([1, 1]);
  });

  it('is the analysis of the unweighted template, field for field, with the switch off', () => {
    const off = analyze(weighted([6, 2], false), ctx);
    const never = analyze(weighted([undefined, undefined], false), ctx);
    expect(off).toEqual(never);
  });

  it('carries the weights into the work estimate, since the success set changes with them', () => {
    // `2x monster` at weight 5 beside `1x spell` at weight 1: the stored side of
    // the success set is chosen by counting ROWS, and a weight moves that count.
    const base = templateOf(
      [line('mon', 'monster', 0, 10), line('sp', 'spell', 0, 10)],
      ['2x monster', '1x spell'],
    );
    const on = analyze(
      {
        ...base,
        weighted: true,
        criteria: [{ ...base.criteria[0]!, weight: 5 }, base.criteria[1]!],
      },
      ctx,
    );
    const off = analyze(base, ctx);
    expect(on.work.hands).not.toBeNull();
    expect(off.work.hands).not.toBeNull();
    // Both sides store the COMPLEMENT here, but not the same complement: a
    // weighted set leaves out the rows already worth the most (the hands with
    // two monsters) rather than only the failures, so it stores 11 rows where
    // the unweighted one stores 2. Weighting changes what a score COSTS, and
    // an estimate that did not carry the weights would be of the wrong search.
    expect([on.work.hands![0]!.complemented, on.work.hands![0]!.terms]).toEqual([true, 11]);
    expect([off.work.hands![0]!.complemented, off.work.hands![0]!.terms]).toEqual([true, 2]);
    expect(on.work.estimatedMs).toBeGreaterThan(off.work.estimatedMs!);
  });

  it('reports a weight it cannot score exactly as a compile error, never as a throw', () => {
    const a = analyze(weighted([13_688_586_241, undefined]), ctx);
    expect(a.ok).toBe(false);
    expect(codes(a.issues)).toContain('!compile');
    expect(a.issues.map((issue) => issue.message).join('\n')).toMatch(/past 2\^53/);
    // And it is the COMPILE guard that caught it, not the "never throws" net.
    expect(codes(a.issues)).not.toContain('!internal');
  });
});

/** The SIXTH CARD in the readout (PRD §5.6): what the editor shows of a split. */
describe('analyze of a split criterion', () => {
  const secondOf = (text: string, when: 'first' | 'second' | 'both' = 'second'): Template =>
    templateOf(
      [line('mon', 'monster', 0, 10), line('tr', 'trap', 0, 10)],
      [{ id: 'c1', text, when }],
      { hand: { size: 6 }, mode: 'second' },
    );

  it('shows the expansion with `then` between the two parts', () => {
    const a = analyze(secondOf('1x monster then no trap'), ctx);
    expect(a.ok).toBe(true);
    expect(criterionOf(a, 'c1').alternatives).toEqual(['1x monster then no trap']);
    expect(criterionOf(a, 'c1').parsed).toMatchObject({
      ok: true,
      canonical: '1x monster then no trap',
    });
  });

  it('leads with `then` where nothing is asked of the cards opened on', () => {
    const a = analyze(secondOf('then 1x trap'), ctx);
    expect(criterionOf(a, 'c1').alternatives).toEqual(['then 1x trap']);
  });

  it("counts the sixth card's descriptions as requirements and limits like any others", () => {
    const a = analyze(secondOf('1x monster then no trap'), ctx);
    expect(requirementOf(a, 'monster').filledBy).toEqual(['mon']);
    expect(limitOf(a, 'trap').counts).toEqual(['tr']);
    // And each appearance says WHICH window asked, because `1x trap` of the card
    // you draw is a different statement from `1x trap` in six cards.
    expect(requirementOf(a, 'monster').appearsIn).toEqual([
      { criterion: 'c1', alternative: 0, n: 1 },
    ]);
    expect(limitOf(a, 'trap').appearsIn).toEqual([
      { criterion: 'c1', alternative: 0, n: 0, sixth: true },
    ]);
  });

  it('warns that no line fills a requirement the sixth card alone asks for', () => {
    const noSpell = templateOf(
      [line('mon', 'monster', 0, 10)],
      [{ id: 'c1', text: '1x monster then 1x spell', when: 'second' }],
      {
        hand: { size: 6 },
        mode: 'second',
      },
    );
    const a = analyze(noSpell, ctx);
    expect(requirementOf(a, 'spell').filledBy).toEqual([]);
    expect(codes(requirementOf(a, 'spell').issues)).toContain('unfilled');
  });

  it('is an error, on the criterion, when it is not tagged going second', () => {
    for (const when of ['first', 'both'] as const) {
      const a = analyze(secondOf('1x monster then no trap', when), ctx);
      expect(a.ok, when).toBe(false);
      expect(codes(criterionOf(a, 'c1').issues), when).toEqual(['!sixth-card']);
      expect(criterionOf(a, 'c1').issues[0]!.message, when).toContain('tag it going second');
    }
  });

  it('is a parse error, with a span, when the sixth card is asked for two cards', () => {
    // The parser refuses it — `slotsOf` counts exactly what expansion would —
    // so the reader gets the span of the thing that asked too much, rather than
    // a message about an expansion they never see.
    const a = analyze(secondOf('1x monster then 2x trap'), ctx);
    expect(a.ok).toBe(false);
    expect(codes(criterionOf(a, 'c1').issues)).toEqual(['!parse']);
    const [issue] = criterionOf(a, 'c1').issues;
    expect(issue!.message).toContain('the card you draw is one card, and this asks 2 of it');
    expect('1x monster then 2x trap'.slice(issue!.span!.start, issue!.span!.end)).toBe('2x trap');
  });

  it('reports the work of a drawn hand: the same terms, one per composition', () => {
    const a = analyze(secondOf('1x monster then no trap'), ctx);
    expect(a.work.hands).toHaveLength(1);
    expect(a.work.hands![0]).toMatchObject({ H: 6, part: 'second' });
    expect(a.work.hands![0]!.terms).toBeGreaterThan(0);
  });

  describe('a `finally` part', () => {
    it('shows the expansion in window order, with every separator it has', () => {
      const a = analyze(secondOf('1x monster then no trap finally at most 1x trap'), ctx);
      expect(a.ok).toBe(true);
      expect(criterionOf(a, 'c1').alternatives).toEqual([
        '1x monster then no trap finally at most 1x trap',
      ]);
      expect(criterionOf(a, 'c1').parsed).toMatchObject({
        ok: true,
        canonical: '1x monster then no trap finally at most 1x trap',
      });
    });

    it('leads with `finally` where nothing is asked of the cards opened on', () => {
      const a = analyze(secondOf('finally 2x trap'), ctx);
      expect(criterionOf(a, 'c1').alternatives).toEqual(['finally 2x trap']);
    });

    /**
     * A description named ONLY in the `finally` part still gets its column, its
     * `filledBy` and its near misses — anything less is a readout that says
     * nothing about part of a criterion while looking complete.
     */
    it('counts its descriptions like any other, saying which window asked', () => {
      const a = analyze(secondOf('1x monster finally at most 1x trap'), ctx);
      expect(limitOf(a, 'trap').counts).toEqual(['tr']);
      expect(limitOf(a, 'trap').appearsIn).toEqual([
        { criterion: 'c1', alternative: 0, n: 1, whole: true },
      ]);
      expect(requirementOf(a, 'monster').appearsIn).toEqual([
        { criterion: 'c1', alternative: 0, n: 1 },
      ]);
    });

    it('is an error, on the criterion, when it is not tagged going second', () => {
      for (const when of ['first', 'both'] as const) {
        const a = analyze(secondOf('1x monster finally 2x trap', when), ctx);
        expect(a.ok, when).toBe(false);
        expect(codes(criterionOf(a, 'c1').issues), when).toEqual(['!sixth-card']);
        expect(criterionOf(a, 'c1').issues[0]!.message, when).toContain('tag it going second');
      }
    });

    /**
     * Its window is the whole hand, so it asks for as many cards as a hand holds
     * — and one asking for more is DROPPED, exactly as an unsplit criterion
     * asking for more is, rather than refused on the text as `then` is.
     */
    it('drops an alternative asking more of the whole hand than it holds', () => {
      expect(analyze(secondOf('1x monster finally 6x trap'), ctx).ok).toBe(true);
      const over = analyze(secondOf('1x monster finally 7x trap'), ctx);
      expect(criterionOf(over, 'c1').dropped).toBe(1);
      expect(criterionOf(over, 'c1').alternatives).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Draw cards (PRD §5.7)
// ---------------------------------------------------------------------------

describe('analyze with draw cards', () => {
  const potLine = (draw: DrawSpec = { n: 2 }, max = 3): TemplateLine => ({
    id: 'pot',
    text: 'spell',
    min: 0,
    max,
    draw,
  });

  it('says the largest hand the criteria are judged against, which is not the hand size', () => {
    const a = analyze(templateOf([potLine(), line('starter', 'monster')], ['1x monster']), ctx);
    expect(a.handSize).toBe(5);
    expect(a.judgedHand).toBe(8);
  });

  it('leaves `judgedHand` at the hand size for a template that draws nothing', () => {
    const a = analyze(templateOf([line('starter', 'monster')], ['1x monster']), ctx);
    expect(a.judgedHand).toBe(5);
  });

  it('shows what each class draws', () => {
    const a = analyze(
      templateOf(
        [potLine({ n: 2, oncePerTurn: true }), line('starter', 'monster')],
        ['1x monster'],
      ),
      ctx,
    );
    expect(a.classes?.classes.some((cls) => cls.draw?.oncePerTurn === true)).toBe(true);
  });

  /**
   * The work model gains two things draw cards make real: a row per PREFIX
   * LENGTH, and the ordering factors, which cost one multiply-add each per deck
   * and which no term count shows.
   */
  it('counts the work per prefix length, with the ordering factors beside it', () => {
    const a = analyze(templateOf([potLine(), line('starter', 'monster')], ['1x monster']), ctx);
    expect(a.work.hands?.map((hand) => hand.prefix)).toEqual([5, 7, 9, 11]);
    for (const hand of a.work.hands ?? []) {
      expect(hand.H).toBe(5);
      expect(hand.groups).toBeGreaterThanOrEqual(1);
    }
  });

  it('counts it the way it always did for a template without draw cards', () => {
    const a = analyze(templateOf([line('starter', 'monster')], ['1x monster']), ctx);
    expect(a.work.hands).toHaveLength(1);
    expect(a.work.hands?.[0]).toMatchObject({ H: 5, groups: 1 });
    expect(a.work.hands?.[0]).not.toHaveProperty('prefix');
  });

  it('says whether the player would stop for each criterion', () => {
    const a = analyze(
      templateOf([potLine(), line('starter', 'monster')], [], {
        criteria: [
          { id: 'draws-past', text: '1x monster' },
          { id: 'stops', text: '2x monster', stop: true },
        ],
      }),
      ctx,
    );
    expect(criterionOf(a, 'draws-past').stop).toBe(false);
    expect(criterionOf(a, 'stops').stop).toBe(true);
  });

  /**
   * DRAWING CAN MAKE A HAND FAIL, and that must be visible rather than merely
   * true: a limit is a census over the whole hand and a ceiling makes a surplus
   * card fatal, so the score falls as copies of the draw card are added. Nobody
   * expects that, and the readout is where they find out.
   */
  describe('the warning that more cards can be worse', () => {
    const noticed = (a: Analysis) => codes(a.issues).includes('drawing-can-fail');

    it('is given where a criterion counts the whole hand and the template draws', () => {
      expect(
        noticed(
          analyze(templateOf([potLine(), line('starter', 'monster')], ['1-1x monster']), ctx),
        ),
      ).toBe(true);
      expect(
        noticed(
          analyze(
            templateOf(
              [potLine(), line('trap', 'trap'), line('starter', 'monster')],
              ['1x monster and no trap'],
            ),
            ctx,
          ),
        ),
      ).toBe(true);
    });

    it('is NOT given where nothing counts the whole hand: more cards is then only more chances', () => {
      expect(
        noticed(analyze(templateOf([potLine(), line('starter', 'monster')], ['1x monster']), ctx)),
      ).toBe(false);
    });

    it('is NOT given without draw cards, however many ceilings there are', () => {
      expect(
        noticed(analyze(templateOf([line('starter', 'monster')], ['1-1x monster']), ctx)),
      ).toBe(false);
    });

    /**
     * A `stop` criterion is STILL warned about, and that is the correction the
     * name invites a reader to miss: the flag decides the window, so a criterion
     * the player would stop for is judged after the draws all the same whenever
     * the opening did not stop them — and can still be broken by them there.
     */
    it('is given for a criterion the player would stop for, which the draws still reach', () => {
      const a = analyze(
        templateOf([potLine(), line('starter', 'monster')], [], {
          criteria: [{ id: 'c1', text: '1-1x monster', stop: true }],
        }),
        ctx,
      );
      expect(noticed(a)).toBe(true);
      // And the advice names the escape hatch rather than a window.
      const message = a.issues.find((issue) => issue.code === 'drawing-can-fail')!.message;
      expect(message).toContain('"stop here"');
    });

    /**
     * THE DRAWN SET COUNTS TOO. `then no trap` is a census over the cards you
     * drew, and drawing more cards is exactly what makes that window bigger —
     * so a split criterion breaks the same way an unsplit one does. Reading
     * only the outer window would leave unwarned the one template most likely
     * to be surprised by it.
     */
    it('is given where only the `then` part counts what was drawn', () => {
      const of = (text: string) =>
        analyze(
          templateOf([potLine(), line('starter', 'monster'), line('brick', 'trap')], [], {
            hand: { size: 6 },
            mode: 'second',
            criteria: [{ id: 'c1', text, when: 'second' }],
          }),
          ctx,
        );
      expect(noticed(of('1x monster then no trap'))).toBe(true);
      // And not where nothing counts anything: a plain requirement on either
      // side only ever gets easier as the hand grows.
      expect(noticed(of('1x monster then 1x monster'))).toBe(false);
    });
  });

  /**
   * THE NUMBER IS A LOWER BOUND, and a reader has to be told rather than left to
   * infer it: there is one decision point, so a player who stops halfway — two
   * Pots, activate one, keep the other — can do better than the model.
   */
  describe('the notice that the number is a lower bound', () => {
    const noticed = (a: Analysis) => codes(a.issues).includes('drawing-is-a-lower-bound');

    it('is given for every template that draws, ceiling or no ceiling', () => {
      expect(
        noticed(analyze(templateOf([potLine(), line('starter', 'monster')], ['1x monster']), ctx)),
      ).toBe(true);
      expect(
        noticed(
          analyze(templateOf([potLine(), line('starter', 'monster')], ['1-1x monster']), ctx),
        ),
      ).toBe(true);
    });

    it('is not given for a template that draws nothing', () => {
      expect(noticed(analyze(templateOf([line('starter', 'monster')], ['1x monster']), ctx))).toBe(
        false,
      );
    });

    it('says the two things it is about: one decision, and a lower bound', () => {
      const a = analyze(templateOf([potLine(), line('starter', 'monster')], ['1x monster']), ctx);
      const message = a.issues.find((issue) => issue.code === 'drawing-is-a-lower-bound')!.message;
      expect(message).toContain('one decision');
      expect(message).toContain('LOWER bound');
    });
  });

  describe('what it refuses', () => {
    it('reports the deck running out as an error on the template, not as a thrown exception', () => {
      const a = analyze(
        templateOf([potLine({ n: 2 }, 3), line('starter', 'monster')], ['1x monster'], {
          deckSize: 40,
        }),
        ctx,
      );
      expect(a.ok).toBe(true);
      const deep = analyze(
        templateOf([potLine({ n: 5 }, 3), line('starter', 'monster')], ['1x monster']),
        ctx,
      );
      expect(deep.ok).toBe(false);
      expect(codes(deep.issues)).toContain('!compile');
    });

    /**
     * `then` BESIDE DRAW CARDS was refused, and is not. The readout must widen
     * with the engine, or the editor goes on reporting an error the run does
     * not have — which is worse than either answer alone.
     */
    it('reads `then` beside draw cards as the whole drawn set, and no longer refuses it', () => {
      const a = analyze(
        templateOf([potLine(), line('starter', 'monster')], [], {
          hand: { size: 6 },
          mode: 'second',
          criteria: [{ id: 'c1', text: 'then 1x monster', when: 'second' }],
        }),
        ctx,
      );
      expect(a.ok).toBe(true);
      expect(a.issues.some((issue) => /`then` and draw cards/.test(issue.message))).toBe(false);
    });

    /**
     * And the BOUND the editor holds `then` to widens with it: three Pots fetch
     * six cards, so the drawn set holds seven. The readout says the figure
     * rather than "one card", which would be the old answer to a new question.
     */
    it('lets `then 2x` be written once a line draws, and still refuses what cannot be drawn', () => {
      const of = (text: string) =>
        analyze(
          templateOf([potLine(), line('starter', 'monster')], [], {
            hand: { size: 6 },
            mode: 'second',
            criteria: [{ id: 'c1', text, when: 'second' }],
          }),
          ctx,
        );
      expect(of('then 2x monster').ok).toBe(true);
      const tooMany = of('then 8x monster');
      expect(tooMany.ok).toBe(false);
      expect(criterionOf(tooMany, 'c1').issues[0]!.message).toContain(
        'you draw at most 7 cards here',
      );
    });
  });
});

describe('the work estimate with draw cards', () => {
  /**
   * A term of a longer PREFIX costs more than a term of a hand — it holds cards
   * of more classes, so it multiplies more binomials — and `perTermNs` is
   * calibrated on a hand. The estimate scales by `prefix / H`, which is 1 for
   * every template that draws nothing.
   */
  it('scales a part’s terms by how deep into the deck it reads', () => {
    const cost = { perVectorUs: 0, perTermNs: 1000 };
    const a = analyze(
      templateOf(
        [{ id: 'pot', text: 'spell', min: 0, max: 3, draw: { n: 2 } }, line('starter', 'monster')],
        ['1x monster'],
      ),
      ctx,
      { cost },
    );
    const hands = a.work.hands!;
    const expected =
      countToNumber(a.work.classVectors!) *
      hands.reduce((sum, { terms, H, prefix }) => sum + terms * ((prefix ?? H) / H), 0) *
      1e-3;
    expect(a.work.estimatedMs).toBeCloseTo(expected, 9);
    // And the scaling is not the identity: the deeper parts count for more.
    expect(hands.some(({ prefix }) => (prefix ?? 5) > 5)).toBe(true);
  });

  it('leaves the estimate of a template without draw cards exactly where it was', () => {
    const cost = { perVectorUs: 0.05, perTermNs: 6 };
    const a = analyze(templateOf([line('starter', 'monster')], ['1x monster']), ctx, { cost });
    const { terms } = a.work.hands![0]!;
    expect(a.work.estimatedMs).toBeCloseTo(
      (countToNumber(a.work.classVectors!) * (0.05 + (6 / 1000) * terms)) / 1000,
      9,
    );
  });
});

/**
 * `analyze` runs on every edit, SYNCHRONOUSLY IN THE MAIN PROCESS, so a build
 * it cannot afford is not a slow readout but a frozen application. Past
 * `ANALYZE_DRAW_WORK` it declines to build and says so — everything else in the
 * analysis is still there, and the run itself is unaffected.
 */
describe('a draw template too wide to analyse on a keystroke', () => {
  const LEVELS = Array.from({ length: 12 }, (_, at) => `level ${at + 1} monster`);
  /**
   * `classes` lines the criteria can tell apart — each Level is its own
   * column, so none of them merges into the blank class — three copies of a
   * draw-2, and one criterion that may stop.
   */
  const wide = (classes: number, stop: boolean): Template =>
    templateOf(
      [
        { id: 'pot', text: 'spell', min: 0, max: 3, draw: { n: 2 } },
        ...Array.from({ length: classes }, (_, at) => line(`l${at}`, LEVELS[at]!, 0, 13)),
      ],
      [],
      {
        criteria: [
          {
            id: 'c1',
            text: LEVELS.slice(0, classes)
              .map((level) => `1x ${level}`)
              .join(' or '),
            ...(stop ? { stop: true } : {}),
          },
        ],
      },
    );
  it('counts the work for an ordinary drawing template', () => {
    const a = analyze(wide(3, true), ctx);
    expect(a.work.hands).not.toBeNull();
    expect(a.work.estimatedMs).not.toBeNull();
    expect(codes(a.issues)).not.toContain('work-not-counted');
  });

  it('declines to count it for one that would freeze the editor, and says why', () => {
    const a = analyze(wide(12, true), ctx);
    expect(a.work.hands).toBeNull();
    expect(a.work.estimatedMs).toBeNull();
    expect(codes(a.issues)).toContain('work-not-counted');
    const message = a.issues.find((issue) => issue.code === 'work-not-counted')!.message;
    expect(message).toContain('runs on every edit');
    expect(message).toContain('The run itself is unaffected');
    // The real figure and how far over it is, never a rounded pair that reads
    // as the same number twice.
    expect(message).toMatch(/\d{1,3}(,\d{3})+ compositions/);
    expect(message).toMatch(/\d+(\.\d\d)?× what an analysis will build/);
  });

  /**
   * Declining is a NOTICE and not an error: the template is perfectly runnable,
   * and everything the analysis is really for is still in it.
   */
  it('is a notice, so the template still runs and everything else is still reported', () => {
    const a = analyze(wide(12, true), ctx);
    expect(a.ok).toBe(true);
    expect(a.classes).not.toBeNull();
    expect(a.work.classVectors).not.toBeNull();
    expect(a.work.rawRatios).not.toBeNull();
  });

  it('never declines for a template that draws nothing, however wide', () => {
    const a = analyze(
      templateOf(
        Array.from({ length: 12 }, (_, at) => line(`l${at}`, LEVELS[at]!, 0, 13)),
        ['1x level 1 monster'],
      ),
      ctx,
    );
    expect(codes(a.issues)).not.toContain('work-not-counted');
    expect(a.work.hands).not.toBeNull();
  });
});

/**
 * `n× unique D` as the editor sees it (PRD §5.3): the requirement's row says
 * `unique`, and a line that could fill one without being ONE card is an error
 * on that line — the thing to split — rather than somewhere else.
 */
describe('analyze of a unique requirement', () => {
  const STARTER = [CODE.vanillaDragon, CODE.tunerFairy, CODE.ritualSoldier];
  const groups: Template['groups'] = [
    {
      id: 'g-starter',
      name: 'Starter',
      cards: STARTER.map((passcode) => ({ passcode, name: `#${passcode}` })),
    },
  ];
  const named = STARTER.map((passcode, at) => card(`s${at}`, passcode, 3, 3));
  const analysed = (lines: TemplateLine[], criteria: string[]) =>
    analyze(templateOf(lines, criteria, { groups }), ctx);

  it('reads a template of one line per card as runnable, and marks the appearance', () => {
    const a = analysed(named, ['3 unique {Starter}', '1x {Starter}']);
    expect(a.ok).toBe(true);
    expect(requirementOf(a, '{Starter}').appearsIn).toEqual([
      { criterion: 'c1', alternative: 0, n: 3, unique: true },
      { criterion: 'c2', alternative: 0, n: 1 },
    ]);
    expect(criterionOf(a, 'c1').parsed).toEqual({ ok: true, canonical: '3x unique {Starter}' });
    expect(criterionOf(a, 'c1').alternatives).toEqual(['3x unique {Starter}']);
    // Each starter is a class of its own: that is what telling cards apart takes.
    expect(a.classes!.classes.map(({ lines }) => lines)).toEqual([
      ['remainder'],
      ['s0'],
      ['s1'],
      ['s2'],
    ]);
  });

  it('puts the error on a group line that could fill it, and compiles nothing', () => {
    const a = analysed([...named, line('more', '{Starter}')], ['2 unique {Starter}']);
    expect(a.ok).toBe(false);
    expect(lineOf(a, 'more').issues).toEqual([
      {
        severity: 'error',
        code: 'not-one-card',
        message:
          'this line could be any of several cards, so how many different ones it holds is unknown — split it into one line per card to use it in a `unique` requirement (it could fill `2x unique {Starter}`)',
      },
    ]);
    expect(named.every(({ id }) => lineOf(a, id).issues.length === 0)).toBe(true);
    expect(a.classes).toBeNull();
    // Said once, on the line, and not again as a compile error of the template.
    expect(codes(allIssues(a)).filter((code) => code === '!compile')).toEqual([]);
  });

  it('puts it on an `or` line, and on the remainder when the remainder could fill one', () => {
    const either = analysed(
      [...named, line('either', `#${STARTER[0]} or #${STARTER[1]}`)],
      ['2 unique {Starter}'],
    );
    expect(codes(lineOf(either, 'either').issues)).toEqual(['!not-one-card']);
    const any = analysed(named, ['2 unique card']);
    expect(codes(any.remainder.issues)).toEqual(['!not-one-card']);
    expect(any.remainder.issues[0]!.message).toContain(
      'the unspecified cards could be any cards at all',
    );
    expect(any.ok).toBe(false);
  });

  it('leaves a vague line alone when the requirements it fills are all plain', () => {
    const a = analysed([...named, line('mon', 'monster')], ['2 unique {Starter}, 1x monster']);
    expect(lineOf(a, 'mon').issues).toEqual([]);
    expect(a.ok).toBe(true);
  });

  it('carries the parse errors of a ceiling beside it, with their spans', () => {
    const a = analysed(named, ['exactly 3 unique {Starter}']);
    expect(criterionOf(a, 'c1').parsed).toMatchObject({ ok: false, span: { start: 0, end: 16 } });
    expect(codes(criterionOf(a, 'c1').issues)).toEqual(['!parse']);
  });

  it('agrees with compiling the template, run or refuse', () => {
    for (const [lines, criteria] of [
      [named, ['3 unique {Starter}']],
      [[...named, line('more', '{Starter}')], ['2 unique {Starter}']],
      [named, ['2 unique card']],
    ] as const) {
      const template = templateOf([...lines], [...criteria], { groups });
      const resolvedTemplate = resolveTemplate(template, ctx);
      if (!resolvedTemplate.ok) throw new Error(resolvedTemplate.errors.join('\n'));
      same(analyze(template, ctx).ok, compileProblem(resolvedTemplate.resolved).ok, () => criteria);
    }
  });
});
