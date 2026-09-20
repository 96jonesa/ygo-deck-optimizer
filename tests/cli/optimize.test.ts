import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_NEEDS_CONFIRMATION, EXIT_OK, EXIT_USAGE } from '../../src/cli/common';
import { blendArg, deltaArg, parseOptimizeArgs, runOptimize } from '../../src/cli/optimize';
import { captureIo } from '../helpers/cli-io';
import { STRINGS_CONF } from '../helpers/desc-context';
import { MOTIVATING_PATH, motivatingCdb, motivatingExact } from '../helpers/motivating';

const SQL = await initSqlJs();
const scratch = mkdtempSync(path.join(tmpdir(), 'ygo-cli-optimize-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function write(relative: string, contents: string | Uint8Array): string {
  const file = path.join(scratch, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

const WORKDIR = path.join(scratch, 'install');
write('install/expansions/cards.cdb', motivatingCdb(SQL));
write('install/config/strings.conf', STRINGS_CONF);
const MOTIVATING = JSON.parse(readFileSync(MOTIVATING_PATH, 'utf8'));

async function run(argv: string[], env: Record<string, string | undefined> = {}) {
  const captured = captureIo(env);
  const code = await runOptimize(argv, captured.io);
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

/** The lines of the section whose title starts with `title`, without the title. */
function section(stdout: string, title: string): string[] {
  const block = stdout.split('\n\n').find((part) => part.startsWith(title));
  if (block === undefined) throw new Error(`no section ${title} in:\n${stdout}`);
  return block.trimEnd().split('\n').slice(1);
}

describe('deltaArg', () => {
  it('reads percentage points as an exact fraction in lowest terms', () => {
    expect(deltaArg('0.5')).toEqual({ ok: true, value: { num: 1, den: 200 } });
    expect(deltaArg('1')).toEqual({ ok: true, value: { num: 1, den: 100 } });
    expect(deltaArg('0')).toEqual({ ok: true, value: { num: 0, den: 1 } });
    expect(deltaArg('0.125')).toEqual({ ok: true, value: { num: 1, den: 800 } });
    expect(deltaArg('2.50')).toEqual({ ok: true, value: { num: 1, den: 40 } });
  });

  it('rejects anything else', () => {
    for (const text of ['', '-1', '.5', '1e-3', 'half', '0.1234567'])
      expect(deltaArg(text)).toMatchObject({
        ok: false,
        message: expect.stringMatching(/--delta/),
      });
  });
});

describe('blendArg', () => {
  it('reads first : second weights, in lowest terms', () => {
    expect(blendArg('3:2')).toEqual({ ok: true, value: [3, 2] });
    expect(blendArg('60:40')).toEqual({ ok: true, value: [3, 2] });
    expect(blendArg('1:1')).toEqual({ ok: true, value: [1, 1] });
  });

  it('rejects a weight of 0, and anything that is not two whole numbers', () => {
    for (const text of ['3', '3:0', '0:2', '0.6:0.4', '3:2:1', 'a:b'])
      expect(blendArg(text)).toMatchObject({
        ok: false,
        message: expect.stringMatching(/--blend/),
      });
  });
});

describe('parseOptimizeArgs', () => {
  it('reads the template and falls back on the defaults', () => {
    expect(parseOptimizeArgs(['t.json'], { EDOPRO_WORKDIR: '/w' })).toEqual({
      ok: true,
      value: {
        template: 't.json',
        workdir: '/w',
        top: 20,
        delta: { num: 1, den: 200 },
        thresholdMs: 60_000,
        force: false,
        json: false,
      },
    });
  });

  it('reads every option, in either spelling and any order', () => {
    expect(
      parseOptimizeArgs(
        [
          '--force',
          '--top=8',
          't.json',
          '--delta',
          '1.5',
          '--sweep',
          'brick',
          '--blend=3:2',
          '--threshold',
          '5',
          '--json',
          '--workdir',
          '/w',
        ],
        {},
      ),
    ).toEqual({
      ok: true,
      value: {
        template: 't.json',
        workdir: '/w',
        top: 8,
        delta: { num: 3, den: 200 },
        sweep: 'brick',
        blend: [3, 2],
        // `--blend` is the average with weights of its own, so it settles the
        // mode as well: the three flags are three ways of naming one run.
        mode: 'average',
        thresholdMs: 5000,
        force: true,
        json: true,
      },
    });
    expect(parseOptimizeArgs(['t.json', '--hand', '6'], { EDOPRO_WORKDIR: '/w' })).toMatchObject({
      value: { mode: 'second' },
    });
    expect(parseOptimizeArgs(['t.json', '--hand', '5'], { EDOPRO_WORKDIR: '/w' })).toMatchObject({
      value: { mode: 'first' },
    });
    expect(
      parseOptimizeArgs(['t.json', '--mode', 'average'], { EDOPRO_WORKDIR: '/w' }),
    ).toMatchObject({ value: { mode: 'average' } });
    // Nothing said: no override, so the template's own mode stands.
    const bare = parseOptimizeArgs(['t.json'], { EDOPRO_WORKDIR: '/w' });
    expect(
      bare.ok && 'help' in bare ? undefined : bare.ok ? bare.value.mode : null,
    ).toBeUndefined();
  });

  it('answers --help before anything else', () => {
    expect(parseOptimizeArgs(['--nonsense', '--help'], {})).toEqual({ ok: true, help: true });
  });

  it('rejects a bad command line with a message', () => {
    const message = (argv: string[]) => {
      const parsed = parseOptimizeArgs(argv, { EDOPRO_WORKDIR: '/w' });
      return parsed.ok ? undefined : parsed.message;
    };
    expect(message([])).toMatch(/which template\?/);
    expect(message(['a.json', '--top', '0'])).toMatch(/--top must be a positive whole number/);
    expect(message(['a.json', '--delta', 'wide'])).toMatch(/--delta is percentage points/);
    expect(message(['a.json', '--blend', '3'])).toMatch(/--blend is two positive whole weights/);
    expect(message(['a.json', '--threshold', '1.5'])).toMatch(/--threshold must be a whole number/);
    expect(message(['a.json', '--hand', '7'])).toBe('--hand must be 5 or 6, not 7');
    expect(message(['a.json', '--mode', 'both'])).toBe(
      '--mode must be first, second, average, not both',
    );
    expect(message(['a.json', '--hand', '5', '--blend', '1:1'])).toBe(
      '--hand and --blend each say which run this is; give one',
    );
    expect(message(['a.json', '--mode', 'first', '--hand', '5'])).toBe(
      '--mode and --hand each say which run this is; give one',
    );
    expect(message(['a.json', '--samples', '5'])).toBe('unknown option --samples');
    expect(parseOptimizeArgs(['a.json'], {})).toMatchObject({ ok: false });
  });
});

describe('runOptimize', () => {
  it('explains a usage error on stderr, with the usage, and exits 2', async () => {
    const { code, stdout, stderr } = await run(['--workdir', WORKDIR]);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^error: which template\?.*\n\nusage: npm run cli -- optimize/);
  });

  it('prints the usage to stdout for --help, and exits 0', async () => {
    const { code, stdout, stderr } = await run(['--help']);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/^usage: npm run cli -- optimize/);
    expect(stderr).toBe('');
  });

  it('reports a template it cannot read, or a workdir it cannot load, and exits 1', async () => {
    const missing = await run([path.join(scratch, 'nope.json'), '--workdir', WORKDIR]);
    expect(missing.code).toBe(EXIT_FAILED);
    expect(missing.stderr).toMatch(/^error: cannot read /);
    const nowhere = await run([MOTIVATING_PATH, '--workdir', path.join(scratch, 'nowhere')]);
    expect(nowhere.code).toBe(EXIT_FAILED);
    expect(nowhere.stderr).toMatch(/is not a directory/);
  });

  it('prints the analysis of a template with errors, scores nothing, and exits 1', async () => {
    const broken = write(
      'broken.json',
      JSON.stringify({
        ...MOTIVATING,
        lines: [...MOTIVATING.lines, { id: 'typo', text: 'monstr', min: 0, max: 3 }],
      }),
    );
    const { code, stdout, stderr } = await run([broken, '--workdir', WORKDIR]);
    expect(code).toBe(EXIT_FAILED);
    // A word the parser does not know — an error whether or not any card would match the line.
    expect(stdout).toMatch(/^Errors\n {2}line "typo": .*unknown word "monstr"/m);
    expect(stdout).not.toMatch(/Best ratio/);
    expect(stderr).toMatch(/has errors; nothing was scored/);
  });

  describe('the motivating example', () => {
    it('reports the best ratio in lines, exactly, with progress on stderr', async () => {
      const { code, stdout, stderr } = await run([
        MOTIVATING_PATH,
        '--workdir',
        WORKDIR,
        '--top',
        '8',
      ]);
      expect(code).toBe(EXIT_OK);
      expect(stderr).toMatch(
        /^optimize: 128 \/ 128 vectors \(100\.0%\), elapsed \d+\.\ds, ETA 0\.0s\n$/,
      );
      // The analysis comes first: what the numbers are numbers OF.
      expect(stdout).toMatch(/^Card database — /);
      expect(stdout).toMatch(/^Template — .*motivating\.json: deck of 40, hand of 5$/m);
      expect(stdout).toMatch(/^Classes — /m);
      expect(section(stdout, 'Search — ')[0]).toMatch(/128 of 128 scored in /);
      expect(stdout).toMatch(/^ {2}raw ratios {5}4,096 /m);

      expect(stdout).toMatch(/^Best ratio — P\(success\) = 46,185 \/ 658,008 = 7\.0189%$/m);
      const best = section(stdout, 'Best ratio — ').map((row) => row.trim().split(/ {2,}/));
      expect(best.slice(1, 9)).toEqual([
        ['A', '3'],
        ['B', '3'],
        ['monster', '5', '8 copies among monster, fire-bw — any split'],
        ['level4', '3'],
        ['fire-bw', '3'],
        ['spell', '0–7', '23 copies among spell, normal-spell, (remainder) — any split'],
        ['normal-spell', '0–3'],
        ['(remainder)', '13–23'],
      ]);
      expect(best[9]).toEqual(['32 raw ratio(s) are this deck as far as the criteria can tell']);
    });

    it('ranks the top N class vectors against an independent count of every hand', async () => {
      const { stdout } = await run([MOTIVATING_PATH, '--workdir', WORKDIR, '--top', '8']);
      const rows = section(stdout, 'Ranked — the top 8 of 128').map((r) => r.trim().split(/ {2,}/));
      expect(rows[0]).toEqual([
        '#',
        'P',
        'exact',
        'A',
        'B',
        'monster',
        'level4',
        'fire-bw',
        'blank',
        'raw ratios',
      ]);
      expect(rows).toHaveLength(9);
      for (const [, p, exact, a, b, monster, level4, fireBw, blank] of rows.slice(1)) {
        const counts = [a, b, monster, level4, fireBw].map(Number);
        const truth = motivatingExact([...counts, 0, 0], 40, 5);
        expect(exact).toBe(`${truth.successes.toLocaleString('en-US')} / 658,008`);
        expect(p).toBe(`${(100 * truth.p).toFixed(4)}%`);
        expect(Number(blank)).toBe(40 - counts.reduce((sum, n) => sum + n, 0));
      }
      // Rows 2 and 3 tie exactly; the smaller class vector — fewer `monster`/`fire-bw` — goes first.
      expect(rows[2]!.slice(1, 3)).toEqual(rows[3]!.slice(1, 3));
      expect([rows[2]![6], rows[2]![7], rows[3]![6], rows[3]![7]]).toEqual(['3', '2', '2', '3']);
    });

    it('summarizes the plateau, the irrelevant lines, every sweep, and each criterion', async () => {
      const { stdout } = await run([MOTIVATING_PATH, '--workdir', WORKDIR]);
      expect(section(stdout, 'Plateau — within 0.5 percentage point(s)')).toEqual([
        '  3 class vector(s) / 96 raw ratio(s)',
        '  line     copies across the plateau',
        '  A        3',
        '  B        3',
        '  monster  5',
        '  level4   2–3',
        '  fire-bw  2–3',
      ]);
      const idle = section(stdout, 'Irrelevant lines — ');
      expect(idle[0]).toBe('  every count ties for the best: spell (0–7), normal-spell (0–3)');
      expect(idle[1]).toMatch(/^ {2}\(remainder\): no loss at 13–23; beyond, /);
      // Eight entries to a row: the remainder takes 21 counts, 10 entries once ties are joined.
      expect(idle[2]).toMatch(/^ {6}13–23: 7\.0189% \* {3}24: 6\.6410% {3}.* {3}30: 1\.2289%$/);
      expect(idle[3]).toBe('      31: 0.5989%   32–33: 0.0000%');

      const sweeps = section(stdout, 'Sweeps — ');
      const expected = (at: number) =>
        [0, 1, 2, 3].map((count) => {
          // Everything else at its best, which for this template is its maximum.
          const counts = [3, 3, 5, 3, 3, 0, 0];
          counts[at] = count;
          return `${count}: ${(100 * motivatingExact(counts, 40, 5).p).toFixed(4)}%`;
        });
      expect(sweeps[0]).toBe(`  A        ${expected(0).join('   ')} *`);
      expect(sweeps[1]).toBe(`  B        ${expected(1).join('   ')} *`);
      expect(sweeps[2]).toBe('  monster  5: 7.0189% *');
      expect(sweeps.map((row) => row.trim().split(' ')[0])).toEqual([
        'A',
        'B',
        'monster',
        'level4',
        'fire-bw',
      ]);

      expect(section(stdout, 'Per criterion — ')).toEqual([
        '  c1 (A, B and any monster)          7.0189%  46,185 / 658,008',
        '  c2 (A, B and a low-Level monster)  2.9995%  19,737 / 658,008',
        '  any of them                        7.0189%  46,185 / 658,008',
      ]);
    });

    it('--delta widens the plateau', async () => {
      const { stdout } = await run([MOTIVATING_PATH, '--workdir', WORKDIR, '--delta', '2']);
      // By brute force: the class vectors within 2 points — 2% of 658,008 hands — of 46,185.
      let expected = 0;
      for (let a = 0; a <= 3; a++)
        for (let b = 0; b <= 3; b++)
          for (let level4 = 2; level4 <= 3; level4++)
            for (let fireBw = 0; fireBw <= 3; fireBw++) {
              const { successes } = motivatingExact([a, b, 5, level4, fireBw, 0, 0], 40, 5);
              if ((46185 - successes) * 100 <= 2 * 658008) expected++;
            }
      expect(expected).toBe(8);
      // 32 raw ratios behind each: the 23 to 27 blank cards split among spell, normal-spell, remainder.
      expect(section(stdout, 'Plateau — within 2 percentage point(s)')[0]).toBe(
        `  ${expected} class vector(s) / ${32 * expected} raw ratio(s)`,
      );
    });

    it('--sweep adds the line in detail: re-optimized, and with the others held fixed', async () => {
      const { code, stdout } = await run([MOTIVATING_PATH, '--workdir', WORKDIR, '--sweep', 'A']);
      expect(code).toBe(EXIT_OK);
      const rows = section(stdout, 'Sweep of `A` — ').map((row) => row.trim().split(/ {2,}/));
      expect(rows[0]).toEqual(['copies', 're-optimized', 'exact', 'held', 'the deck that does it']);
      expect(rows[2]).toEqual([
        '1',
        '2.3588%',
        '15,521 / 658,008',
        '2.3588%',
        'B 3, monster 5, level4 3, fire-bw 3',
      ]);
      expect(rows[4]!.slice(0, 2)).toEqual(['3 *', '7.0189%']);
    });

    it('--sweep of a line that cannot matter says so, and still holds the others fixed', async () => {
      const { stdout } = await run([MOTIVATING_PATH, '--workdir', WORKDIR, '--sweep', 'spell']);
      const rows = section(stdout, 'Sweep of `spell` — ');
      expect(rows[0]).toBe('  irrelevant: re-optimized, every count reaches the best');
      expect(rows.slice(1).map((row) => row.trim().split(/ {2,}/))).toEqual([
        ['copies', 'held'],
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((count) => [String(count), '7.0189%']),
      ]);
    });

    it('--sweep of a line the template does not have is a usage error', async () => {
      const { code, stdout, stderr } = await run([
        MOTIVATING_PATH,
        '--workdir',
        WORKDIR,
        '--sweep',
        'C',
      ]);
      expect(code).toBe(EXIT_USAGE);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/^error: --sweep names no line of the template: C \(it has A, B, /);
    });

    it('--blend resolves at a hand of 6 and ranks by both hands', async () => {
      const { code, stdout } = await run([MOTIVATING_PATH, '--workdir', WORKDIR, '--blend', '3:2']);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toMatch(/^Template — .*: deck of 40, hand of 6$/m);
      expect(stdout).toMatch(/^ {2}hands {10}5 cards × 3, 6 cards × 2$/m);
      const first = motivatingExact([3, 3, 5, 3, 3, 0, 0], 40, 5).p;
      const second = motivatingExact([3, 3, 5, 3, 3, 0, 0], 40, 6).p;
      const blended = `${(100 * (0.6 * first + 0.4 * second)).toFixed(4)}%`;
      expect(stdout).toMatch(
        new RegExp(
          `^Best ratio — P\\(success\\) = [0-9,]+ / [0-9,]+ = ${blended.replace('.', '\\.')}$`,
          'm',
        ),
      );
      // Each hand whole: the two denominators differ, so one fraction could
      // only ever be one of them.
      expect(stdout).toMatch(/^ {2}going first: 7\.0189% \([0-9,]+ \/ 658,008\)$/m);
      expect(stdout).toMatch(
        new RegExp(
          `^ {2}going second: ${(100 * second).toFixed(4).replace('.', '\\.')}% \\([0-9,]+ / 3,838,380\\)$`,
          'm',
        ),
      );
      expect(section(stdout, 'Ranked — ')[0]).toMatch(
        /exact +going first +5 exact +going second +6 exact +A /,
      );
    });

    it('--json prints the raw result and nothing else', async () => {
      const { code, stdout } = await run([
        MOTIVATING_PATH,
        '--workdir',
        WORKDIR,
        '--json',
        '--sweep',
        'B',
      ]);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(stdout);
      expect(parsed.result).toMatchObject({
        status: 'done',
        partial: false,
        done: 128,
        total: 128,
      });
      expect(parsed.result.best.blend).toEqual({ num: 46185, den: 658008 });
      expect(parsed.result.ranked).toHaveLength(128);
      expect(parsed.breakdown.map((row: { id: string }) => row.id)).toEqual(['c1', 'c2']);
      expect(parsed.sweepFixed).toHaveLength(4);
    });
  });

  describe('the exactly shorthand', () => {
    /** The motivating example with one criterion of its own. */
    function templateSaying(name: string, text: string): string {
      return write(
        `${name}.json`,
        JSON.stringify({
          ...MOTIVATING,
          criteria: [{ id: 'c1', name: 'Stratos and a monster', text }],
        }),
      );
    }

    async function optimized(name: string, text: string, ...flags: string[]) {
      const { code, stdout } = await run([
        templateSaying(name, text),
        '--workdir',
        WORKDIR,
        ...flags,
      ]);
      expect(code, text).toBe(EXIT_OK);
      return stdout;
    }

    /** Everything a run reports but the clock readings, which differ run to run. */
    function scored(stdout: string) {
      const { result, ...rest } = JSON.parse(stdout);
      const { elapsedMs: _elapsed, estimatedMs: _estimated, cost: _cost, ...numbers } = result;
      return { ...rest, result: numbers };
    }

    it('scores exactly as the range it stands for, and not as the plain count', async () => {
      const exactly = await optimized(
        'exactly',
        '1x [Elemental HERO Stratos], exactly 1x monster',
        '--json',
      );
      const spelt = await optimized('spelt', '1x [Elemental HERO Stratos], 1-1x monster', '--json');
      const plain = await optimized('plain', '1x [Elemental HERO Stratos], 1x monster', '--json');
      // One AST, so one number — every number the run reports.
      expect(scored(exactly)).toEqual(scored(spelt));
      expect(scored(exactly).result.best.blend).toEqual(JSON.parse(spelt).result.best.blend);
      // And the ceiling really binds: without it the odds are a different thing.
      expect(scored(exactly)).not.toEqual(scored(plain));
    });

    it('is what the report calls both spellings', async () => {
      for (const [name, text] of [
        ['exactly-report', '1x [Elemental HERO Stratos], exactly 1x monster'],
        ['spelt-report', '1x [Elemental HERO Stratos], 1-1x monster'],
      ] as const) {
        const stdout = await optimized(name, text);
        expect(stdout, text).toMatch(/^ {6}1\. 1x #\d+, exactly 1x monster$/m);
        expect(stdout, text).toMatch(/^ {2}requirement +exactly 1x monster +\[Monster\]/m);
      }
    });
  });

  describe('the wall', () => {
    it('scores nothing and exits 3 when the estimate is over the threshold, naming --force', async () => {
      const { code, stdout, stderr } = await run([
        MOTIVATING_PATH,
        '--workdir',
        WORKDIR,
        '--threshold',
        '0',
      ]);
      expect(code).toBe(EXIT_NEEDS_CONFIRMATION);
      expect(stdout).toBe('');
      expect(stderr).toMatch(
        /^optimize: nothing was scored — scoring 128 class vectors would take about /,
      );
      expect(stderr).toMatch(/re-run with --force to go ahead\n$/);
      expect(stderr).not.toMatch(/128 \/ 128/);
    });

    it('--force runs it', async () => {
      const { code, stdout } = await run([
        MOTIVATING_PATH,
        '--workdir',
        WORKDIR,
        '--threshold',
        '0',
        '--force',
      ]);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toMatch(/^Best ratio — /m);
    });
  });
});
