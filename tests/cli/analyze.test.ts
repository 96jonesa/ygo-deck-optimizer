import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAnalyzeArgs, runAnalyze } from '../../src/cli/analyze';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../../src/cli/common';
import { type Analysis, analyze } from '../../src/core/model/analyze';
import { captureIo } from '../helpers/cli-io';
import { STRINGS_CONF } from '../helpers/desc-context';
import {
  MOTIVATING_PATH,
  motivatingCdb,
  motivatingContext,
  motivatingTemplate,
} from '../helpers/motivating';

const SQL = await initSqlJs();
const scratch = mkdtempSync(path.join(tmpdir(), 'ygo-cli-analyze-'));
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
  const code = await runAnalyze(argv, captured.io);
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

describe('parseAnalyzeArgs', () => {
  it('reads the template and falls back on the defaults', () => {
    expect(parseAnalyzeArgs(['t.json'], { EDOPRO_WORKDIR: '/w' })).toEqual({
      ok: true,
      value: { template: 't.json', workdir: '/w', json: false },
    });
  });

  it('reads every option, in either spelling and any order', () => {
    expect(parseAnalyzeArgs(['--json', '--hand=6', 't.json', '--workdir', '/w'], {})).toEqual({
      ok: true,
      value: { template: 't.json', workdir: '/w', hand: 6, json: true },
    });
  });

  it('answers --help before anything else', () => {
    expect(parseAnalyzeArgs(['--nonsense', '--help'], {})).toEqual({ ok: true, help: true });
  });

  it('rejects a bad command line with a message', () => {
    const message = (argv: string[]) => {
      const parsed = parseAnalyzeArgs(argv, { EDOPRO_WORKDIR: '/w' });
      return parsed.ok ? undefined : parsed.message;
    };
    expect(message([])).toMatch(/which template\?/);
    expect(message(['a.json', 'b.json'])).toMatch(/one template at a time/);
    expect(message(['a.json', '--hand', '7'])).toBe('--hand must be 5 or 6, not 7');
    expect(message(['a.json', '--samples', '5'])).toBe('unknown option --samples');
    expect(parseAnalyzeArgs(['a.json'], {})).toMatchObject({
      ok: false,
      message: expect.stringMatching(/--workdir <dir> or set EDOPRO_WORKDIR/),
    });
  });
});

describe('runAnalyze', () => {
  it('explains a usage error on stderr, with the usage, and exits 2', async () => {
    const { code, stdout, stderr } = await run(['--workdir', WORKDIR]);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^error: which template\?.*\n\nusage: npm run cli -- analyze/);
  });

  it('prints the usage to stdout for --help, and exits 0', async () => {
    const { code, stdout, stderr } = await run(['--help']);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/^usage: npm run cli -- analyze/);
    expect(stderr).toBe('');
  });

  it('reports a template it cannot read, or a workdir it cannot load, and exits 1', async () => {
    const missing = await run([path.join(scratch, 'nope.json'), '--workdir', WORKDIR]);
    expect(missing.code).toBe(EXIT_FAILED);
    expect(missing.stderr).toMatch(/^error: cannot read .*nope\.json/);
    expect(missing.stdout).toBe('');

    const nowhere = await run([MOTIVATING_PATH, '--workdir', path.join(scratch, 'nowhere')]);
    expect(nowhere.code).toBe(EXIT_FAILED);
    expect(nowhere.stderr).toMatch(/nowhere is not a directory/);
  });

  describe('the motivating example against the fixture database', () => {
    it('exits 0 and prints the database, then every section of the report', async () => {
      const { code, stdout, stderr } = await run([MOTIVATING_PATH, '--workdir', WORKDIR]);
      expect(code).toBe(EXIT_OK);
      expect(stderr).toBe('');
      expect(stdout.split('\n\n').map((section) => section.split(/ —|\n/)[0])).toEqual([
        'Card database',
        'Template',
        'Criteria',
        'Matching',
        'Totals',
        'Classes',
        'Work',
        'Notices',
      ]);
      expect(stdout).toMatch(/near miss: monster — Level unstated; a `level 4 or lower monster`/);
      expect(stdout).toMatch(/^ {2}Unspecified +13–33 /m);
      expect(stdout).toMatch(/^ {2}raw ratios +4,096\n {2}class vectors +128$/m);
      expect(stdout).toMatch(/criterion "c2": adds nothing: .* criterion "c1"$/m);
    });

    it('prints the raw Analysis, and nothing else, for --json', async () => {
      const { code, stdout } = await run([MOTIVATING_PATH, '--workdir', WORKDIR, '--json']);
      expect(code).toBe(EXIT_OK);
      const printed = JSON.parse(stdout) as Analysis;
      expect(printed).toStrictEqual(analyze(motivatingTemplate(), motivatingContext(SQL)));
      expect(printed.work).toMatchObject({ rawRatios: 4096, classVectors: 128 });
    });

    it('takes the workdir from $EDOPRO_WORKDIR, and the hand size from --hand', async () => {
      const { code, stdout } = await run([MOTIVATING_PATH, '--hand', '6'], {
        EDOPRO_WORKDIR: WORKDIR,
      });
      expect(code).toBe(EXIT_OK);
      expect(stdout).toMatch(/deck of 40, hand of 6$/m);
      expect(stdout).toMatch(/terms per score +\d+ at a hand of 6$/m);
    });
  });

  it('still prints the whole report for a template with errors, and exits 1', async () => {
    const bad = write(
      'templates/typo.json',
      JSON.stringify({
        ...MOTIVATING,
        lines: [...MOTIVATING.lines, { id: 'the-typo', text: 'level 4 monstr', min: 0, max: 3 }],
      }),
    );
    const { code, stdout, stderr } = await run([bad, '--workdir', WORKDIR]);
    expect(code).toBe(EXIT_FAILED);
    expect(stderr).toBe('');
    expect(stdout).toMatch(/^ {2}the-typo +level 4 monstr +\(not understood\)/m);
    expect(stdout).toMatch(/^Errors\n {2}line "the-typo": /m);
    expect(stdout).toMatch(/^ {2}\(not available until every error is fixed\)$/m);
    expect(stdout).toMatch(/^ {2}raw ratios +16,384$/m);

    const json = await run([bad, '--workdir', WORKDIR, '--json']);
    expect(json.code).toBe(EXIT_FAILED);
    expect((JSON.parse(json.stdout) as Analysis).ok).toBe(false);
  });
});
