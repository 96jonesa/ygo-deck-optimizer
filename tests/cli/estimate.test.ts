import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  formatProgress,
  parseEstimateArgs,
  runEstimate,
} from '../../src/cli/estimate';
import { captureIo } from '../helpers/cli-io';
import { STRINGS_CONF } from '../helpers/desc-context';
import { MOTIVATING_PATH, motivatingCdb, motivatingExact } from '../helpers/motivating';

const SQL = await initSqlJs();
const scratch = mkdtempSync(path.join(tmpdir(), 'ygo-cli-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function write(relative: string, contents: string | Uint8Array): string {
  const file = path.join(scratch, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

/** An EDOPro-shaped directory: the fixture database with the motivating example's stand-ins. */
const WORKDIR = path.join(scratch, 'install');
write('install/expansions/cards.cdb', motivatingCdb(SQL));
write('install/config/strings.conf', STRINGS_CONF);

const BARE_WORKDIR = path.join(scratch, 'bare');
write('bare/expansions/cards.cdb', motivatingCdb(SQL));

const MOTIVATING = JSON.parse(readFileSync(MOTIVATING_PATH, 'utf8'));

function templateFile(name: string, json: unknown): string {
  return write(`templates/${name}.json`, JSON.stringify(json));
}

async function run(argv: string[], env: Record<string, string | undefined> = {}) {
  const captured = captureIo(env);
  const code = await runEstimate(argv, captured.io);
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

/** The `hits` and `samples` the report states, exactly. */
function hitsOf(stdout: string): { hits: number; samples: number } {
  const samples = /, ([0-9,]+) samples, seed/.exec(stdout)?.[1];
  const hits = /^ {2}([0-9,]+) hits;/m.exec(stdout)?.[1];
  if (samples === undefined || hits === undefined) throw new Error(`no result in:\n${stdout}`);
  return { hits: Number(hits.replaceAll(',', '')), samples: Number(samples.replaceAll(',', '')) };
}

describe('parseEstimateArgs', () => {
  const env = { EDOPRO_WORKDIR: '/from/env' };

  it('reads the template and falls back on the defaults', () => {
    expect(parseEstimateArgs(['t.json'], env)).toEqual({
      ok: true,
      args: { template: 't.json', workdir: '/from/env', samples: 200000, seed: 1, ratio: 'max' },
    });
  });

  it('reads every option, in either spelling and any order', () => {
    expect(
      parseEstimateArgs(
        [
          '--samples',
          '5000',
          '--seed=42',
          't.json',
          '--hand',
          '6',
          '--workdir=/w',
          '--ratio',
          '3,3, 5',
        ],
        env,
      ),
    ).toEqual({
      ok: true,
      args: {
        template: 't.json',
        workdir: '/w',
        samples: 5000,
        seed: 42,
        hand: 6,
        ratio: [3, 3, 5],
      },
    });
    expect(parseEstimateArgs(['t.json', '--at', 'min'], env)).toMatchObject({
      args: { ratio: 'min' },
    });
  });

  it('prefers --workdir to $EDOPRO_WORKDIR, and wants one of them', () => {
    expect(parseEstimateArgs(['t.json', '--workdir', '/flag'], env)).toMatchObject({
      args: { workdir: '/flag' },
    });
    expect(parseEstimateArgs(['t.json'], {})).toEqual({
      ok: false,
      message: 'no EDOPro install: pass --workdir <dir> or set EDOPRO_WORKDIR',
    });
  });

  it('answers --help before anything else', () => {
    expect(parseEstimateArgs(['--bogus', '--help'], {})).toEqual({ ok: true, help: true });
    expect(parseEstimateArgs(['--help'], {})).toEqual({ ok: true, help: true });
    expect(parseEstimateArgs(['t.json', '-h'], {})).toEqual({ ok: true, help: true });
  });

  it.each([
    [[], /which template/],
    [['a.json', 'b.json'], /one template at a time/],
    [['t.json', '--frobnicate'], /unknown option --frobnicate/],
    [['t.json', '--samples'], /--samples needs a value/],
    [['t.json', '--samples', '0'], /--samples must be a positive whole number, not 0/],
    [['t.json', '--samples', '1e6'], /--samples must be a positive whole number, not 1e6/],
    [['t.json', '--seed', '-1'], /--seed must be a whole number below 2\^32, not -1/],
    [['t.json', '--seed', '4294967296'], /--seed must be a whole number below 2\^32/],
    [['t.json', '--seed', '1', '--seed', '2'], /--seed is given twice/],
    [['t.json', '--hand', '7'], /--hand must be 5 or 6, not 7/],
    [['t.json', '--at', 'mid'], /--at must be max or min, not mid/],
    [['t.json', '--ratio', '3,x'], /--ratio must be whole numbers separated by commas/],
    [['t.json', '--ratio', '3,-1'], /--ratio must be whole numbers separated by commas/],
    [['t.json', '--ratio', '1', '--at', 'max'], /--ratio and --at/],
  ] as [string[], RegExp][])('rejects %j', (argv, message) => {
    const parsed = parseEstimateArgs(argv, env);
    expect(parsed.ok).toBe(false);
    expect(parsed).toMatchObject({ message: expect.stringMatching(message) });
  });
});

describe('formatProgress', () => {
  it('is one plain line: done / total, percent, elapsed, ETA', () => {
    expect(formatProgress({ done: 412000, total: 1000000, elapsedMs: 1540, etaMs: 2198 })).toBe(
      'estimate: 412,000 / 1,000,000 samples (41.2%), elapsed 1.5s, ETA 2.2s\n',
    );
  });

  it('never uses a carriage return: it must read well in a log file', () => {
    expect(formatProgress({ done: 1, total: 2, elapsedMs: 0, etaMs: 0 })).not.toContain('\r');
  });
});

describe('runEstimate', () => {
  describe('usage errors (exit 2)', () => {
    it('explains itself on stderr, with the usage, and writes nothing to stdout', async () => {
      const { code, stdout, stderr } = await run([]);
      expect(code).toBe(EXIT_USAGE);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/^error: which template\?/);
      expect(stderr).toMatch(/usage: npm run cli -- estimate/);
    });

    it('wants a workdir from the flag or the environment', async () => {
      const { code, stderr } = await run([MOTIVATING_PATH]);
      expect(code).toBe(EXIT_USAGE);
      expect(stderr).toMatch(/pass --workdir <dir> or set EDOPRO_WORKDIR/);
    });

    it('rejects a ratio of the wrong length, naming the lines', async () => {
      const { code, stderr } = await run([MOTIVATING_PATH, '--workdir', WORKDIR, '--ratio', '3,3']);
      expect(code).toBe(EXIT_USAGE);
      expect(stderr).toMatch(/--ratio has 2 counts, but the template has 7 lines \(A, B, monster,/);
    });

    it("rejects a count outside its line's range", async () => {
      const { code, stderr } = await run([
        MOTIVATING_PATH,
        '--workdir',
        WORKDIR,
        '--ratio',
        '3,3,4,3,3,7,3',
      ]);
      expect(code).toBe(EXIT_USAGE);
      expect(stderr).toMatch(/line "monster" 4 copies, outside its range 5-5/);
    });

    it('rejects a ratio that overfills the deck', async () => {
      const big = templateFile('big', {
        ...MOTIVATING,
        lines: [...MOTIVATING.lines, { id: 'traps', text: 'trap', min: 0, max: 20 }],
      });
      const { code, stderr } = await run([big, '--workdir', WORKDIR]);
      expect(code).toBe(EXIT_USAGE);
      expect(stderr).toMatch(/every line at its max is 47 cards, more than the deck of 40/);
    });

    it("rejects a ratio that breaks the remainder's range", async () => {
      const tight = templateFile('tight', { ...MOTIVATING, remainder: { min: 0, max: 10 } });
      const { code, stderr } = await run([tight, '--workdir', WORKDIR]);
      expect(code).toBe(EXIT_USAGE);
      expect(stderr).toMatch(/leaves 13 unspecified cards, outside the remainder's range 0-10/);
    });
  });

  describe('template and load errors (exit 1)', () => {
    it('reports a template that is not there, or not JSON', async () => {
      const missing = await run([path.join(scratch, 'nope.json'), '--workdir', WORKDIR]);
      expect(missing.code).toBe(EXIT_FAILED);
      expect(missing.stderr).toMatch(/^error: cannot read .*nope\.json/);

      const broken = await run([
        write('templates/broken.json', '{ "version": 1,'),
        '--workdir',
        WORKDIR,
      ]);
      expect(broken.code).toBe(EXIT_FAILED);
      expect(broken.stderr).toMatch(/^error: cannot read .*broken\.json/);
    });

    it('reports every structural problem, one per line', async () => {
      const bad = templateFile('structure', {
        ...MOTIVATING,
        deckSize: 30,
        lines: [{ id: 'l1', text: 'monster', min: 4, max: 2 }],
      });
      const { code, stdout, stderr } = await run([bad, '--workdir', WORKDIR]);
      expect(code).toBe(EXIT_FAILED);
      expect(stdout).toBe('');
      expect(stderr.trimEnd().split('\n')).toEqual([
        expect.stringMatching(
          /^error: .*structure\.json: `deckSize` is 30; a Main Deck holds 40 to 60$/,
        ),
        expect.stringMatching(/^error: .*lines\[0\] \("l1"\): `min` 4 is greater than `max` 2$/),
      ]);
    });

    it('names the line whose description does not parse', async () => {
      const bad = templateFile('typo', {
        ...MOTIVATING,
        lines: [...MOTIVATING.lines, { id: 'the-typo', text: 'level 4 monstr', min: 0, max: 3 }],
      });
      const { code, stderr } = await run([bad, '--workdir', WORKDIR]);
      expect(code).toBe(EXIT_FAILED);
      expect(stderr).toMatch(/^error: .*typo\.json: line "the-typo": /m);
      expect(stderr).not.toMatch(/P\(success\)/);
    });

    it("accepts the PRD's Level 7 FIRE Beast-Warrior line although no such card exists", async () => {
      const bad = templateFile('level7', {
        ...MOTIVATING,
        lines: MOTIVATING.lines.map((line: { id: string }) =>
          line.id === 'fire-bw' ? { ...line, text: 'level 7 FIRE beast-warrior monster' } : line,
        ),
      });
      const { code, stdout } = await run([bad, '--workdir', WORKDIR, '--samples', '2000']);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toMatch(/P\(success\) = /);
      expect(stdout).toMatch(/matches no card in the database today — allowed/);
    });

    it('names the criterion that does not parse', async () => {
      const bad = templateFile('criterion', {
        ...MOTIVATING,
        criteria: [{ id: 'oops', text: '1x monster and' }],
      });
      const { code, stderr } = await run([bad, '--workdir', WORKDIR]);
      expect(code).toBe(EXIT_FAILED);
      expect(stderr).toMatch(/criterion "oops": /);
    });

    it('reports a workdir that is not a directory, or holds no database', async () => {
      const nowhere = await run([MOTIVATING_PATH, '--workdir', path.join(scratch, 'nowhere')]);
      expect(nowhere.code).toBe(EXIT_FAILED);
      expect(nowhere.stderr).toMatch(/nowhere is not a directory/);

      mkdirSync(path.join(scratch, 'empty'), { recursive: true });
      const empty = await run([MOTIVATING_PATH, '--workdir', path.join(scratch, 'empty')]);
      expect(empty.code).toBe(EXIT_FAILED);
      expect(empty.stderr).toMatch(/no card database under .*empty/);
    });
  });

  describe('the motivating example against the fixture database', () => {
    const argv = [MOTIVATING_PATH, '--workdir', WORKDIR, '--samples', '200000', '--seed', '7'];

    it('exits 0 and prints the probability line', async () => {
      const { code, stdout } = await run(argv);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toMatch(
        /^P\(success\) = 0\.\d{4} {2}\(95% CI 0\.\d{4}–0\.\d{4}, 200,000 samples, seed 7\)$/m,
      );
    });

    it('sends progress to stderr — one line per report, ending at 100% — and none of it to stdout', async () => {
      const { stdout, stderr } = await run(argv);
      const lines = stderr.trimEnd().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const line of lines)
        expect(line).toMatch(
          /^estimate: [0-9,]+ \/ 200,000 samples \(\d+\.\d%\), elapsed [0-9.]+s, ETA [0-9.]+s$/,
        );
      expect(lines.at(-1)).toMatch(/^estimate: 200,000 \/ 200,000 samples \(100\.0%\)/);
      expect(stdout).not.toMatch(/^estimate:/m);
      expect(stdout).not.toContain('\r');
      expect(stderr).not.toContain('\r');
    });

    it('reports the database, and the setnames it found', async () => {
      const { stdout } = await run(argv);
      expect(stdout).toContain(`Card database — ${WORKDIR}`);
      expect(stdout).toMatch(/databases +1 loaded, 0 skipped/);
      expect(stdout).toMatch(/cards +22$/m);
      expect(stdout).toMatch(/replacedRows +0 /);
      expect(stdout).toMatch(/conflicts +0 /);
      expect(stdout).toMatch(/setnames +11 archetype names from 1 strings\.conf file/);
    });

    it('says so when the install has no strings.conf', async () => {
      const { code, stdout } = await run([
        ...argv.slice(0, 1),
        '--workdir',
        BARE_WORKDIR,
        '--samples',
        '1000',
      ]);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toMatch(/setnames +none — no strings\.conf found/);
    });

    it('lists each line with its echo, database matches, range and chosen count, then the remainder', async () => {
      const { stdout } = await run(argv);
      expect(stdout).toMatch(
        /^ {2}A +\[Elemental HERO Stratos\] +Elemental HERO Stratos +1 +0-3 +3$/m,
      );
      expect(stdout).toMatch(/^ {2}level4 +level 4 monster +Level 4 · Monster +\d+ +2-3 +3$/m);
      expect(stdout).toMatch(/^ {2}\(remainder\) +card +Any card +22 +0\+ +13$/m);
    });

    it('shows each criterion expanded, and which lines fill each description', async () => {
      const { stdout } = await run(argv);
      expect(stdout).toMatch(/^ {2}c1 \(A, B and any monster\): 1x \[Elemental HERO Stratos\]/m);
      expect(stdout).toMatch(/^ {6}1\. 1x #40044918, 1x #32807846, 1x level 4 or lower monster$/m);
      expect(stdout).toMatch(/judged as 2 distinct flat alternative/);
      expect(stdout).toMatch(
        /^ {2}requirement +1x monster +\[Monster\] +filled by: A, monster, level4, fire-bw$/m,
      );
      // The point of the whole exercise: `monster` is not specific enough.
      expect(stdout).toMatch(
        /^ {2}requirement +1x level 4 or lower monster +\[.*\] +filled by: A, level4$/m,
      );
      expect(stdout).toMatch(
        /match nothing, so they cannot affect the odds: spell, normal-spell, \(remainder\)$/m,
      );
    });

    it('lands within five standard errors of the exact value, at the default ratio and at --at min', async () => {
      for (const [extra, counts] of [
        [[], [3, 3, 5, 3, 3, 7, 3]],
        [
          ['--at', 'min'],
          [0, 0, 5, 2, 0, 0, 0],
        ],
        [
          ['--ratio', '3,2,5,2,1,0,0'],
          [3, 2, 5, 2, 1, 0, 0],
        ],
        [
          ['--ratio', '3,2,5,2,1,0,0', '--hand', '6'],
          [3, 2, 5, 2, 1, 0, 0],
        ],
      ] as [string[], number[]][]) {
        const { code, stdout } = await run([...argv, ...extra]);
        expect(code).toBe(EXIT_OK);
        const { hits, samples } = hitsOf(stdout);
        const exact = motivatingExact(counts, 40, extra.includes('--hand') ? 6 : 5).p;
        const sigma = Math.sqrt((exact * (1 - exact)) / samples);
        expect(Math.abs(hits / samples - exact)).toBeLessThanOrEqual(5 * sigma);
      }
    });

    it('gives the same report for the same seed, and another for another', async () => {
      const a = await run(argv);
      const b = await run(argv);
      expect(a.stdout).toBe(b.stdout);
      // Not "seed 8 differs from seed 7": those two really do tie, at 14,076 hits of
      // 200,000 (they part ways at other sample counts). Several seeds must not ALL agree.
      const others = await Promise.all(
        ['9', '10'].map((seed) => run([...argv.slice(0, -1), seed])),
      );
      const hits = [a, ...others].map((r) => hitsOf(r.stdout).hits);
      expect(new Set(hits).size).toBeGreaterThan(1);
    });

    it('takes the workdir from $EDOPRO_WORKDIR', async () => {
      const { code } = await run([MOTIVATING_PATH, '--samples', '1000'], {
        EDOPRO_WORKDIR: WORKDIR,
      });
      expect(code).toBe(EXIT_OK);
    });

    it('prints warnings in the report', async () => {
      const unfillable = templateFile('unfillable', {
        ...MOTIVATING,
        criteria: [...MOTIVATING.criteria, { id: 'c3', text: '1x trap' }],
      });
      const { code, stdout } = await run([unfillable, '--workdir', WORKDIR, '--samples', '1000']);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toMatch(/^Warnings\n {2}no line fills the requirement `trap`$/m);
      expect(stdout).toMatch(/requirement +1x trap +\[Trap\] +filled by: \(no line\)$/m);
    });
  });

  it('prints the usage to stdout for --help, and exits 0', async () => {
    const { code, stdout, stderr } = await run(['--help']);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/^usage: npm run cli -- estimate/);
    expect(stderr).toBe('');
  });
});
