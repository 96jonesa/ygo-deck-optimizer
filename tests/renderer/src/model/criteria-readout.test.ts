import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../../../src/core/model/analyze';
import {
  criteriaIssues,
  criterionLabel,
  expansionPreview,
  limitRows,
  lineLabel,
  requirementRows,
} from '../../../../src/renderer/src/model/criteria-readout';
import type { Analysis } from '../../../../src/shared/types';
import { analysisOf, criterionOf, limitOf, lineOf, requirementOf } from '../../../helpers/analysis';
import { motivatingContext, motivatingTemplate } from '../../../helpers/motivating';

/**
 * The real thing: the motivating example analysed against the fixture card
 * database, so that PRD §6.2's table — `monster` fills `1x monster` and
 * pointedly does not fill `1x level 4 or lower monster` — is checked against
 * what `analyze` actually produces, not against an imitation of it.
 */
const SQL = await initSqlJs();
const CTX = motivatingContext(SQL);
const MOTIVATING: Analysis = analyze(motivatingTemplate(), CTX);

/** The example with one more line, as the one-click split of PRD §6.4 leaves it. */
function withSplitLine(): Analysis {
  const template = motivatingTemplate();
  template.lines.push({ id: 'line1', text: 'level 4 or lower monster', min: 0, max: 3 });
  return analyze(template, CTX);
}

/** The example with a criterion carrying a limit, which the example itself has none of. */
function withLimit(text: string): Analysis {
  const template = motivatingTemplate();
  template.criteria.push({ id: 'c3', text });
  return analyze(template, CTX);
}

const rowFor = (analysis: Analysis, text: string) =>
  requirementRows(analysis).find((row) => row.text === text)!;

describe('lineLabel', () => {
  it('is the line’s own id', () => {
    expect(lineLabel(MOTIVATING, 'level4')).toBe('level4');
  });

  it('names the computed remainder row rather than showing its id', () => {
    expect(lineLabel(MOTIVATING, 'remainder')).toBe('the remainder');
  });

  it('reads the remainder’s id off the analysis, not from a constant of its own', () => {
    const odd = analysisOf({ remainder: { ...analysisOf().remainder, id: 'rest' } });
    expect(lineLabel(odd, 'rest')).toBe('the remainder');
    expect(lineLabel(odd, 'remainder')).toBe('remainder');
  });

  it('gives back the id when there is no analysis yet', () => {
    expect(lineLabel(null, 'level4')).toBe('level4');
  });
});

describe('criterionLabel', () => {
  it('is the name the user gave the criterion', () => {
    expect(criterionLabel(MOTIVATING, 'c1')).toBe('A, B and any monster');
  });

  it('falls back to the id, which is what the row is headed with', () => {
    expect(criterionLabel(analysisOf({ criteria: [criterionOf('c1')] }), 'c1')).toBe('c1');
  });

  it('gives back the id for a criterion the analysis does not have', () => {
    expect(criterionLabel(MOTIVATING, 'c9')).toBe('c9');
  });
});

describe('expansionPreview', () => {
  it('is the flat alternatives a nested OR expands to (PRD §5.3)', () => {
    const template = motivatingTemplate();
    template.criteria = [
      {
        id: 'c1',
        text: '1x [Elemental HERO Stratos] and 1x [Reinforcement of the Army] and (1x monster or 2x spell)',
      },
    ];
    const preview = expansionPreview(analyze(template, CTX).criteria[0]!, 5);
    expect(preview?.alternatives).toEqual([
      '1x #40044918, 1x #32807846, 1x monster',
      '1x #40044918, 1x #32807846, 2x spell',
    ]);
    expect(preview?.dropped).toBeNull();
  });

  it('is nothing for a criterion with one alternative: the canonical form already says it', () => {
    expect(expansionPreview(MOTIVATING.criteria[0]!, 5)).toBeNull();
  });

  it('shows the alternatives themselves, not the criterion they came from', () => {
    const found = criterionOf('c1', {
      text: '1x a or 1x b',
      alternatives: ['1x a', '1x b'],
    });
    expect(expansionPreview(found, 5)?.alternatives).toEqual(['1x a', '1x b']);
  });

  it('reports alternatives dropped for needing more cards than a hand holds', () => {
    const found = criterionOf('c1', { alternatives: ['1x a', '1x b'], dropped: 3 });
    expect(expansionPreview(found, 5)?.dropped).toBe(
      '3 alternatives need more than the 5 cards of a hand, and were dropped',
    );
  });

  it('counts one dropped alternative in the singular, and says the hand size it was measured against', () => {
    const found = criterionOf('c1', { alternatives: ['1x a', '1x b'], dropped: 1 });
    expect(expansionPreview(found, 6)?.dropped).toBe(
      '1 alternative needs more than the 6 cards of a hand, and was dropped',
    );
  });

  it('is shown for a single alternative once others were dropped: that is why there is one', () => {
    const found = criterionOf('c1', { alternatives: ['1x a'], dropped: 2 });
    expect(expansionPreview(found, 5)).not.toBeNull();
  });

  it('is shown when every alternative was dropped, which is a criterion nothing can meet', () => {
    const found = criterionOf('c1', { alternatives: [], dropped: 2 });
    expect(expansionPreview(found, 5)).toMatchObject({ alternatives: [] });
  });

  it('is nothing for a criterion that did not parse', () => {
    expect(expansionPreview(criterionOf('c1', { alternatives: [] }), 5)).toBeNull();
  });
});

describe('requirementRows', () => {
  it('is empty before the first analysis', () => {
    expect(requirementRows(null)).toEqual([]);
  });

  describe('filled by', () => {
    it('is the lines PRD §6.2 says fill `monster`', () => {
      expect(rowFor(MOTIVATING, 'monster').filledBy).toEqual(['A', 'monster', 'level4', 'fire-bw']);
    });

    it('leaves `monster` out of `level 4 or lower monster`: its Level is unstated', () => {
      expect(rowFor(MOTIVATING, 'level 4 or lower monster').filledBy).toEqual(['A', 'level4']);
    });

    it('names the remainder rather than showing its id', () => {
      const row = requirementRows(
        analysisOf({ requirements: [requirementOf('card', { filledBy: ['remainder'] })] }),
      )[0]!;
      expect(row.filledBy).toEqual(['the remainder']);
    });
  });

  describe('near misses', () => {
    it('is the `monster` line against `level 4 or lower monster`, in `analyze`’s own words', () => {
      const misses = rowFor(MOTIVATING, 'level 4 or lower monster').nearMisses;
      expect(misses.map((miss) => miss.explanation)).toEqual([
        '`monster`: Level unstated',
        '`card`: kind unstated',
      ]);
      expect(misses[0]).toMatchObject({ line: 'monster', label: 'monster' });
      expect(misses[1]).toMatchObject({ line: 'remainder', label: 'the remainder' });
    });

    it('is not the same list as `filledBy`: a line is in exactly one of them', () => {
      const row = rowFor(MOTIVATING, 'level 4 or lower monster');
      expect(row.filledBy).not.toContain('monster');
      expect(row.nearMisses.map((miss) => miss.line)).not.toContain('level4');
    });

    it('carries the line `analyze` says would fill it, word for word', () => {
      const [miss] = rowFor(MOTIVATING, 'level 4 or lower monster').nearMisses;
      expect(miss?.suggestion).toBe('level 4 or lower monster');
    });

    /**
     * The suggestion is the line and the requirement TAKEN TOGETHER (TDD §9),
     * which is not the requirement: `FIRE monster` short of `level 4 or lower
     * monster` is fixed by `level 4 or lower FIRE monster`, and offering the
     * requirement instead would throw the line's own FIRE away.
     */
    it('is the conjunction `analyze` wrote, not the requirement it is short of', () => {
      const row = requirementRows(
        analysisOf({
          requirements: [
            requirementOf('level 4 or lower monster', {
              nearMisses: [
                {
                  line: 'fire',
                  isRemainder: false,
                  dimension: 'level',
                  reason: 'unstated',
                  explanation: '`FIRE monster`: Level unstated',
                  suggestion: 'level 4 or lower FIRE monster',
                },
              ],
            }),
          ],
        }),
      )[0]!;
      expect(row.nearMisses[0]?.suggestion).toBe('level 4 or lower FIRE monster');
      expect(row.nearMisses[0]?.suggestion).not.toBe(row.text);
    });

    /**
     * TDD §9: "Every generic line is technically a near miss of a named-card
     * requirement; those are kept in the data but hidden once some line fills
     * the requirement, since a generic line stands for cards other than the
     * template's named ones."
     */
    it('hides "a generic line is never a named card" once a line does fill it', () => {
      const raw = MOTIVATING.requirements.find((req) => req.text === '#40044918')!;
      expect(raw.nearMisses.map((miss) => miss.reason)).toEqual(['named', 'named', 'named']);
      expect(rowFor(MOTIVATING, '#40044918').nearMisses).toEqual([]);
    });

    it('keeps them while NOTHING fills the requirement: then they are the whole advice', () => {
      const row = requirementRows(
        analysisOf({
          requirements: [
            requirementOf('#1', {
              filledBy: [],
              nearMisses: [
                {
                  line: 'monster',
                  isRemainder: false,
                  dimension: 'named',
                  reason: 'named',
                  explanation: '`monster`: a generic line never counts as a named card',
                  suggestion: '#1',
                },
              ],
            }),
          ],
        }),
      )[0]!;
      expect(row.nearMisses).toHaveLength(1);
    });

    it('keeps a near miss that is about something else, filled or not', () => {
      expect(rowFor(MOTIVATING, 'monster').nearMisses.map((miss) => miss.line)).toEqual([
        'remainder',
      ]);
    });

    it('offers no line to add when `analyze` could not write one', () => {
      const row = requirementRows(
        analysisOf({
          requirements: [
            requirementOf('q', {
              nearMisses: [
                {
                  line: 'l1',
                  isRemainder: false,
                  dimension: 'combination',
                  reason: 'combination',
                  explanation: '`l1`: no single line says it',
                },
              ],
            }),
          ],
        }),
      )[0]!;
      expect(row.nearMisses[0]?.suggestion).toBeNull();
    });
  });

  describe('a suggestion already taken', () => {
    it('is not offered again once a line says exactly that', () => {
      const [miss] = rowFor(withSplitLine(), 'level 4 or lower monster').nearMisses;
      expect(miss?.suggestion).toBe('level 4 or lower monster');
      expect(miss?.alreadyOn).toBe('line1');
    });

    it('is open until then', () => {
      expect(rowFor(MOTIVATING, 'level 4 or lower monster').nearMisses[0]?.alreadyOn).toBeNull();
    });

    it('matches on what the line MEANS, not on how it was typed', () => {
      const analysis = analysisOf({
        lines: [
          lineOf('A', {
            text: '[Elemental HERO Stratos]',
            parsed: { ok: true, canonical: '#40044918' },
          }),
        ],
        requirements: [
          requirementOf('#40044918', {
            filledBy: [],
            nearMisses: [
              {
                line: 'monster',
                isRemainder: false,
                dimension: 'named',
                reason: 'named',
                explanation: '`monster`: a generic line never counts as a named card',
                suggestion: '#40044918',
              },
            ],
          }),
        ],
      });
      expect(requirementRows(analysis)[0]?.nearMisses[0]?.alreadyOn).toBe('A');
    });

    it('does not count a line that failed to parse as saying anything', () => {
      const analysis = analysisOf({
        lines: [lineOf('l1', { parsed: { ok: false, message: 'no', span: { start: 0, end: 1 } } })],
        requirements: [
          requirementOf('q', {
            nearMisses: [
              {
                line: 'l2',
                isRemainder: false,
                dimension: 'kind',
                reason: 'unstated',
                explanation: '`card`: kind unstated',
                suggestion: 'l1',
              },
            ],
          }),
        ],
      });
      expect(requirementRows(analysis)[0]?.nearMisses[0]?.alreadyOn).toBeNull();
    });
  });

  describe('the heading', () => {
    it('is the count and the description, as a criterion writes them', () => {
      expect(rowFor(MOTIVATING, 'monster').heading).toBe('1x monster');
    });

    it('lists each distinct count when criteria ask for different numbers', () => {
      const row = requirementRows(
        analysisOf({
          requirements: [
            requirementOf('monster', {
              appearsIn: [
                { criterion: 'c1', alternative: 0, n: 2 },
                { criterion: 'c2', alternative: 0, n: 1 },
                { criterion: 'c3', alternative: 0, n: 2 },
              ],
            }),
          ],
        }),
      )[0]!;
      expect(row.heading).toBe('1x / 2x monster');
    });

    it('carries the echo, which is what the description was understood as', () => {
      expect(rowFor(MOTIVATING, 'level 4 or lower monster').echo).toBe(
        'Level 4 or lower · Monster',
      );
    });

    it('writes a range as `a-bx`, and tells it apart from the plain count', () => {
      const row = requirementRows(
        analysisOf({
          requirements: [
            requirementOf('monster', {
              bounded: true,
              appearsIn: [
                { criterion: 'c1', alternative: 0, n: 1, max: 2 },
                // The same lower bound and no ceiling: a different thing, said separately.
                { criterion: 'c2', alternative: 0, n: 1 },
                { criterion: 'c3', alternative: 0, n: 1, max: 2 },
              ],
            }),
          ],
        }),
      )[0]!;
      expect(row.heading).toBe('1-2x / 1x monster');
    });

    it('writes a `unique` requirement as `nx unique`, apart from the plain count', () => {
      const row = requirementRows(
        analysisOf({
          requirements: [
            requirementOf('{Starter}', {
              appearsIn: [
                { criterion: 'c1', alternative: 0, n: 3, unique: true },
                { criterion: 'c2', alternative: 0, n: 3 },
              ],
            }),
          ],
        }),
      )[0]!;
      expect(row.heading).toBe('3x / 3x unique {Starter}');
    });

    it('writes a ceiling on `unique` as the range it is, the word after the count', () => {
      const row = requirementRows(
        analysisOf({
          requirements: [
            requirementOf('{Starter}', {
              appearsIn: [
                { criterion: 'c1', alternative: 0, n: 2, max: 2, unique: true },
                { criterion: 'c2', alternative: 0, n: 2, max: 3, unique: true },
              ],
            }),
          ],
        }),
      )[0]!;
      expect(row.heading).toBe('exactly 2x unique / 2-3x unique {Starter}');
    });

    it('writes a range whose ends agree as `exactly nx`, as the criterion text does', () => {
      const row = requirementRows(
        analysisOf({
          requirements: [
            requirementOf('monster', {
              bounded: true,
              appearsIn: [
                { criterion: 'c1', alternative: 0, n: 2, max: 2 },
                { criterion: 'c2', alternative: 0, n: 0, max: 0 },
              ],
            }),
          ],
        }),
      )[0]!;
      expect(row.heading).toBe('exactly 0x / exactly 2x monster');
    });
  });

  describe('what a ceiling ignores', () => {
    it('names the lines a range cannot see, and what they hold together', () => {
      const row = requirementRows(
        analysisOf({
          lines: [lineOf('any', { text: 'spell/trap' })],
          requirements: [
            requirementOf('trap', {
              bounded: true,
              appearsIn: [{ criterion: 'c1', alternative: 0, n: 1, max: 2 }],
              ignored: [{ line: 'any', isRemainder: false, min: 1, max: 4 }],
              ignoredRange: { min: 1, max: 4 },
            }),
          ],
        }),
      )[0]!;
      expect(row.bounded).toBe(true);
      expect(row.ignored).toEqual([{ label: 'any', range: '1–4' }]);
      expect(row.ignoredRange).toBe('1–4');
    });

    it('says nothing for a requirement with no ceiling', () => {
      const row = rowFor(MOTIVATING, 'monster');
      expect(row.bounded).toBe(false);
      expect(row.ignored).toEqual([]);
      expect(row.ignoredRange).toBeNull();
    });
  });

  describe('needed by', () => {
    it('names the criteria that ask for it, by their own names', () => {
      expect(rowFor(MOTIVATING, 'monster').neededBy).toEqual(['A, B and any monster']);
    });

    it('names each criterion once, however many alternatives of it ask', () => {
      expect(rowFor(MOTIVATING, '#40044918').neededBy).toEqual([
        'A, B and any monster',
        'A, B and a low-Level monster',
      ]);
    });
  });

  it('carries the requirement’s own issues, such as nothing filling it', () => {
    const analysis = analysisOf({
      requirements: [
        requirementOf('trap', {
          issues: [
            { severity: 'warning', code: 'unfilled', message: 'no line fills the requirement' },
          ],
        }),
      ],
    });
    expect(requirementRows(analysis)[0]?.issues).toHaveLength(1);
  });
});

/**
 * The same two strings the CLI's `matchingSection` pins (`tests/cli/report.test.ts`):
 * the renderer keeps its own copy of the phrasing, so both sides are held to it.
 */
describe('a count asked of the card you draw', () => {
  it('is marked `drawn`, and never shares a row with the same count over the hand', () => {
    const [requirement] = requirementRows(
      analysisOf({
        requirements: [
          requirementOf('trap', {
            appearsIn: [
              { criterion: 'c1', alternative: 0, n: 1 },
              { criterion: 'c1', alternative: 0, n: 1, sixth: true },
            ],
          }),
        ],
      }),
    );
    // In the order the cards arrive: the drawn cards before the whole hand.
    expect(requirement?.heading).toBe('1x drawn / 1x trap');

    const [limit] = limitRows(
      analysisOf({
        limits: [
          limitOf('trap', { appearsIn: [{ criterion: 'c1', alternative: 0, n: 0, sixth: true }] }),
        ],
      }),
    );
    expect(limit?.heading).toBe('no drawn trap');
  });

  /**
   * Each of a criterion's fields (PRD §5.5) is its own window, and the same
   * words over the five you open on and over all six are different statements —
   * so the opening-5 field is marked, and never shares a row with the whole hand.
   * The whole-hand field goes unmarked whether it stands alone or beside the
   * others: it is one window either way, the one every criterion written before
   * the fields was about.
   */
  it('marks a count asked of the opening five, first, and leaves the whole hand unmarked', () => {
    const [requirement] = requirementRows(
      analysisOf({
        requirements: [
          requirementOf('trap', {
            appearsIn: [
              { criterion: 'c1', alternative: 0, n: 2, whole: true },
              { criterion: 'c1', alternative: 0, n: 1, sixth: true },
              { criterion: 'c1', alternative: 0, n: 1, opening: true },
            ],
          }),
        ],
      }),
    );
    expect(requirement?.heading).toBe('1x in the opening 5 / 1x drawn / 2x trap');

    // The whole-hand field beside the others, and a plain criterion: one row.
    const [limit] = limitRows(
      analysisOf({
        limits: [
          limitOf('trap', {
            appearsIn: [
              { criterion: 'c1', alternative: 0, n: 1, whole: true },
              { criterion: 'c2', alternative: 0, n: 1 },
            ],
          }),
        ],
      }),
    );
    expect(limit?.heading).toBe('at most 1x trap');
  });
});

describe('limitRows', () => {
  it('is empty before the first analysis, and for a template with no limit', () => {
    expect(limitRows(null)).toEqual([]);
    expect(limitRows(MOTIVATING)).toEqual([]);
  });

  it('names the lines a limit counts: those known to match it (PRD §6.3)', () => {
    const [row] = limitRows(withLimit('1x monster, at most 1x [Elemental HERO Stratos]'));
    expect(row?.counts).toEqual(['A']);
  });

  it('names the under-specified lines it ignores, each with its own range', () => {
    const [row] = limitRows(withLimit('1x monster, at most 1x [Elemental HERO Stratos]'));
    expect(row?.ignored).toEqual([
      { label: 'monster', range: '5' },
      { label: 'level4', range: '2–3' },
      { label: 'the remainder', range: '13–33' },
    ]);
  });

  it('reports the total range of what it ignores — F1 on screen', () => {
    const [row] = limitRows(withLimit('1x monster, at most 1x [Elemental HERO Stratos]'));
    expect(row?.ignoredRange).toBe('21–40');
  });

  it('is the PRD’s own example for a limit nothing states: 13–33 unspecified cards', () => {
    const [row] = limitRows(withLimit('1x monster, at most 1x trap'));
    expect(row?.heading).toBe('at most 1x trap');
    expect(row?.counts).toEqual([]);
    expect(row?.ignoredRange).toBe('13–33');
    expect(row?.ignored).toEqual([{ label: 'the remainder', range: '13–33' }]);
  });

  it('has no ignored range when there is nothing it could be missing', () => {
    expect(limitRows(analysisOf({ limits: [limitOf('trap')] }))[0]?.ignoredRange).toBeNull();
  });

  it('writes a limit of none as `no`, the way a criterion does', () => {
    const row = limitRows(
      analysisOf({
        limits: [limitOf('trap', { appearsIn: [{ criterion: 'c1', alternative: 0, n: 0 }] })],
      }),
    )[0]!;
    expect(row.heading).toBe('no trap');
  });

  it('lists each distinct count when criteria limit it to different numbers', () => {
    const row = limitRows(
      analysisOf({
        limits: [
          limitOf('trap', {
            appearsIn: [
              { criterion: 'c1', alternative: 0, n: 2 },
              { criterion: 'c2', alternative: 0, n: 0 },
            ],
          }),
        ],
      }),
    )[0]!;
    expect(row.heading).toBe('no / at most 2x trap');
  });

  it('names the criteria it applies to', () => {
    const [row] = limitRows(withLimit('1x monster, at most 1x trap'));
    expect(row?.appliesTo).toEqual(['c3']);
  });

  it('carries the notices `analyze` attached, the "ignores" one among them', () => {
    const [row] = limitRows(withLimit('1x monster, at most 1x trap'));
    expect(row?.issues.map((issue) => issue.code)).toEqual([
      'limit-counts-nothing',
      'limit-ignores',
    ]);
    expect(row?.issues[1]?.message).toContain('ignores 13–33 cards');
  });
});

describe('criteriaIssues', () => {
  it('is empty before the first analysis', () => {
    expect(criteriaIssues(null)).toEqual([]);
  });

  it('is the template-wide issues about the criteria, and no others', () => {
    const analysis = analysisOf({
      issues: [
        { severity: 'warning', code: 'no-criteria', message: 'there is no criterion' },
        { severity: 'error', code: 'deck-size', message: 'the deck size is 4' },
        { severity: 'notice', code: 'subsumption-skipped', message: 'too many alternatives' },
        { severity: 'error', code: 'expansion-cap', message: 'too big' },
        { severity: 'error', code: 'infeasible', message: 'the ranges cannot sum' },
      ],
    });
    expect(criteriaIssues(analysis).map((issue) => issue.code)).toEqual([
      'no-criteria',
      'subsumption-skipped',
      'expansion-cap',
    ]);
  });

  it('says so when a template has no criterion at all', () => {
    const analysis = analyze({ ...motivatingTemplate(), criteria: [] }, CTX);
    expect(criteriaIssues(analysis).map((issue) => issue.message)).toEqual([
      'there is no criterion: every hand fails',
    ]);
  });
});
