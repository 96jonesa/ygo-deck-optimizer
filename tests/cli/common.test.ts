import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXIT_FAILED,
  fail,
  handArg,
  loadInstall,
  parseFlags,
  readTemplate,
  templateArg,
  wholeNumber,
  workdirArg,
} from '../../src/cli/common';
import { captureIo } from '../helpers/cli-io';
import { STRINGS_CONF } from '../helpers/desc-context';
import { MOTIVATING_PATH, motivatingCdb } from '../helpers/motivating';

const scratch = mkdtempSync(path.join(tmpdir(), 'ygo-cli-common-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function write(relative: string, contents: string | Uint8Array): string {
  const file = path.join(scratch, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

describe('wholeNumber', () => {
  it('reads digits and nothing else', () => {
    expect(wholeNumber('0')).toBe(0);
    expect(wholeNumber('200000')).toBe(200000);
    for (const text of ['', '-1', '1.5', '1e3', ' 1', '0x10', '1'.repeat(16)])
      expect(wholeNumber(text)).toBeUndefined();
  });
});

describe('parseFlags', () => {
  const parse = (argv: string[]) => parseFlags(argv, ['--workdir', '--hand'], ['--json']);

  it('splits options, switches and positionals, in either spelling and any order', () => {
    expect(parse(['--hand=6', 't.json', '--json', '--workdir', '/w'])).toEqual({
      ok: true,
      help: false,
      values: new Map([
        ['--hand', '6'],
        ['--workdir', '/w'],
      ]),
      switches: new Set(['--json']),
      positional: ['t.json'],
    });
  });

  it('answers --help before anything else', () => {
    expect(parse(['--nonsense', '-h'])).toMatchObject({ ok: true, help: true });
    expect(parse(['--help'])).toMatchObject({ ok: true, help: true });
  });

  it('rejects what it does not know, a repeat, a missing value, and a value on a switch', () => {
    expect(parse(['--fast'])).toEqual({ ok: false, message: 'unknown option --fast' });
    expect(parse(['--hand', '5', '--hand=6'])).toEqual({
      ok: false,
      message: '--hand is given twice',
    });
    expect(parse(['--workdir'])).toEqual({ ok: false, message: '--workdir needs a value' });
    expect(parse(['--workdir='])).toEqual({ ok: false, message: '--workdir needs a value' });
    expect(parse(['--json=yes'])).toEqual({ ok: false, message: '--json takes no value' });
  });
});

describe('templateArg', () => {
  it('wants exactly one template', () => {
    expect(templateArg(['a.json'])).toEqual({ ok: true, value: 'a.json' });
    expect(templateArg([])).toEqual({ ok: false, message: 'which template? give a .json file' });
    expect(templateArg(['a.json', 'b.json'])).toEqual({
      ok: false,
      message: 'one template at a time, not a.json and b.json',
    });
  });
});

describe('workdirArg', () => {
  it('prefers the flag to $EDOPRO_WORKDIR, and wants one of them', () => {
    expect(workdirArg('/flag', { EDOPRO_WORKDIR: '/env' })).toEqual({ ok: true, value: '/flag' });
    expect(workdirArg(undefined, { EDOPRO_WORKDIR: '/env' })).toEqual({ ok: true, value: '/env' });
    expect(workdirArg(undefined, {})).toMatchObject({ ok: false });
    expect(workdirArg(undefined, { EDOPRO_WORKDIR: '' })).toMatchObject({ ok: false });
  });
});

describe('handArg', () => {
  it('reads 5 or 6, or nothing', () => {
    expect(handArg(undefined)).toEqual({ ok: true, value: undefined });
    expect(handArg('6')).toEqual({ ok: true, value: 6 });
    expect(handArg('7')).toEqual({ ok: false, message: '--hand must be 5 or 6, not 7' });
    expect(handArg('five')).toMatchObject({ ok: false });
  });
});

describe('readTemplate', () => {
  it('reads and validates a template, and overrides its hand size when asked', () => {
    const read = readTemplate(MOTIVATING_PATH);
    expect(read).toMatchObject({ ok: true, value: { deckSize: 40, hand: { size: 5 } } });
    expect(readTemplate(MOTIVATING_PATH, 6)).toMatchObject({
      ok: true,
      value: { hand: { size: 6 } },
    });
  });

  it('reports a file that is not there, is not JSON, or is not a template', () => {
    expect(readTemplate(path.join(scratch, 'nope.json'))).toEqual({
      ok: false,
      errors: [expect.stringMatching(/^cannot read .*nope\.json/)],
    });
    expect(readTemplate(write('broken.json', '{ "version": 1,'))).toEqual({
      ok: false,
      errors: [expect.stringMatching(/^cannot read .*broken\.json/)],
    });
    const bad = write('bad.json', JSON.stringify({ version: 1, deckSize: 30 }));
    const result = readTemplate(bad);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatch(/bad\.json: `deckSize` is 30; a Main Deck holds 40 to 60$/);
  });
});

describe('loadInstall', () => {
  it('loads the cards and setnames, and describes what it loaded', async () => {
    const SQL = await initSqlJs();
    write('install/expansions/cards.cdb', motivatingCdb(SQL));
    write('install/config/strings.conf', STRINGS_CONF);
    const workdir = path.join(scratch, 'install');
    const install = await loadInstall(workdir);
    if (!install.ok) throw new Error(install.errors.join('\n'));
    expect(install.value.cards.status.cards).toBe(22);
    expect(install.value.setnames?.size).toBe(11);
    expect(install.value.header).toContain(`Card database — ${workdir}\n`);
    expect(install.value.header).toMatch(/cards +22$/m);
    expect(install.value.header).toMatch(/setnames +11 archetype names from 1 strings\.conf file/);
    expect(install.value.header.endsWith('\n\n')).toBe(true);
  });

  it('says so when the install has no strings.conf', async () => {
    write('bare/expansions/cards.cdb', motivatingCdb(await initSqlJs()));
    const install = await loadInstall(path.join(scratch, 'bare'));
    if (!install.ok) throw new Error(install.errors.join('\n'));
    expect(install.value.setnames).toBeNull();
    expect(install.value.header).toMatch(/setnames +none — no strings\.conf found/);
  });

  it('reports a workdir that is not a directory, or holds no database', async () => {
    expect(await loadInstall(path.join(scratch, 'nowhere'))).toEqual({
      ok: false,
      errors: [expect.stringMatching(/nowhere is not a directory$/)],
    });
    mkdirSync(path.join(scratch, 'empty'), { recursive: true });
    expect(await loadInstall(path.join(scratch, 'empty'))).toEqual({
      ok: false,
      errors: [expect.stringMatching(/^no card database under .*empty/)],
    });
  });
});

describe('fail', () => {
  it('writes one `error:` line per message to stderr, and is exit code 1', () => {
    const captured = captureIo();
    expect(fail(captured.io, ['first', 'second'])).toBe(EXIT_FAILED);
    expect(captured.stderr()).toBe('error: first\nerror: second\n');
    expect(captured.stdout()).toBe('');
  });
});
