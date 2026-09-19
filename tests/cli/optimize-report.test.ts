import { describe, expect, it } from 'vitest';
import {
  formatCounts,
  formatNeedsConfirmation,
  formatOptimizeProgress,
  fraction,
  irrelevantSection,
  percent,
  plateauSection,
  searchSection,
  sweepsSection,
} from '../../src/cli/optimize-report';
import { type CompileInput, compileProblem } from '../../src/core/model/compile';
import { type OptimizeOutputs, optimize } from '../../src/core/opt/optimizer';

/** Lines a 0–3 and b 0–3 that matter, `junk` that does not; the remainder holds at least `remainderMin`. */
function outputs(remainderMin: number, opts: Parameters<typeof optimize>[1] = {}) {
  const input: CompileInput = {
    deckSize: 40,
    handSize: 5,
    lines: [
      { id: 'a', isRemainder: false, min: 0, max: 3 },
      { id: 'b', isRemainder: false, min: 0, max: 3 },
      { id: 'junk', isRemainder: false, min: 0, max: 2 },
      { id: 'remainder', isRemainder: true, min: remainderMin, max: null },
    ],
    matrix: [
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ],
    flat: [
      {
        reqs: [
          { n: 1, desc: 0 },
          { n: 1, desc: 1 },
        ],
        limits: [],
      },
    ],
  };
  const compiled = compileProblem(input);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  const result = optimize(compiled, { cost: { perVectorUs: 0.05, perTermNs: 6 }, ...opts });
  if (result.status !== 'done' && result.status !== 'cancelled') throw new Error(result.status);
  return result as OptimizeOutputs;
}

describe('percent', () => {
  it('shows four decimals', () => {
    expect(percent(46185 / 658008)).toBe('7.0189%');
    expect(percent(0)).toBe('0.0000%');
    expect(percent(1)).toBe('100.0000%');
  });
});

describe('fraction', () => {
  it('groups the digits of both whole numbers', () => {
    expect(fraction({ num: 46185, den: 658008 })).toBe('46,185 / 658,008');
  });
});

describe('formatCounts', () => {
  it('collapses runs of neighbouring counts', () => {
    expect(formatCounts([3])).toBe('3');
    expect(formatCounts([2, 3])).toBe('2–3');
    expect(formatCounts([0, 2, 3, 4, 7])).toBe('0, 2–4, 7');
    expect(formatCounts([])).toBe('-');
  });
});

describe('formatOptimizeProgress', () => {
  it('is one plain line: done of total, percent, elapsed, ETA', () => {
    expect(formatOptimizeProgress({ done: 64, total: 128, elapsedMs: 1234, etaMs: 1234 })).toBe(
      'optimize: 64 / 128 vectors (50.0%), elapsed 1.2s, ETA 1.2s\n',
    );
  });

  it('shows a total past 2^53 as what it is, rounded only for the eye', () => {
    expect(
      formatOptimizeProgress({
        done: 1_000_000,
        total: '48000000000000000000',
        elapsedMs: 100,
        etaMs: 4.8e15,
      }),
    ).toBe(
      'optimize: 1,000,000 / about 4.80 × 10^19 vectors (0.0%), elapsed 0.1s, ETA 4800000000000.0s\n',
    );
  });
});

describe('formatNeedsConfirmation', () => {
  it('says nothing was scored, how long it would take, and how to go ahead', () => {
    expect(formatNeedsConfirmation(48_000_000_000, 2e9, 'too long')).toBe(
      'optimize: nothing was scored — too long\n  48,000,000,000 class vectors, about 23 days; re-run with --force to go ahead\n',
    );
  });
});

describe('searchSection', () => {
  it('marks a cancelled run as holding for the vectors scored only', () => {
    let asked = 0;
    const partial = outputs(0, {
      checkEvery: 1,
      progressIntervalMs: 0,
      shouldCancel: () => ++asked === 5,
    });
    expect(searchSection(partial, true)).toMatch(
      /^ {2}class vectors {2}5 of 16 scored in .* — CANCELLED: everything below holds for these only$/m,
    );
    expect(searchSection(outputs(0), false)).not.toMatch(/CANCELLED/);
  });
});

describe('plateauSection', () => {
  it('says when only the best of the plateau are kept, and that the raw ratios are then a lower bound', () => {
    const run = outputs(0, { plateauDelta: { num: 1, den: 1 }, plateauCap: 3 });
    expect(plateauSection(run).split('\n').slice(0, 3)).toEqual([
      'Plateau — within 100 percentage point(s) of the best',
      '  16 class vector(s) / at least 9 raw ratio(s)',
      '  only the best 3 are kept: the ranges below are theirs',
    ]);
  });
});

describe('irrelevantSection', () => {
  it('gives a line that crowds out cards that matter its table after all', () => {
    // A remainder of at least 33: the best deck has 34 blank cards, so a second `junk` is a 35th.
    const crowded = irrelevantSection(outputs(33));
    expect(crowded).toMatch(
      /^ {2}junk: no loss at 0–1; beyond, its cards crowd out ones that matter$/m,
    );
    // 3 `a` and 2 `b`: (C(40,5) − C(37,5) − C(38,5) + C(35,5)) / C(40,5) = 44,801 / 658,008.
    expect(crowded).toMatch(/^ {6}0–1: 9\.7978% \* {3}2: 6\.8086%$/m);
  });

  it('says so when there is none', () => {
    const run = { ...outputs(0), irrelevant: [] };
    expect(irrelevantSection(run)).toMatch(/\(none\)$/);
  });
});

describe('sweepsSection', () => {
  it('says so when no line matters', () => {
    expect(sweepsSection({ ...outputs(0), sweeps: [] })).toMatch(/\(no line matters\)$/);
  });
});
