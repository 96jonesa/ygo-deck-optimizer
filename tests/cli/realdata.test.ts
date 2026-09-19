import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_OK, runEstimate } from '../../src/cli/estimate';
import { runOptimize } from '../../src/cli/optimize';
import { captureIo } from '../helpers/cli-io';
import { MOTIVATING_PATH, motivatingExact } from '../helpers/motivating';

// The M0 exit criterion (TDD §18): `estimate` over the motivating example
// against a REAL install. Opt-in like the other real-data tests; skipped in CI.
//   EDOPRO_WORKDIR=/path/to/ProjectIgnis npm test
const EDOPRO_WORKDIR = process.env.EDOPRO_WORKDIR;

describe.skipIf(!EDOPRO_WORKDIR)('M0 exit: the motivating example against a real install', () => {
  const SAMPLES = 200_000;
  const SEED = 20260918;
  // Every line at its max: A, B, monster, level 4 monster, the Level 8 line, spell, normal spell.
  const COUNTS = [3, 3, 5, 3, 3, 7, 3];

  it('estimates P(success) within five standard errors of the exact value', async () => {
    const captured = captureIo({ EDOPRO_WORKDIR });
    const code = await runEstimate(
      [MOTIVATING_PATH, '--samples', String(SAMPLES), '--seed', String(SEED)],
      captured.io,
    );
    const stdout = captured.stdout();
    expect(captured.stderr()).not.toMatch(/error/);
    expect(code).toBe(EXIT_OK);

    // The real Stratos is a Level 4 monster and the real Reinforcement of the
    // Army a Normal Spell — which the exact route below assumes — and the match
    // report must show it: A fills `monster`, B fills nothing but itself.
    const filledBy = (description: string): string[] => {
      const row = stdout
        .split('\n')
        .find(
          (line) =>
            line.startsWith('  requirement ') &&
            new RegExp(
              `\\s\\d+(?:-\\d+)?x ${description.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s\\s`,
            ).test(line),
        );
      const lines = /filled by: (.*)$/.exec(row ?? '')?.[1];
      if (lines === undefined) throw new Error(`no match row for ${description} in:\n${stdout}`);
      return lines.split(', ');
    };
    expect(filledBy('monster')).toEqual(['A', 'monster', 'level4', 'fire-bw']);
    // The line `monster` does not say its cards are Level 4 or lower, so it does not fill this.
    expect(filledBy('level 4 or lower monster')).toEqual(['A', 'level4']);
    expect(filledBy('level 4 or lower monster')).not.toContain('monster');
    expect(filledBy('#32807846')).toEqual(['B']);
    expect(stdout).toMatch(/match nothing, .*: spell, normal-spell, \(remainder\)$/m);

    // The exact value, by a route that shares no code with src/: hand
    // compositions over five kinds of card, multivariate hypergeometric weights.
    const exact = motivatingExact(COUNTS, 40, 5);
    expect(exact.hands).toBe(658008);

    const hits = Number(/^ {2}([0-9,]+) hits;/m.exec(stdout)?.[1]?.replaceAll(',', ''));
    const reported =
      /^P\(success\) = (0\.\d+) {2}\(95% CI (0\.\d+)–(0\.\d+), 200,000 samples, seed 20260918\)$/m.exec(
        stdout,
      );
    expect(reported).not.toBeNull();
    const sigma = Math.sqrt((exact.p * (1 - exact.p)) / SAMPLES);
    expect(Math.abs(hits / SAMPLES - exact.p)).toBeLessThanOrEqual(5 * sigma);
    expect(Number(reported![1])).toBeCloseTo(hits / SAMPLES, 4);

    // Reported by the test run, so the numbers can be read off the log.
    console.info(
      `M0 exit: P = ${reported![1]} (95% CI ${reported![2]}–${reported![3]}), ${hits} hits of ${SAMPLES}; ` +
        `exact = ${exact.successes}/${exact.hands} = ${exact.p.toFixed(6)}; ` +
        `off by ${((hits / SAMPLES - exact.p) / sigma).toFixed(2)} standard errors`,
    );
  });
});

// The M1 exit criterion (TDD §18): `optimize` over the motivating example — and over the
// brick example, the question the tool was asked for — against a REAL install.
describe.skipIf(!EDOPRO_WORKDIR)('M1 exit: optimize against a real install (oracle O4)', () => {
  async function optimizeJson(template: string, ...flags: string[]) {
    const captured = captureIo({ EDOPRO_WORKDIR });
    const code = await runOptimize([template, '--json', ...flags], captured.io);
    expect(captured.stderr()).not.toMatch(/error/);
    expect(code).toBe(EXIT_OK);
    return JSON.parse(captured.stdout());
  }

  it("finds the motivating example's optimum, sweeps and irrelevant lines as brute force does", async () => {
    const { result } = await optimizeJson(MOTIVATING_PATH);
    expect(result).toMatchObject({ status: 'done', done: 128, total: 128, rawRatios: 4096 });

    // By a route that shares nothing with src/: every choice of the four counts that matter.
    const rows: { counts: number[]; successes: number }[] = [];
    for (let a = 0; a <= 3; a++)
      for (let b = 0; b <= 3; b++)
        for (let level4 = 2; level4 <= 3; level4++)
          for (let fireBw = 0; fireBw <= 3; fireBw++) {
            const counts = [a, b, 5, level4, fireBw, 0, 0];
            rows.push({ counts, successes: motivatingExact(counts, 40, 5).successes });
          }
    const best = Math.max(...rows.map((row) => row.successes));
    expect(best).toBe(46185);
    expect(result.best.blend).toEqual({ num: best, den: 658008 });
    // Classes: blank, A, B, {monster, fire-bw}, level4.
    expect(result.best.classTotals).toEqual([23, 3, 3, 8, 3]);

    for (const [lineId, at] of [
      ['A', 0],
      ['B', 1],
    ] as const) {
      const sweep = result.sweeps.find((s: { lineId: string }) => s.lineId === lineId);
      expect(
        sweep.cells.map((cell: { best: { blend: { num: number } } }) => cell.best.blend.num),
      ).toEqual(
        [0, 1, 2, 3].map((count) =>
          Math.max(...rows.filter((row) => row.counts[at] === count).map((row) => row.successes)),
        ),
      );
      expect(sweep.argmax).toEqual([3]);
    }
    expect(
      result.irrelevant.map((line: { lineId: string; flat: boolean }) => [line.lineId, line.flat]),
    ).toEqual([
      ['spell', true],
      ['normal-spell', true],
      ['remainder', false],
    ]);
  });

  it('answers the brick example: the odds fall with every further copy of the brick', async () => {
    const brick = path.resolve(import.meta.dirname, '../../examples/brick.json');
    const { result, sweepFixed } = await optimizeJson(brick, '--sweep', 'brick');
    expect(result).toMatchObject({ status: 'done', done: 7200, total: 7200 });
    const sweep = result.sweeps.find((s: { lineId: string }) => s.lineId === 'brick');
    const nums = sweep.cells.map(
      (cell: { best: { blend: { num: number } } }) => cell.best.blend.num,
    );
    expect(sweep.cells.map((cell: { count: number }) => cell.count)).toEqual([1, 2, 3]);
    expect(nums[0]).toBeGreaterThan(nums[1]);
    expect(nums[1]).toBeGreaterThan(nums[2]);
    expect(sweep.argmax).toEqual([1]);
    expect(sweepFixed.map((cell: { feasible: boolean }) => cell.feasible)).toEqual([
      true,
      true,
      true,
    ]);
  });
});
