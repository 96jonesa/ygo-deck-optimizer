import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import type { CardIndex } from '../core/cards/index';
import type { SetnameTable } from '../core/cards/setnames';
import { HAND_SIZES, type Template, validateTemplate } from '../core/model/template';
import { collectStringsConf, loadCardIndex, loadSetnames } from '../main/edopro/loader';
import { int, table } from './report';

/** Where a command reads its environment and writes its output; `process` satisfies it. */
export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
}

export const EXIT_OK = 0;
/** The template, or the card data, is at fault. */
export const EXIT_FAILED = 1;
/** The command line is at fault. */
export const EXIT_USAGE = 2;

export function wholeNumber(text: string): number | undefined {
  return /^[0-9]{1,15}$/.test(text) ? Number(text) : undefined;
}

export type Flags<V extends string, S extends string> =
  | { ok: true; help: boolean; values: Map<V, string>; switches: Set<S>; positional: string[] }
  | { ok: false; message: string };

/**
 * Split a command's arguments into `--flag value` / `--flag=value` options,
 * bare `--switch`es, and positionals. `-h` / `--help` anywhere wins.
 */
export function parseFlags<V extends string, S extends string = never>(
  argv: readonly string[],
  valueFlags: readonly V[],
  switchFlags: readonly S[] = [],
): Flags<V, S> {
  const values = new Map<V, string>();
  const switches = new Set<S>();
  const positional: string[] = [];
  if (argv.includes('-h') || argv.includes('--help'))
    return { ok: true, help: true, values, switches, positional };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (switchFlags.includes(flag as S)) {
      if (equals >= 0) return { ok: false, message: `${flag} takes no value` };
      switches.add(flag as S);
      continue;
    }
    if (!valueFlags.includes(flag as V)) return { ok: false, message: `unknown option ${flag}` };
    if (values.has(flag as V)) return { ok: false, message: `${flag} is given twice` };
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined || value === '') return { ok: false, message: `${flag} needs a value` };
    values.set(flag as V, value);
  }
  return { ok: true, help: false, values, switches, positional };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** The one template a command is about. */
export function templateArg(positional: readonly string[]): Parsed<string> {
  if (positional.length === 0) return { ok: false, message: 'which template? give a .json file' };
  if (positional.length > 1)
    return { ok: false, message: `one template at a time, not ${positional.join(' and ')}` };
  return { ok: true, value: positional[0]! };
}

export function workdirArg(flag: string | undefined, env: CliIo['env']): Parsed<string> {
  const workdir = flag ?? env.EDOPRO_WORKDIR;
  if (workdir === undefined || workdir === '')
    return { ok: false, message: 'no EDOPro install: pass --workdir <dir> or set EDOPRO_WORKDIR' };
  return { ok: true, value: workdir };
}

/** `--hand`: `undefined` when it is not given. */
export function handArg(hand: string | undefined): Parsed<number | undefined> {
  if (hand === undefined) return { ok: true, value: undefined };
  const size = wholeNumber(hand);
  if (size === undefined || !HAND_SIZES.includes(size as 5 | 6))
    return { ok: false, message: `--hand must be ${HAND_SIZES.join(' or ')}, not ${hand}` };
  return { ok: true, value: size };
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Read and validate a template file; `hand` overrides its hand size. */
export function readTemplate(file: string, hand?: number): Loaded<Template> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (failure) {
    return { ok: false, errors: [`cannot read ${file}: ${(failure as Error).message}`] };
  }
  const validated = validateTemplate(json);
  if (!validated.ok) return { ok: false, errors: validated.errors.map((e) => `${file}: ${e}`) };
  const { template } = validated;
  return { ok: true, value: hand === undefined ? template : { ...template, hand: { size: hand } } };
}

export interface Install {
  cards: CardIndex;
  setnames: SetnameTable | null;
  /** The "Card database" section of a report: what was loaded, from where. */
  header: string;
}

/** Load the card data of an EDOPro install. */
export async function loadInstall(workdir: string): Promise<Loaded<Install>> {
  if (!existsSync(workdir) || !statSync(workdir).isDirectory())
    return { ok: false, errors: [`${workdir} is not a directory`] };
  const cards = loadCardIndex(workdir, await initSqlJs());
  const status = cards.status;
  if (status.databases === 0)
    return {
      ok: false,
      errors: [
        `no card database under ${workdir}: expected cards.cdb, expansions/*.cdb or repositories/*/*.cdb`,
      ],
    };
  const setnames = loadSetnames(workdir);
  const stringsFiles = collectStringsConf(workdir).length;
  const header = `Card database — ${workdir}\n${table([
    ['databases', `${status.databases} loaded, ${status.skippedDatabases} skipped`],
    ['cards', int(status.cards)],
    ['replacedRows', `${int(status.replacedRows)} (rows a later database updated: expected)`],
    ['conflicts', `${int(status.conflicts)} (ids on which two repositories disagree)`],
    [
      'setnames',
      setnames === null
        ? 'none — no strings.conf found, so archetype descriptions are unavailable'
        : `${int(setnames.size)} archetype names from ${stringsFiles} strings.conf file(s)`,
    ],
  ])}\n\n`;
  return { ok: true, value: { cards, setnames, header } };
}

/** Write each message as an `error:` line; the exit code of a template or data failure. */
export function fail(io: CliIo, messages: readonly string[]): number {
  for (const message of messages) io.stderr.write(`error: ${message}\n`);
  return EXIT_FAILED;
}
