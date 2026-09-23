import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  bestRatioRows,
  bestReachText,
  confirmationLine,
  countsLabel,
  drawFloorNote,
  exactText,
  formatCount,
  formatDuration,
  fractionText,
  partLines,
  partShape,
  partsColumnLabel,
  partsCombineNote,
  percentText,
  progressLine,
  readyText,
  runStatsText,
  scoreLabel,
  scoreText,
  startFailureLines,
  topRows,
  weightText,
} from '../../../../src/renderer/src/model/run-format';
import type { Analysis, Fraction, RunStartResult, Template } from '../../../../src/shared/types';
import {
  motivatingDrawing,
  motivatingIn,
  motivatingResult,
  motivatingWeighted,
} from '../../../helpers/motivating-run';

const SQL = await initSqlJs();
const RESULT = motivatingResult(SQL);

/** A template whose only interesting fields are the three the sentence counts. */
function templateOf(lines: number, criteria: number, deckSize = 40): Template {
  return {
    version: 2,
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
      value: '7.0189%',
      exact: '46,185 / 658,008',
      // An unweighted run ranked by the probability, so the two agree exactly.
      successPercent: '7.0189%',
      successExact: '46,185 / 658,008',
      parts: [],
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
    expect(rows.map((row) => row.value)).toEqual(['15.1974%', '15.1974%']);
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

  /**
   * WHERE A NUMBER WAS, A BLANK IS NOT AN ANSWER. Past `ANALYZE_DRAW_WORK` the
   * analysis stops counting the terms per score and the estimate built on them
   * (`work-not-counted`) — and the template STILL RUNS. Left as it was, the
   * sentence beside Run would quietly drop the estimate and say nothing about
   * why, which reads as a tool that has lost track of what it is about to do.
   *
   * The notice is what triggers it, not `estimatedMs` being null: that is
   * `analyze`'s own classification of why the number is missing, and the test
   * above is the case where nothing has said why.
   */
  it('says why there is no estimate when the analysis declined to count the work', () => {
    const analysis = workOf({ classVectors: 128, rawRatios: 4096 });
    const notCounted: Analysis = {
      ...analysis,
      issues: [{ severity: 'notice', code: 'work-not-counted', message: 'too many to count' }],
    };
    expect(readyText(templateOf(7, 2), notCounted)).toBe(
      'Ready to score: 7 lines, 2 criteria, deck of 40. 128 class vectors over 4,096 raw ratios. The time is not estimated: these draw cards are too many to enumerate on every edit, and the run itself is unaffected.',
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

/**
 * The five numbers of an average run (PRD §5.5): the mean, which is the sort
 * key, and each hand's own probability and exact fraction. The two hands have
 * DIFFERENT denominators — C(40,5) against C(40,6) — so one fraction could
 * only ever be one of them, and showing one would be showing the wrong one.
 *
 * Every figure here is read off the RESULT and none is recomputed from a live
 * analysis (TDD §3): the result below is a real search, cloned as IPC clones
 * it, and the tests hold the text to fractions it carries.
 */
describe('a run over both hands', () => {
  const AVERAGE = motivatingResult(SQL, motivatingIn('average'));
  /** c1 going first, c2 going second: the motivating example's two criteria, split. */
  const TAGGED = motivatingResult(SQL, motivatingIn('average', { c1: 'first', c2: 'second' }));

  describe('partLines', () => {
    it('is empty for a single-hand run: its one number is the headline already', () => {
      expect(partLines(RESULT.best.score)).toEqual([]);
    });

    it('names each hand, with its own percentage and its own exact fraction', () => {
      const lines = partLines(AVERAGE.best.score);
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => line.label)).toEqual(['going first', 'going second']);
      const [first, second] = AVERAGE.best.score.parts;
      expect(lines[0]).toEqual({
        key: '5',
        label: 'going first',
        hand: 5,
        prefix: null,
        value: percentText(first!),
        exact: exactText(first!),
        successPercent: percentText(first!),
        successExact: exactText(first!),
      });
      expect(lines[1]!.exact).toBe(exactText(second!));
      // The two really are over different denominators.
      expect(first!.den).not.toBe(second!.den);
    });

    it('says the weights when they are not even', () => {
      const parts = AVERAGE.best.score.parts.map((part, at) => ({
        ...part,
        weight: at === 0 ? 3 : 2,
      }));
      const lines = partLines({ ...AVERAGE.best.score, parts });
      expect(lines.map((line) => line.label)).toEqual(['going first × 3', 'going second × 2']);
    });
  });

  describe('topRows', () => {
    it('shows the average as the score, and both hands beside it', () => {
      const [row] = topRows(AVERAGE, 1);
      expect(row!.value).toBe(percentText(AVERAGE.ranked[0]!.blend));
      expect(row!.exact).toBe(exactText(AVERAGE.ranked[0]!.blend));
      expect(row!.parts).toEqual(partLines(AVERAGE.ranked[0]!.score));
      expect(row!.parts).toHaveLength(2);
    });

    it('orders by the exact rank key and never by the displayed mean', () => {
      const rows = topRows(AVERAGE, AVERAGE.ranked.length);
      const keys = AVERAGE.ranked.map((vector) => vector.blend.num);
      expect(keys).toEqual([...keys].sort((a, b) => b - a));
      // A row's rank is the first position its exact key appears at, so an
      // exact tie stays one rank however the percentages round.
      const firstAt = new Map<number, number>();
      keys.forEach((key, at) => {
        if (!firstAt.has(key)) firstAt.set(key, at);
      });
      expect(rows.map((row) => row.rank)).toEqual(keys.map((key) => firstAt.get(key)! + 1));
    });

    it('shows the mean as the mean: it is the parts cross-multiplied, exactly', () => {
      for (const vector of AVERAGE.ranked.slice(0, 20)) {
        const [a, b] = vector.score.parts as unknown as [Fraction, Fraction];
        // (a + b) / 2 == blend, in whole numbers on both sides.
        expect(
          (BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den)) *
            BigInt(vector.blend.den),
        ).toBe(2n * BigInt(a.den) * BigInt(b.den) * BigInt(vector.blend.num));
      }
    });
  });

  describe('runStatsText', () => {
    it('says both hands and their weights', () => {
      expect(runStatsText(AVERAGE)).toContain('hand of 5 × 1, hand of 6 × 1');
    });
  });

  it('scores a tagged criterion in the parts it is tagged for, and 0 in the others', () => {
    const byId = new Map(TAGGED.breakdown.map((row) => [row.id, row.score.parts]));
    // c1 is going first only, so its going-second part can meet nothing at
    // all — and the criterion's share of the average is halved, not hidden.
    expect(byId.get('c1')!.map((part) => part.num === 0)).toEqual([false, true]);
    expect(byId.get('c2')!.map((part) => part.num === 0)).toEqual([true, false]);
    // Untagged, both parts count it: the same run, all three tags reached.
    const both = motivatingResult(SQL, motivatingIn('average')).breakdown;
    expect(both[0]!.score.parts.map((part) => part.num === 0)).toEqual([false, false]);
  });
});

/**
 * A weighted run on screen (PRD §5.6). The headline stops being a percentage
 * and becomes an expected weight per hand — 0 to the largest weight, so a `%`
 * would be a lie — and the plain probability is carried beside it rather than
 * replaced. Which of the two a figure is comes off the RESULT, never off the
 * template on screen (TDD §3).
 */
describe('a weighted run', () => {
  /** `A, B and any monster` worth 4; `A, B and a low-Level monster` worth 1. */
  const WEIGHTED = motivatingResult(SQL, motivatingWeighted({ c1: 4 }));

  it('says which kind of number the headline is', () => {
    expect(scoreLabel(false)).toBe('P(at least one criterion)');
    expect(scoreLabel(true)).toBe('expected weight per hand');
  });

  it('shows an expected weight as a plain number, to four places', () => {
    expect(weightText({ num: 46_185, den: 658_008 })).toBe('0.0702');
    expect(weightText({ num: 3 * 658_008, den: 658_008 })).toBe('3.0000');
    // scoreText is the one that chooses, and it chooses by the run's own flag.
    expect(scoreText({ num: 46_185, den: 658_008 }, false)).toBe('7.0189%');
    expect(scoreText({ num: 46_185, den: 658_008 }, true)).toBe('0.0702');
  });

  it('ranks the table by the weighted score and prints the probability beside it', () => {
    expect(WEIGHTED.weighted).toBe(true);
    const [row] = topRows(WEIGHTED, 1);
    expect(row!.value).toBe(weightText(WEIGHTED.best.blend));
    expect(row!.exact).toBe(exactText(WEIGHTED.best.blend));
    expect(row!.successPercent).toBe(percentText(WEIGHTED.best.success));
    // The motivating example's second criterion is subsumed by its first, so
    // every hand that meets anything meets the heavy one: four times over.
    expect(WEIGHTED.best.blend.num).toBe(4 * WEIGHTED.best.success.num);
    expect(row!.value).toBe('0.2808');
    expect(row!.successPercent).toBe('7.0189%');
  });

  it('is the unweighted readout again with the switch off', () => {
    const off = motivatingResult(SQL, { ...motivatingWeighted({ c1: 4 }), weighted: false });
    expect(off.weighted).toBe(false);
    expect(topRows(off, 5)).toEqual(topRows(RESULT, 5));
  });
});

/**
 * A DRAWING run on screen (PRD §5.7). A run now carries one part per PREFIX
 * LENGTH, and they are disjoint outcomes that SUM — not the weighted mean the
 * first/second blend takes. Everything below is read off the result, which is a
 * real search: a headline that said "averaged over the two hands" over a sum
 * would be a sentence that is false of the number it sits under.
 */
describe('a drawing run', () => {
  const DRAWN = motivatingResult(SQL, motivatingDrawing());
  /** Both at once: two hand sizes, each with its own prefix lengths. */
  const DRAWN_AVERAGE = motivatingResult(SQL, motivatingDrawing('average'));
  /** The blend that averages rather than sums, to tell the two shapes apart by. */
  const AVERAGE = motivatingResult(SQL, motivatingIn('average'));
  const AVERAGE_SCORE = AVERAGE.best.score;

  it('carries one part per prefix length, and their fractions sum to the headline', () => {
    const { parts } = DRAWN.best.score;
    expect(parts.map((part) => part.prefix)).toEqual([5, 7]);
    expect(parts.map((part) => part.H)).toEqual([5, 5]);
    // The headline really is the SUM, in whole numbers on both sides: the
    // renderer never adds fractions, so this is what it is trusting.
    const [a, b] = parts as [(typeof parts)[0], (typeof parts)[0]];
    expect(
      (BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den)) *
        BigInt(DRAWN.best.blend.den),
    ).toBe(BigInt(a.den) * BigInt(b.den) * BigInt(DRAWN.best.blend.num));
  });

  describe('partShape', () => {
    it('says a single-hand run has nothing beneath its headline', () => {
      expect(partShape(RESULT.best.score)).toBe('none');
    });

    it('tells a first/second blend from a sum over prefix lengths', () => {
      expect(partShape(AVERAGE_SCORE)).toBe('hands');
      expect(partShape(DRAWN.best.score)).toBe('lengths');
    });

    it('says when a run is both: a sum per hand, averaged over the hands', () => {
      expect(partShape(DRAWN_AVERAGE.best.score)).toBe('both');
    });
  });

  describe('partsCombineNote', () => {
    it('says how the parts make the headline, in each of the three shapes', () => {
      expect(partsCombineNote('none')).toBeNull();
      expect(partsCombineNote('hands')).toBe(', averaged over the two hands');
      expect(partsCombineNote('lengths')).toBe(', and the parts below ADD UP to it');
      expect(partsCombineNote('both')).toBe(
        ', summed over the prefix lengths and averaged over the two hands',
      );
    });
  });

  describe('partsColumnLabel', () => {
    it('heads the ranked column with what the number IS', () => {
      expect(partsColumnLabel('none', false)).toBe('P');
      expect(partsColumnLabel('none', true)).toBe('weight');
      expect(partsColumnLabel('hands', false)).toBe('average');
      expect(partsColumnLabel('lengths', false)).toBe('total');
      expect(partsColumnLabel('both', false)).toBe('average');
    });
  });

  describe('partLines', () => {
    /**
     * `prefix` is the length of the PREFIX — how deep into the deck the hand
     * read — so the cards DRAWN are `prefix − H`. Labelling the prefix itself
     * "5 cards drawn" for a hand of five that drew nothing was wrong by exactly
     * `H`, and it read as a part that could not possibly exist.
     */
    it('names each part by the cards DRAWN, not by the prefix length', () => {
      const lines = partLines(DRAWN.best.score);
      expect(lines.map((line) => line.label)).toEqual(['nothing drawn', '2 drawn']);
      expect(lines.map((line) => line.prefix)).toEqual([5, 7]);
    });

    it('says the one in the singular', () => {
      const parts = DRAWN.best.score.parts.map((part, at) =>
        at === 1 ? { ...part, prefix: 6 } : part,
      );
      expect(partLines({ ...DRAWN.best.score, parts })[1]!.label).toBe('1 drawn');
    });

    /**
     * Two hand sizes and two lengths each give four parts, and two of them draw
     * the same number of cards. Labelled by the draws alone they would read the
     * same, and keyed by the hand size alone two React rows would share a key —
     * so both carry the hand as well.
     */
    it('tells the hand sizes apart when a run has both', () => {
      const lines = partLines(DRAWN_AVERAGE.best.score);
      expect(lines.map((line) => line.label)).toEqual([
        'going first · nothing drawn',
        'going first · 2 drawn',
        'going second · nothing drawn',
        'going second · 2 drawn',
      ]);
      expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
    });

    it('gives every part of every shape a key of its own', () => {
      for (const score of [AVERAGE_SCORE, DRAWN.best.score, DRAWN_AVERAGE.best.score]) {
        const lines = partLines(score);
        expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
      }
    });

    it('still says the hand weights when they are uneven', () => {
      const parts = DRAWN_AVERAGE.best.score.parts.map((part) => ({
        ...part,
        weight: part.H === 5 ? 3 : 2,
      }));
      const lines = partLines({ ...DRAWN_AVERAGE.best.score, parts });
      expect(lines[0]!.label).toBe('going first × 3 · nothing drawn');
      expect(lines[3]!.label).toBe('going second × 2 · 2 drawn');
    });
  });

  describe('drawFloorNote', () => {
    /**
     * THE NUMBER IS A FLOOR, NOT A FORECAST, and that has to sit under the
     * number rather than only in the editor: there is one decision, taken before
     * anything is drawn, so a player who stops halfway does better. Read off the
     * RESULT — a caveat has to be true of the number it sits under, whatever the
     * template says by the time it is read.
     */
    it('is said for a run that drew, and names the escape hatch', () => {
      const note = drawFloorNote(DRAWN)!;
      expect(note).toContain('LOWER bound');
      expect(note).toContain('one decision');
      expect(note).toContain('"stop here"');
    });

    it('is nothing at all for a run that drew no cards', () => {
      expect(drawFloorNote(RESULT)).toBeNull();
      expect(drawFloorNote(AVERAGE)).toBeNull();
    });

    it('is said for the average of two drawing hands too', () => {
      expect(drawFloorNote(DRAWN_AVERAGE)).not.toBeNull();
    });
  });

  describe('topRows', () => {
    it('carries the per-length parts down every row, from the row itself', () => {
      const rows = topRows(DRAWN, 3);
      for (const row of rows) expect(row.parts.map((part) => part.prefix)).toEqual([5, 7]);
      expect(rows[0]!.parts).toEqual(partLines(DRAWN.ranked[0]!.score));
    });
  });

  describe('runStatsText', () => {
    /** One hand size, however many lengths it reaches: the prefix is not a hand. */
    it('still reports one hand', () => {
      expect(runStatsText(DRAWN)).toContain('hand of 5');
      expect(runStatsText(DRAWN)).not.toContain('hand of 7');
    });
  });
});
