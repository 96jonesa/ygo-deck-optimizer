import {
  ATTRIBUTE_VOCABULARY,
  KIND_VOCABULARY,
  type Kind,
  MONSTER_FLAG_VOCABULARY,
  type MonsterFlag,
  RACE_VOCABULARY,
  ST_SUBKIND_VOCABULARY,
  type StSubkind,
} from '../cards/vocabulary';
import { normalize } from '../util/normalize';

/** Half-open `[start, end)` offsets into the text that was lexed. */
export interface Span {
  start: number;
  end: number;
}

export type Punct = '(' | ')' | '/' | '-' | '?' | ':';

export type TokenBody =
  | { t: 'kind'; kind: Kind }
  /** The word `card`: a kind word that constrains nothing. */
  | { t: 'cardWord' }
  | { t: 'flag'; flag: MonsterFlag }
  | { t: 'subkind'; subkind: StSubkind }
  /** `normal` / `ritual`: a monster flag or a Spell/Trap sub-kind, by context (TDD §5.1). */
  | { t: 'contextual'; flag: MonsterFlag; subkind: StSubkind }
  | { t: 'attribute'; bit: number }
  | { t: 'race'; bit: number }
  /** The `non-` prefix, including its hyphen or spaces. */
  | { t: 'non' }
  | { t: 'level' }
  | { t: 'stat'; stat: 'atk' | 'def' }
  /** `or lower` / `or less` (down), `or higher` / `or more` (up). */
  | { t: 'bound'; dir: 'down' | 'up' }
  | { t: 'or' }
  | { t: 'punct'; ch: Punct }
  | { t: 'int'; value: number }
  | { t: 'hex'; value: number }
  /** `"…"`: an archetype name, quotes stripped. */
  | { t: 'quoted'; text: string }
  /** `[…]`: a card name, brackets stripped. */
  | { t: 'cardName'; text: string }
  /** `{…}`: a group name, braces stripped. */
  | { t: 'group'; text: string }
  /** `#12345678`. */
  | { t: 'passcode'; value: number }
  /** A word outside the vocabulary; the parser reports it. */
  | { t: 'word'; text: string };

export type Token = TokenBody & { span: Span };

export type LexResult = { ok: true; tokens: Token[] } | { ok: false; message: string; span: Span };

/**
 * A vocabulary spelling as its words: `Beast-Warrior`, `beast warrior` and
 * `BeastWarrior` differ only in what separates the parts, and hyphens and
 * runs of whitespace are equivalent inside a vocabulary word (TDD §5.1).
 */
function parts(spelling: string): string[] {
  return normalize(spelling)
    .split(/[-\s]+/)
    .filter((part) => part !== '');
}

/** The separator-free form of a spelling (`beastwarrior`): the vocabulary's lookup key. */
function keyOf(spelling: string): string {
  return parts(spelling).join('');
}

function buildVocabulary(): [string[], TokenBody][] {
  const words: [string[], TokenBody][] = [];
  const add = (spellings: readonly string[], body: TokenBody) => {
    for (const spelling of spellings) words.push([parts(spelling), body]);
  };
  const flags = new Map(MONSTER_FLAG_VOCABULARY.map((entry) => [keyOf(entry.name), entry]));
  const subkinds = new Set(ST_SUBKIND_VOCABULARY.map((entry) => keyOf(entry.name)));

  for (const e of KIND_VOCABULARY) add([e.name, ...e.synonyms], { t: 'kind', kind: e.kind });
  add(['card', 'cards'], { t: 'cardWord' });
  for (const e of ST_SUBKIND_VOCABULARY) {
    // A word that is both a monster flag and a sub-kind is resolved by the parser.
    const flag = flags.get(keyOf(e.name));
    add(
      [e.name, ...e.synonyms],
      flag
        ? { t: 'contextual', flag: flag.flag, subkind: e.subkind }
        : { t: 'subkind', subkind: e.subkind },
    );
  }
  for (const e of MONSTER_FLAG_VOCABULARY)
    if (!subkinds.has(keyOf(e.name))) add([e.name, ...e.synonyms], { t: 'flag', flag: e.flag });
  for (const e of ATTRIBUTE_VOCABULARY)
    add([e.name, ...e.synonyms], { t: 'attribute', bit: e.bit });
  for (const e of RACE_VOCABULARY) add([e.name, ...e.synonyms], { t: 'race', bit: e.bit });
  add(['level'], { t: 'level' });
  add(['ATK'], { t: 'stat', stat: 'atk' });
  add(['DEF'], { t: 'stat', stat: 'def' });
  add(['or lower', 'or less', 'or below'], { t: 'bound', dir: 'down' });
  add(['or higher', 'or more', 'or above'], { t: 'bound', dir: 'up' });
  add(['or'], { t: 'or' });
  return words;
}

const WORDS = buildVocabulary();
/** Token by separator-free spelling. */
const VOCABULARY = new Map(WORDS.map(([wordParts, body]) => [wordParts.join(''), body]));

const NOT_IN_A_WORD = '(?![\\p{L}\\p{N}])';

/**
 * One regex branch per spelling, its parts joined by "any hyphens or spaces",
 * longest spelling first — so that `Winged Beast` wins over `Beast`,
 * `Beast-Warrior` over `Beast`, and `or lower` over `or`. An alternation takes
 * its first matching branch, and a branch only matches up to a word boundary:
 * `beastly` is not `Beast`.
 */
const LONGEST_FIRST = [...WORDS]
  .sort(([a], [b]) => b.join('').length - a.join('').length)
  .map(([wordParts]) => wordParts.join('[-\\s]*'));
const VOCABULARY_WORD = new RegExp(`(?:${LONGEST_FIRST.join('|')})${NOT_IN_A_WORD}`, 'iuy');
/** `non-`, `non ` — or `non` run straight into a vocabulary word (`nontuner`). */
const NON = new RegExp(`non(?:[-\\s]+|(?=(?:${LONGEST_FIRST.join('|')})${NOT_IN_A_WORD}))`, 'iuy');
const HEX = /0x[0-9a-f]+/iy;
const DIGITS = /[0-9]+/y;
const WORD = /[\p{L}\p{N}]+/uy;
const SPACE = /\s+/y;

const PUNCT: ReadonlySet<string> = new Set(['(', ')', '/', '-', '?', ':']);
/** Opening delimiter → [closing delimiter, token, what it holds]. */
const DELIMITED: Readonly<Record<string, [string, 'quoted' | 'cardName' | 'group', string]>> = {
  '"': ['"', 'quoted', 'an archetype name'],
  '“': ['”', 'quoted', 'an archetype name'],
  '[': [']', 'cardName', 'a card name'],
  '{': ['}', 'group', 'a group name'],
};

function matchAt(re: RegExp, text: string, pos: number): string | undefined {
  re.lastIndex = pos;
  return re.exec(text)?.[0];
}

/**
 * Split a description into tokens (TDD §5.1). Case-insensitive; never throws.
 * Every span indexes into `text` as given — the text is not normalized first,
 * because normalization changes its length.
 */
export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  let pos = 0;
  const fail = (message: string, start: number, end: number): LexResult => ({
    ok: false,
    message,
    span: { start, end },
  });

  while (pos < text.length) {
    const space = matchAt(SPACE, text, pos);
    if (space !== undefined) {
      pos += space.length;
      continue;
    }
    const start = pos;
    const ch = text[pos]!;
    const push = (body: TokenBody, length: number) => {
      pos = start + length;
      tokens.push({ ...body, span: { start, end: pos } });
    };

    if (PUNCT.has(ch)) {
      push({ t: 'punct', ch: ch as Punct }, 1);
      continue;
    }

    const delimited = DELIMITED[ch];
    if (delimited !== undefined) {
      const [close, t, what] = delimited;
      const end = text.indexOf(close, pos + 1);
      if (end < 0)
        return fail(
          `this ${ch} is never closed: expected ${close} after ${what}`,
          start,
          text.length,
        );
      push({ t, text: text.slice(pos + 1, end).trim() }, end + 1 - start);
      continue;
    }

    if (ch === '#') {
      const digits = matchAt(DIGITS, text, pos + 1);
      if (digits === undefined)
        return fail('expected a passcode after #, such as #89631139', start, start + 1);
      if (digits.length > 10)
        return fail('a passcode has at most 10 digits', start, pos + 1 + digits.length);
      push({ t: 'passcode', value: Number(digits) }, 1 + digits.length);
      continue;
    }

    const hex = matchAt(HEX, text, pos);
    if (hex !== undefined) {
      if (hex.length > 10)
        return fail('a hex code has at most 8 digits', start, start + hex.length);
      push({ t: 'hex', value: Number.parseInt(hex.slice(2), 16) }, hex.length);
      continue;
    }

    const digits = matchAt(DIGITS, text, pos);
    if (digits !== undefined) {
      if (digits.length > 9) return fail('this number is too large', start, start + digits.length);
      push({ t: 'int', value: Number(digits) }, digits.length);
      continue;
    }

    const non = matchAt(NON, text, pos);
    if (non !== undefined) {
      push({ t: 'non' }, non.length);
      continue;
    }

    const vocabulary = matchAt(VOCABULARY_WORD, text, pos);
    const body = vocabulary && VOCABULARY.get(vocabulary.toLowerCase().replaceAll(/[-\s]+/g, ''));
    if (vocabulary !== undefined && body) {
      push(body, vocabulary.length);
      continue;
    }

    const word = matchAt(WORD, text, pos);
    if (word !== undefined) {
      push({ t: 'word', text: word }, word.length);
      continue;
    }

    const codePoint = String.fromCodePoint(text.codePointAt(pos)!);
    return fail(`unexpected character ${codePoint}`, start, start + codePoint.length);
  }
  return { ok: true, tokens };
}
