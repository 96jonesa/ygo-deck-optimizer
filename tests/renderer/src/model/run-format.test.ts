import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  bestRatioRows,
  bestReachText,
  confirmationLine,
  countsLabel,
  exactText,
  formatCount,
  formatDuration,
  fractionText,
  percentText,
  progressLine,
  readyText,
  runStatsText,
  startFailureLines,
  topRows,
} from '../../../../src/renderer/src/model/run-format';
import type { Analysis, RunStartResult, Template } from '../../../../src/shared/types';
import { motivatingResult } from '../../../helpers/motivating-run';

const SQL = await initSqlJs();
const RESULT = motivatingResult(SQL);

/** A template whose only interesting fields are the three the sentence counts. */
function templateOf(lines: number, criteria: number, deckSize = 40): Template {
  return {
    version: 1,
    deckSize,
    hand: { size: 5 },
    groups: [],
    lines: Array.from({ length: lines }, (_, at) => ({
      id: `l${at}`,
      text: 'spell',
      min: 0,
      max: 3,
    })),
    remainder: { min: 0, max: null },
    criteria: Array.from({ length: criteria }, (_, at) => ({ id: `c${at}`, text: '1x spell' })),
  };
}

/** Only `work` is read; the rest of an `Analysis` never reaches the sentence. */
function workOf(work: Partial<Analysis['work']>): Analysis {
  return {
    work: {
      rawRatios: null,
      classVectors: null,
      hands: null,
      estimatedMs: null,
      cost: { perVectorUs: 0, perTermNs: 7 },
      ...work,
    },
  } as unknown as Analysis;
}

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

describe('percentText', () => {
  it('turns an exact fraction into the percentage beside it, to four places', () => {
    expect(percentText({ num: 46_185, den: 658_008 })).toBe('7.0189%');
    expect(percentText({ num: 0, den: 658_008 })).toBe('0.0000%');
  });

  it('gives two exactly tied scores the same text, and two unequal ones different text', () => {
    expect(percentText({ num: 43_698, den: 658_008 })).toBe(
      percentText({ num: 43_698, den: 658_008 }),
    );
    expect(percentText({ num: 273_563, den: 658_008 })).not.toBe(
      percentText({ num: 272_039, den: 658_008 }),
    );
  });
});

describe('exactText', () => {
  it('is the fraction the ranking is actually done in', () => {
    expect(exactText({ num: 46_185, den: 658_008 })).toBe('46,185 / 658,008');
  });
});

describe('fractionText', () => {
  it('shows the exact fraction and the percentage it is', () => {
    expect(fractionText({ num: 46_185, den: 658_008 })).toBe('46,185 / 658,008 = 7.0189%');
    expect(fractionText({ num: 0, den: 658_008 })).toBe('0 / 658,008 = 0.0000%');
  });
});

describe('countsLabel', () => {
  it('collapses a run of neighbouring counts', () => {
    expect(countsLabel([3])).toBe('3');
    expect(countsLabel([1, 2])).toBe('1–2');
    expect(countsLabel([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])).toBe('13–23');
  });

  it('keeps a gap a gap rather than spanning it', () => {
    expect(countsLabel([0, 2, 3])).toBe('0, 2–3');
    expect(countsLabel([1, 3, 5])).toBe('1, 3, 5');
  });

  it('says nothing of no counts at all', () => {
    expect(countsLabel([])).toBe('');
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
      key: '23-3-3-8-3',
      rank: 1,
      tiedWith: 1,
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

  it('keys a row by the vector it is, since a tied rank no longer tells two rows apart', () => {
    const keys = topRows(RESULT, 8).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives exactly tied rows ONE rank, so a tie is never shown as an ordering', () => {
    const rows = topRows(RESULT, 5);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 2, 4, 4]);
    expect(rows.map((row) => row.tiedWith)).toEqual([1, 2, 2, 2, 2]);
  });

  it('counts a tie across the whole kept table, not only the rows on screen', () => {
    // Rows 2 and 3 tie; asking for two rows must still say the second is tied.
    expect(topRows(RESULT, 2).map((row) => row.tiedWith)).toEqual([1, 2]);
  });

  it('ties on the exact numerator, not on the rounded percentage', () => {
    // Two scores that round to the same four places but are NOT a tie.
    const ranked = [
      { ...RESULT.ranked[0]!, blend: { num: 10_000_001, den: 65_800_800 } },
      { ...RESULT.ranked[1]!, blend: { num: 10_000_000, den: 65_800_800 } },
    ];
    const rows = topRows({ ...RESULT, ranked }, 2);
    expect(rows.map((row) => row.percent)).toEqual(['15.1974%', '15.1974%']);
    expect(rows.map((row) => row.rank)).toEqual([1, 2]);
    expect(rows.map((row) => row.tiedWith)).toEqual([1, 1]);
  });

  it('lists what there is when that is less', () => {
    expect(topRows({ ...RESULT, ranked: RESULT.ranked.slice(0, 2) }, 5)).toHaveLength(2);
  });
});

describe('runStatsText', () => {
  it('says what was scored, over how many raw ratios, in how long, for which hand', () => {
    expect(runStatsText(RESULT)).toBe('128 of 128 class vectors · 4,096 raw ratios · hand of 5');
  });

  it('says how far a cancelled run got', () => {
    expect(runStatsText({ ...RESULT, status: 'cancelled', done: 37, partial: true })).toBe(
      '37 of 128 class vectors · 4,096 raw ratios · hand of 5',
    );
  });
});

describe('bestReachText', () => {
  it('says how many raw ratios the best class vector stands for', () => {
    expect(bestReachText(RESULT)).toBe(
      '32 raw ratios are this deck, as far as the criteria can tell',
    );
  });

  it('says one of them in the singular', () => {
    const best = { ...RESULT.best, rawRatios: 1 };
    expect(bestReachText({ ...RESULT, best })).toBe(
      '1 raw ratio is this deck, as far as the criteria can tell',
    );
  });
});

describe('readyText', () => {
  it('says what the template is when the analysis has not sized it yet', () => {
    expect(readyText(templateOf(7, 2), null)).toBe(
      'Ready to score: 7 lines, 2 criteria, deck of 40.',
    );
  });

  it('adds the size and the estimate `analyze` worked out, rather than working them out again', () => {
    expect(
      readyText(templateOf(7, 2), workOf({ classVectors: 128, rawRatios: 4096, estimatedMs: 12 })),
    ).toBe(
      'Ready to score: 7 lines, 2 criteria, deck of 40. 128 class vectors over 4,096 raw ratios, about 12 ms.',
    );
  });

  it('leaves out an estimate the analysis does not have', () => {
    expect(readyText(templateOf(1, 1, 60), workOf({ classVectors: 9, rawRatios: 9 }))).toBe(
      'Ready to score: 1 lines, 1 criteria, deck of 60. 9 class vectors over 9 raw ratios.',
    );
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
