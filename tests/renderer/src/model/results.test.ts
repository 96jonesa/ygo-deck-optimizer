import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  breakdownRows,
  cellRuns,
  droppedLimitRows,
  irrelevantRows,
  labelOf,
  limitsNote,
  lineLabels,
  plateauView,
  pointsText,
  shortLabel,
} from '../../../../src/renderer/src/model/results';
import type {
  Analysis,
  RunDroppedLimit,
  RunLimit,
  RunResult,
  SweepCell,
} from '../../../../src/shared/types';
import { motivatingResult } from '../../../helpers/motivating-run';

const SQL = await initSqlJs();
const RESULT = motivatingResult(SQL);

const DEN = 658_008;

/** A sweep cell at `count` worth `num / 658,008`; the witness deck is never read here. */
function cell(count: number, num: number): SweepCell {
  return {
    count,
    best: { classTotals: [], score: { parts: [], pDisplay: num / DEN }, blend: { num, den: DEN } },
  };
}

/** A limit as the RUN carries it: the brick example's own. */
function limitOf(over: Partial<RunLimit> = {}): RunLimit {
  return {
    text: '#89631139',
    counts: [1],
    blind: [{ label: 'Unspecified cards', min: 1, max: 22 }],
    blindRange: { min: 1, max: 22 },
    ...over,
  };
}

/** The motivating result with the run-pinned limit facts replaced. */
function withLimits(criterionLimits: RunLimit[], droppedLimits: RunDroppedLimit[] = []): RunResult {
  return { ...RESULT, criterionLimits, droppedLimits };
}

/** An analysis with just the parts the results panel reads off it. */
function analysisOf(over: Partial<Analysis> = {}): Analysis {
  return {
    remainder: { id: 'remainder' },
    criteria: [],
    limits: [],
    classes: { classes: [], alternatives: 1, irrelevant: [], droppedLimits: [] },
    ...over,
  } as unknown as Analysis;
}

describe('pointsText', () => {
  it('reads the plateau width the RUN used in the unit the user types it in', () => {
    expect(pointsText({ num: 1, den: 200 })).toBe('0.5');
    expect(pointsText({ num: 3, den: 1000 })).toBe('0.3');
    expect(pointsText({ num: 0, den: 1 })).toBe('0');
    expect(pointsText({ num: 1, den: 1 })).toBe('100');
  });
});

describe('plateauView', () => {
  it('reports the run’s own width, its exact size, and every line’s copies across it', () => {
    expect(plateauView(RESULT)).toEqual({
      points: '0.5',
      size: '3 class vectors · 96 raw ratios',
      truncated: null,
      lines: [
        { lineId: 'A', counts: '3' },
        { lineId: 'B', counts: '3' },
        { lineId: 'monster', counts: '5' },
        { lineId: 'level4', counts: '2–3' },
        { lineId: 'fire-bw', counts: '2–3' },
      ],
    });
  });

  it('leaves out the lines no criterion can see: their copies say nothing about the deck', () => {
    const shown = plateauView(RESULT).lines.map((row) => row.lineId);
    expect(shown).not.toContain('spell');
    expect(shown).not.toContain('remainder');
  });

  it('says so when only the best few vectors were kept, since the ranges are then theirs', () => {
    const plateau = { ...RESULT.plateau, truncated: true, size: 12_000 };
    const view = plateauView({ ...RESULT, plateau });
    expect(view.truncated).toBe('Only the best 3 were kept, so the copies below are theirs.');
    expect(view.size).toBe('12,000 class vectors · at least 96 raw ratios');
  });

  it('hedges a size that is itself only a lower bound', () => {
    const plateau = { ...RESULT.plateau, sizeExact: false, size: 8_388_608 };
    expect(plateauView({ ...RESULT, plateau }).size).toBe(
      'at least 8,388,608 class vectors · 96 raw ratios',
    );
  });

  it('shows a gap in a line’s plateau counts as a gap', () => {
    const lines = [{ lineId: 'A', counts: [0, 2, 3] }];
    const plateau = { ...RESULT.plateau, lines };
    expect(plateauView({ ...RESULT, plateau }).lines).toEqual([{ lineId: 'A', counts: '0, 2–3' }]);
  });
});

describe('breakdownRows', () => {
  it('gives each TEMPLATE criterion its own exact probability at the best ratio', () => {
    expect(breakdownRows(RESULT)).toEqual([
      { id: 'c1', label: 'A, B and any monster', percent: '7.0189%', exact: '46,185 / 658,008' },
      {
        id: 'c2',
        label: 'A, B and a low-Level monster',
        percent: '2.9995%',
        exact: '19,737 / 658,008',
      },
    ]);
  });

  it('carries each row’s own name, whatever order the breakdown arrives in', () => {
    const breakdown = [...RESULT.breakdown].reverse();
    expect(breakdownRows({ ...RESULT, breakdown }).map((row) => row.label)).toEqual([
      'A, B and a low-Level monster',
      'A, B and any monster',
    ]);
    expect(breakdownRows({ ...RESULT, breakdown }).map((row) => row.id)).toEqual(['c2', 'c1']);
  });

  it('falls back to the id for a criterion the run had no name for', () => {
    const breakdown = RESULT.breakdown.map(({ blend, id, score }) => ({ id, score, blend }));
    expect(breakdownRows({ ...RESULT, breakdown }).map((row) => row.label)).toEqual(['c1', 'c2']);
  });
});

describe('cellRuns', () => {
  it('joins neighbouring counts of the SAME exact score into one entry', () => {
    expect(cellRuns([cell(1, 10), cell(2, 10), cell(3, 20)], 20)).toEqual([
      { counts: '1–2', percent: '0.0015%', exact: '10 / 658,008', best: false },
      { counts: '3', percent: '0.0030%', exact: '20 / 658,008', best: true },
    ]);
  });

  it('starts a new entry across a gap, even when the score is unchanged', () => {
    expect(cellRuns([cell(1, 10), cell(3, 10)], 10).map((run) => run.counts)).toEqual(['1', '3']);
  });

  it('marks every run that reaches the best, and only those', () => {
    expect(cellRuns([cell(0, 5), cell(1, 9), cell(2, 9)], 9).map((run) => run.best)).toEqual([
      false,
      true,
    ]);
  });
});

describe('irrelevantRows', () => {
  it('names a flat line as flat, with the counts it is free to take', () => {
    expect(irrelevantRows(RESULT).filter((row) => row.flat)).toEqual([
      { lineId: 'spell', flat: true, range: '0–7', free: null, cells: [] },
      { lineId: 'normal-spell', flat: true, range: '0–3', free: null, cells: [] },
    ]);
  });

  it('shows what a line that is NOT flat actually costs, count by count (M1c)', () => {
    const [row] = irrelevantRows(RESULT).filter((line) => !line.flat);
    expect(row?.lineId).toBe('remainder');
    expect(row?.free).toBe('13–23');
    expect(row?.cells.slice(0, 3)).toEqual([
      { counts: '13–23', percent: '7.0189%', exact: '46,185 / 658,008', best: true },
      { counts: '24', percent: '6.6410%', exact: '43,698 / 658,008', best: false },
      { counts: '25', percent: '6.2302%', exact: '40,995 / 658,008', best: false },
    ]);
    expect(row?.cells.at(-1)).toEqual({
      counts: '32–33',
      percent: '0.0000%',
      exact: '0 / 658,008',
      best: false,
    });
  });
});

describe('limitsNote', () => {
  it('says nothing when the run’s criteria carried no limit', () => {
    expect(limitsNote(RESULT)).toBeNull();
    expect(limitsNote(withLimits([]))).toBeNull();
  });

  it('states the reading the number is exact under (PRD §6.3)', () => {
    const note = limitsNote(withLimits([limitOf()]));
    expect(note?.reading).toContain('known to match');
    expect(note?.reading).toContain('exact under that reading');
  });

  it('names what each limit cannot see, so an overstated number is visible as one', () => {
    expect(limitsNote(withLimits([limitOf()]))?.blind).toEqual([
      { heading: 'at most 1x #89631139', range: '1–22', lines: ['Unspecified cards'] },
    ]);
  });

  it('writes a zero count as `no`, the way a criterion says it', () => {
    expect(limitsNote(withLimits([limitOf({ counts: [0] })]))?.blind[0]?.heading).toBe(
      'no #89631139',
    );
    expect(limitsNote(withLimits([limitOf({ counts: [0, 2] })]))?.blind[0]?.heading).toBe(
      'no / at most 2x #89631139',
    );
  });

  it('keeps the reading but claims no blind spot when every line is specific enough', () => {
    expect(limitsNote(withLimits([limitOf({ blind: [], blindRange: null })]))?.blind).toEqual([]);
  });

  it('is the RUN’s, so it cannot be changed by anything but a new run', () => {
    // There is no analysis to pass: the only input is the result itself.
    expect(limitsNote(withLimits([limitOf()]))).toEqual(limitsNote(withLimits([limitOf()])));
  });
});

describe('droppedLimitRows', () => {
  it('says which limits the engine left out, and why each holds of every hand', () => {
    const dropped: RunDroppedLimit[] = [
      { text: 'trap', n: 1, reason: 'counts-nothing' },
      { text: 'spell', n: 5, reason: 'never-binds' },
    ];
    expect(droppedLimitRows(withLimits([], dropped))).toEqual([
      {
        heading: 'at most 1x trap',
        why: 'no line counts against it, so it holds of every hand',
      },
      {
        heading: 'at most 5x spell',
        why: 'a hand cannot hold that many, so it holds of every hand',
      },
    ]);
  });

  it('says one dropped limit once, however many alternatives it appears in', () => {
    const dropped: RunDroppedLimit = { text: 'trap', n: 0, reason: 'counts-nothing' };
    expect(droppedLimitRows(withLimits([], [dropped, dropped]))).toEqual([
      { heading: 'no trap', why: 'no line counts against it, so it holds of every hand' },
    ]);
  });

  it('says nothing of a run that dropped none', () => {
    expect(droppedLimitRows(RESULT)).toEqual([]);
  });
});

describe('lineLabels', () => {
  it('is what the RUN called each line, so a chart can name what it is charting', () => {
    expect(lineLabels(RESULT).get('level4')).toBe('level 4 monster');
    expect(lineLabels(RESULT).get('A')).toBe('[Elemental HERO Stratos]');
    expect(lineLabels(RESULT).get('remainder')).toBe('Unspecified cards');
  });

  it('has one entry per line of the run', () => {
    expect([...lineLabels(RESULT).keys()]).toEqual(RESULT.lines.map((line) => line.id));
  });

  it('falls back to the id when the run carried no name, never to a blank', () => {
    const lines = RESULT.lines.map((line) => ({ ...line, label: line.id === 'A' ? '  ' : '' }));
    const labels = lineLabels({ ...RESULT, lines });
    expect(labels.get('A')).toBe('A');
    expect(labels.get('level4')).toBe('level4');
  });
});

describe('labelOf', () => {
  it('reads a label out of the map, and an unknown line keeps its id', () => {
    const labels = lineLabels(RESULT);
    expect(labelOf(labels, 'level4')).toBe('level 4 monster');
    expect(labelOf(labels, 'gone')).toBe('gone');
  });
});

describe('shortLabel', () => {
  it('leaves a label that fits exactly as it is', () => {
    expect(shortLabel('spell', 16)).toBe('spell');
    expect(shortLabel('level 4 monster', 16)).toBe('level 4 monster');
  });

  it('cuts a long one at a word boundary where there is one, with an ellipsis', () => {
    expect(shortLabel('Blue-Eyes White Dragon', 16)).toBe('Blue-Eyes White…');
  });

  it('cuts mid-word rather than overflowing when there is no boundary to use', () => {
    expect(shortLabel('Supercalifragilistic', 10)).toBe('Supercali…');
  });

  it('never grows what it was given', () => {
    for (const label of ['', 'a', 'level 7 FIRE beast-warrior monster', 'x'.repeat(200)])
      expect(shortLabel(label, 16).length).toBeLessThanOrEqual(16);
  });
});

describe('the results of a whole run', () => {
  it('reads nothing off a partial run that it would not read off a whole one', () => {
    // A cancelled run's outputs hold for the vectors it got to (TDD §11.3);
    // every reader below takes them as they are and marks nothing but `partial`.
    const partial: RunResult = { ...RESULT, status: 'cancelled', partial: true, done: 37 };
    expect(plateauView(partial)).toEqual(plateauView(RESULT));
    expect(breakdownRows(partial)).toEqual(breakdownRows(RESULT));
    expect(irrelevantRows(partial)).toEqual(irrelevantRows(RESULT));
  });
});
