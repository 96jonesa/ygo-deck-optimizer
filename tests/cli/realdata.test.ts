import { describe, expect, it } from 'vitest';
import { EXIT_OK, runEstimate } from '../../src/cli/estimate';
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
        .find((line) => line.startsWith('  requirement ') && line.includes(`  ${description}  `));
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
