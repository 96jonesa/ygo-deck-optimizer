import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  bestRatioRows,
  confirmationLine,
  formatCount,
  formatDuration,
  fractionText,
  progressLine,
  startFailureLines,
  topRows,
} from '../../../../src/renderer/src/model/run-format';
import type { Analysis, RunStartResult } from '../../../../src/shared/types';
import { motivatingResult } from '../../../helpers/motivating-run';

const SQL = await initSqlJs();
const RESULT = motivatingResult(SQL);

describe('formatCount', () => {
  it('groups the digits of a number, and rounds exact digits past 2^53 to three figures', () => {
    expect(formatCount(658_008)).toBe('658,008');
    expect(formatCount('9007199254740993')).toBe('about 9.00 × 10^15');
  });
});

describe('formatDuration', () => {
  it('says milliseconds, seconds, minutes, hours and days at the size they are', () => {
    expect(formatDuration(0.4)).toBe('under 1 ms');
    expect(formatDuration(740)).toBe('740 ms');
    expect(formatDuration(1_500)).toBe('1.5 s');
    expect(formatDuration(59_940)).toBe('59.9 s');
    expect(formatDuration(61_000)).toBe('1 min 1 s');
    expect(formatDuration(3_600_000 * 2 + 60_000 * 5)).toBe('2 h 5 min');
    expect(formatDuration(86_400_000 * 23)).toBe('23 days');
  });
});

describe('fractionText', () => {
  it('shows the exact fraction and the percentage it is', () => {
    expect(fractionText({ num: 46_185, den: 658_008 })).toBe('46,185 / 658,008 = 7.0189%');
    expect(fractionText({ num: 0, den: 658_008 })).toBe('0 / 658,008 = 0.0000%');
  });
});

describe('progressLine', () => {
  it('says done of total, the percentage, the time so far and the time left', () => {
    expect(progressLine({ done: 32, total: 128, elapsedMs: 1_000, etaMs: 3_000 })).toBe(
      '32 / 128 (25.0%) · 1.0 s elapsed · about 3.0 s left',
    );
  });

  it('takes a total past 2^53, which arrives as digits', () => {
    expect(
      progressLine({ done: 9_000_000, total: '9007199254740993', elapsedMs: 5_000, etaMs: 5e12 }),
    ).toBe('9,000,000 / about 9.00 × 10^15 (0.0%) · 5.0 s elapsed · about 57,870 days left');
  });

  it('does not say "about under" of the last instant', () => {
    expect(progressLine({ done: 127, total: 128, elapsedMs: 40, etaMs: 0.3 })).toBe(
      '127 / 128 (99.2%) · 40 ms elapsed · under 1 ms left',
    );
  });

  it('says nothing of the time left once nothing is', () => {
    expect(progressLine({ done: 128, total: 128, elapsedMs: 40, etaMs: 0 })).toBe(
      '128 / 128 (100.0%) · 40 ms elapsed',
    );
  });
});

describe('confirmationLine', () => {
  it('states the estimate and the size, so that the user can say yes knowingly', () => {
    expect(
      confirmationLine({
        reason: 'estimate',
        total: 5_758_374,
        estimatedMs: 25_001,
        thresholdMs: 10_000,
        cost: { perVectorUs: 0, perTermNs: 7 },
        message: '',
      }),
    ).toBe('This search scores 5,758,374 class vectors and would take about 25.0 s.');
  });

  it('does not say "about under": a tiny estimate, asked about only under a tiny threshold', () => {
    expect(
      confirmationLine({
        reason: 'estimate',
        total: 128,
        estimatedMs: 0.02,
        thresholdMs: 0,
        cost: { perVectorUs: 0, perTermNs: 7 },
        message: '',
      }),
    ).toBe('This search scores 128 class vectors and would take under 1 ms.');
  });

  it('says so when the vectors cannot even be counted off', () => {
    expect(
      confirmationLine({
        reason: 'unsafe-count',
        total: '9007199254740993',
        estimatedMs: 2e12,
        thresholdMs: 60_000,
        cost: { perVectorUs: 0, perTermNs: 7 },
        message: '',
      }),
    ).toBe(
      'This search scores about 9.00 × 10^15 class vectors — more than can be counted off — and would take about 23,148 days.',
    );
  });
});

describe('bestRatioRows', () => {
  it('gives every line its copies — a count when the vector fixes it, a range when its class can split', () => {
    expect(bestRatioRows(RESULT)).toEqual([
      { lineId: 'A', copies: '3', note: '' },
      { lineId: 'B', copies: '3', note: '' },
      { lineId: 'monster', copies: '5', note: '8 copies among `monster`, `fire-bw` — any split' },
      { lineId: 'level4', copies: '3', note: '' },
      { lineId: 'fire-bw', copies: '3', note: '' },
      {
        lineId: 'spell',
        copies: '0–7',
        note: '23 copies among `spell`, `normal-spell`, `remainder` — any split',
      },
      { lineId: 'normal-spell', copies: '0–3', note: '' },
      { lineId: 'remainder', copies: '13–23', note: '' },
    ]);
  });
});

describe('topRows', () => {
  it('lists the first rows of the ranked table: rank, percentage, exact fraction, one deck in lines', () => {
    const rows = topRows(RESULT, 5);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      rank: 1,
      percent: '7.0189%',
      exact: '46,185 / 658,008',
      example: [3, 3, 5, 3, 3, 7, 3, 13],
      rawRatios: '32',
    });
    expect(rows.map((row) => row.exact)).toEqual([
      '46,185 / 658,008',
      '43,698 / 658,008',
      '43,698 / 658,008',
      '40,995 / 658,008',
      '40,995 / 658,008',
    ]);
  });

  it('lists what there is when that is less', () => {
    expect(topRows({ ...RESULT, ranked: RESULT.ranked.slice(0, 2) }, 5)).toHaveLength(2);
  });
});

describe('startFailureLines', () => {
  it('says nothing of a run that started', () => {
    expect(startFailureLines({ ok: true, runId: 1 })).toEqual([]);
  });

  it('passes on why the cards are not ready', () => {
    expect(
      startFailureLines({
        ok: false,
        reason: 'not-ready',
        state: 'loading',
        message: 'the card data is still loading',
      }),
    ).toEqual(['the card data is still loading']);
  });

  it('lists what is malformed', () => {
    expect(
      startFailureLines({
        ok: false,
        reason: 'invalid',
        message: 'the run options are malformed',
        errors: ['`topK` must be a positive whole number'],
      }),
    ).toEqual(['the run options are malformed', '`topK` must be a positive whole number']);
  });

  it('lists every error the analysis found, where it found it', () => {
    const issue = (message: string, severity: 'error' | 'warning' = 'error') => ({
      severity,
      code: 'parse' as const,
      message,
    });
    const analysis = {
      issues: [issue('the ranges cannot fill the deck')],
      lines: [
        {
          id: 'typo',
          issues: [issue('unknown word `monstr`'), issue('only a warning', 'warning')],
        },
      ],
      remainder: { id: 'remainder', issues: [] },
      groups: [{ id: 'g1', issues: [issue('the group is empty')] }],
      requirements: [{ text: 'trap', issues: [issue('no line fills it')] }],
      limits: [{ text: 'spell', issues: [] }],
      criteria: [{ id: 'c1', issues: [issue('can never be met')] }],
    } as unknown as Analysis;
    const failure: RunStartResult = { ok: false, reason: 'template-errors', analysis };
    expect(startFailureLines(failure)).toEqual([
      'The template has errors; nothing was run.',
      'the ranges cannot fill the deck',
      'line typo: unknown word `monstr`',
      'group g1: the group is empty',
      'requirement trap: no line fills it',
      'criterion c1: can never be met',
    ]);
  });
});
