import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../../../src/core/model/analyze';
import {
  echoText,
  groupAnalysisOf,
  issuesToList,
  issueTone,
  kindTotals,
  lineAnalysisOf,
  matchText,
  NO_ANALYSIS,
  parseFailureOf,
  reduceAnalysis,
  remainderRange,
  remainderText,
  templateErrorText,
  workText,
  worstSeverity,
} from '../../../../src/renderer/src/model/analysis-view';
import type {
  Analysis,
  AnalyzeTemplateResult,
  Issue,
  Severity,
} from '../../../../src/shared/types';
import { analysisOf, lineOf } from '../../../helpers/analysis';
import { motivatingContext, motivatingTemplate } from '../../../helpers/motivating';

/**
 * The real thing: the motivating example analysed against the fixture card
 * database, so that every readout below is checked against what `analyze`
 * actually produces rather than against a hand-written imitation of it.
 */
const MOTIVATING: Analysis = analyze(motivatingTemplate(), motivatingContext(await initSqlJs()));

const issue = (severity: Severity, message = 'something'): Issue => ({
  severity,
  code: 'no-match',
  message,
});

describe('reduceAnalysis', () => {
  it('takes the analysis main produced', () => {
    const result: AnalyzeTemplateResult = { ok: true, analysis: MOTIVATING };
    expect(reduceAnalysis(NO_ANALYSIS, result)).toEqual({ analysis: MOTIVATING, problem: null });
  });

  it('clears a problem that a later analysis answered', () => {
    const view = reduceAnalysis(NO_ANALYSIS, {
      ok: false,
      reason: 'not-ready',
      state: 'loading',
      message: 'the card data is still loading',
    });
    expect(reduceAnalysis(view, { ok: true, analysis: MOTIVATING }).problem).toBeNull();
  });

  it('KEEPS the last analysis through a re-index, which is 68 ms', () => {
    // The same rule as `selectShows` (TDD §3): a reload must not take away
    // what the user was reading.
    const view = reduceAnalysis(NO_ANALYSIS, { ok: true, analysis: MOTIVATING });
    const during = reduceAnalysis(view, {
      ok: false,
      reason: 'not-ready',
      state: 'loading',
      message: 'the card data is still loading',
    });
    expect(during.analysis).toBe(MOTIVATING);
    expect(during.problem).toBe('the card data is still loading');
  });

  it('reports a template main could not read at all, with every reason', () => {
    const view = reduceAnalysis(NO_ANALYSIS, {
      ok: false,
      reason: 'invalid',
      message: 'this is not a well-formed template',
      errors: ['`lines` is missing', '`hand` must be { size }'],
    });
    expect(view.problem).toContain('this is not a well-formed template');
    expect(view.problem).toContain('`lines` is missing');
    expect(view.problem).toContain('`hand` must be { size }');
  });
});

describe('lineAnalysisOf', () => {
  it('finds the line by its id', () => {
    expect(lineAnalysisOf(MOTIVATING, 'level4')?.text).toBe('level 4 monster');
  });

  it('is nothing before the first analysis arrives', () => {
    expect(lineAnalysisOf(null, 'level4')).toBeNull();
  });

  it('is nothing for a line the analysis in hand does not know — it lags one edit behind', () => {
    expect(lineAnalysisOf(MOTIVATING, 'line99')).toBeNull();
  });

  it('does not hand one line the issues of another', () => {
    const analysis = analysisOf({
      lines: [
        lineOf('a', { issues: [issue('error', 'a is wrong')] }),
        lineOf('b', { issues: [issue('notice', 'b is fine')] }),
      ],
    });
    expect(lineAnalysisOf(analysis, 'b')?.issues).toEqual([issue('notice', 'b is fine')]);
  });

  it('matches the whole id, not a prefix of it — in either order', () => {
    for (const lines of [
      [lineOf('line1'), lineOf('line11')],
      // The longer id FIRST: a prefix match would hand `line1` the other line's row.
      [lineOf('line11'), lineOf('line1')],
    ]) {
      const analysis = analysisOf({ lines });
      expect(lineAnalysisOf(analysis, 'line1')?.text).toBe('line1');
      expect(lineAnalysisOf(analysis, 'line11')?.text).toBe('line11');
    }
  });
});

describe('worstSeverity', () => {
  it('is nothing when there is nothing to say', () => {
    expect(worstSeverity([])).toBeNull();
  });

  it('is the loudest of what there is', () => {
    expect(worstSeverity([issue('notice'), issue('warning')])).toBe('warning');
    expect(worstSeverity([issue('notice'), issue('error'), issue('warning')])).toBe('error');
  });

  it('does not promote a notice to an error', () => {
    expect(worstSeverity([issue('notice'), issue('notice')])).toBe('notice');
  });

  it('keeps the zero-match notice a notice: a generic line need not name cards that exist', () => {
    const fireBw = lineAnalysisOf(MOTIVATING, 'fire-bw')!;
    expect(fireBw.count).toBe(0);
    expect(fireBw.issues.map((found) => found.code)).toContain('no-match');
    expect(worstSeverity(fireBw.issues)).toBe('notice');
  });
});

describe('issueTone', () => {
  it('gives each severity its own tone', () => {
    expect(issueTone('error')).toBe('bad');
    expect(issueTone('warning')).toBe('warn');
    expect(issueTone('notice')).toBe('note');
  });

  it('gives nothing a tone of its own, so a quiet line stays quiet', () => {
    expect(issueTone(null)).toBe('');
  });
});

describe('echoText', () => {
  it('is what the description was understood as', () => {
    expect(echoText(lineAnalysisOf(MOTIVATING, 'level4'))).toBe('Level 4 · Monster');
  });

  it('is what a named card was understood as', () => {
    expect(echoText(lineAnalysisOf(MOTIVATING, 'A'))).toBe('Elemental HERO Stratos');
  });

  it('is nothing for a line that did not parse: the error is the readout', () => {
    expect(
      echoText(
        lineOf('l1', {
          parsed: { ok: false, message: 'unknown word', span: { start: 0, end: 3 } },
        }),
      ),
    ).toBeNull();
  });

  it('is nothing before the analysis knows the line', () => {
    expect(echoText(null)).toBeNull();
  });
});

describe('matchText', () => {
  it('counts the cards that match, and names a few', () => {
    const text = matchText(lineAnalysisOf(MOTIVATING, 'monster'))!;
    expect(text).toMatch(/^\d[\d,]* cards: /);
  });

  it('says one card in the singular', () => {
    expect(matchText(lineAnalysisOf(MOTIVATING, 'A'))).toBe('1 card: Elemental HERO Stratos');
  });

  it('states a zero match plainly: the notice beside it is what says it is allowed', () => {
    const text = matchText(lineAnalysisOf(MOTIVATING, 'fire-bw'))!;
    expect(text).toBe('no matching cards in the database');
    expect(text.toLowerCase()).not.toContain('error');
    expect(text).not.toContain('0 cards');
  });

  it('marks that the samples are only the first few', () => {
    expect(matchText(lineAnalysisOf(MOTIVATING, 'monster'))).toMatch(/…$/);
  });

  it('is nothing for a line that did not parse', () => {
    expect(matchText(lineOf('l1', { count: null }))).toBeNull();
  });
});

describe('parseFailureOf', () => {
  it('is the message and the span of a line that did not parse', () => {
    const failed = lineOf('l1', {
      parsed: { ok: false, message: 'unknown word "monstr"', span: { start: 8, end: 14 } },
    });
    expect(parseFailureOf(failed)).toEqual({
      message: 'unknown word "monstr"',
      span: { start: 8, end: 14 },
    });
  });

  it('is nothing for a line that parsed', () => {
    expect(parseFailureOf(lineAnalysisOf(MOTIVATING, 'monster'))).toBeNull();
  });

  it('is nothing before the analysis knows the line', () => {
    expect(parseFailureOf(null)).toBeNull();
  });
});

describe('issuesToList', () => {
  it('is every issue of a line that parsed', () => {
    const fireBw = lineAnalysisOf(MOTIVATING, 'fire-bw')!;
    expect(issuesToList(fireBw)).toEqual(fireBw.issues);
    expect(issuesToList(fireBw)).not.toHaveLength(0);
  });

  it('leaves the parse error out: the readout shows it once, with its span marked', () => {
    const failed = lineOf('l1', {
      parsed: { ok: false, message: 'unknown word "monstr"', span: { start: 8, end: 14 } },
      count: null,
      issues: [
        { severity: 'error', code: 'parse', message: 'unknown word "monstr"' },
        { severity: 'error', code: 'min-over-max', message: '`min` 3 is greater than `max` 1' },
      ],
    });
    expect(issuesToList(failed).map((found) => found.code)).toEqual(['min-over-max']);
  });

  it('is empty before the analysis knows the line', () => {
    expect(issuesToList(null)).toEqual([]);
  });
});

describe('remainderRange', () => {
  it('is the range `analyze` computed for the unspecified cards', () => {
    expect(remainderRange(MOTIVATING)).toBe('13–33');
  });

  it('is nothing when the ranges cannot fill the deck', () => {
    expect(
      remainderRange(analysisOf({ remainder: { ...analysisOf({}).remainder, range: null } })),
    ).toBeNull();
  });

  it('is nothing before the first analysis', () => {
    expect(remainderRange(null)).toBeNull();
  });
});

describe('remainderText', () => {
  it('is what the lines leave of the deck', () => {
    expect(remainderText(MOTIVATING)).toBe('Unspecified cards: 13–33');
  });

  it('READS the range off the analysis rather than working it out again', () => {
    // The achievable range is not the naive sum (TDD §9). If the renderer did
    // the arithmetic itself it would disagree with the engine, so this pins
    // that the number on screen is the engine's.
    const analysis = analysisOf({
      deckSize: 40,
      lines: [lineOf('l1', { min: 0, max: 3 })],
      remainder: { ...analysisOf({}).remainder, range: { min: 30, max: 35 } },
    });
    expect(remainderText(analysis)).toBe('Unspecified cards: 30–35');
  });

  it('says so when the ranges cannot fill the deck at all', () => {
    const analysis = analysisOf({ remainder: { ...analysisOf({}).remainder, range: null } });
    expect(remainderText(analysis)).toContain('cannot');
  });

  it('is nothing before the first analysis', () => {
    expect(remainderText(null)).toBeNull();
  });
});

describe('kindTotals', () => {
  it('is the derived totals, in the engine’s order', () => {
    expect(kindTotals(MOTIVATING)).toEqual([
      {
        kind: 'monster',
        label: 'Known monsters',
        range: '7–14',
        lines: ['A', 'monster', 'level4', 'fire-bw'],
      },
      {
        kind: 'spell',
        label: 'Known spells',
        range: '0–13',
        lines: ['B', 'spell', 'normal-spell'],
      },
      { kind: 'trap', label: 'Known traps', range: '0', lines: [] },
    ]);
  });

  it('shows no range at all when the ranges cannot sum to the deck size', () => {
    const analysis = analysisOf({
      totals: {
        feasible: false,
        kinds: [{ kind: 'monster', lines: ['l1'], range: null }],
        lines: { min: 50, max: 50 },
        remainder: null,
      },
    });
    expect(kindTotals(analysis)).toEqual([
      { kind: 'monster', label: 'Known monsters', range: null, lines: ['l1'] },
    ]);
  });

  it('is empty before the first analysis', () => {
    expect(kindTotals(null)).toEqual([]);
  });
});

describe('templateErrorText', () => {
  it('is nothing for a template with nothing wrong with it', () => {
    expect(templateErrorText(MOTIVATING)).toBeNull();
  });

  it('is the error when the ranges cannot sum to the deck size', () => {
    const analysis = analysisOf({
      ok: false,
      issues: [
        {
          severity: 'error',
          code: 'infeasible',
          message:
            'the ranges cannot sum to the deck size: the lines and the remainder hold at least 50 cards, 10 more than the deck of 40',
        },
      ],
    });
    expect(templateErrorText(analysis)).toContain('cannot sum to the deck size');
  });

  it('leaves a warning of the template as a whole out of the error line', () => {
    const analysis = analysisOf({
      issues: [{ severity: 'warning', code: 'no-criteria', message: 'there is no criterion' }],
    });
    expect(templateErrorText(analysis)).toBeNull();
  });

  it('is nothing before the first analysis', () => {
    expect(templateErrorText(null)).toBeNull();
  });
});

describe('workText', () => {
  it('says how many ratios a run would have to look at', () => {
    expect(workText(MOTIVATING)).toBe('4,096 ratios · 128 scored');
  });

  it('is nothing while the template does not compile', () => {
    expect(workText(analysisOf({}))).toBeNull();
  });

  it('is nothing before the first analysis', () => {
    expect(workText(null)).toBeNull();
  });
});

describe('groupAnalysisOf', () => {
  it('is nothing for a template with no groups', () => {
    expect(groupAnalysisOf(MOTIVATING, 'g1')).toBeNull();
  });

  it('finds the group by its id', () => {
    const analysis = analysisOf({
      groups: [
        { id: 'g1', name: 'starter', size: 2, missing: [], issues: [] },
        { id: 'g2', name: 'brick', size: 0, missing: [], issues: [issue('warning', 'empty')] },
      ],
    });
    expect(groupAnalysisOf(analysis, 'g2')?.name).toBe('brick');
    expect(groupAnalysisOf(analysis, 'g1')?.issues).toEqual([]);
  });
});
