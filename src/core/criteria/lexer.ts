import { lexOne, type Span, skipSpace, type TokenBody } from '../desc/lexer';

export type CriterionTokenBody =
  | TokenBody
  /**
   * `2x`, `2×`, `2 x`, and the range `1-2x`: the digits through the `x`. Not
   * validated — `0x`, `999x` and `4-2x` are all counts here.
   */
  | { t: 'count'; n: number; max?: number }
  | { t: 'atMost' }
  | { t: 'no' }
  /** `exactly`: the count that follows is both ends of a range (TDD §7.1). */
  | { t: 'exactly' }
  /** `then`: what comes after it is about the SIXTH CARD, the one you draw going second. */
  | { t: 'then' }
  /** `finally`: what comes after it is a full criterion over the WHOLE hand (TDD §7.1). */
  | { t: 'finally' }
  /** `and` or `,`: the two are interchangeable (TDD §7.1). */
  | { t: 'and' };

export type CriterionToken = CriterionTokenBody & { span: Span };

export type CriterionLexResult =
  | { ok: true; tokens: CriterionToken[] }
  | { ok: false; message: string; span: Span };

const NOT_IN_A_WORD = '(?![\\p{L}\\p{N}])';

/**
 * COUNT against hex. `"Warrior":0x2066` holds the letters of the count `0x`,
 * so an `x` makes a count only where it ENDS a word: `0x2066` and `0xdark`
 * are left to the description lexer, which reads a hex code. A `×` is never
 * part of a word and needs no such care.
 *
 * The `x` is also what keeps a count range apart from a description's own:
 * `1-2x` is a count and `level 2-4` is not, because only the first ends in an
 * `x`. A count written WITHOUT its `x` — `1-2 monster` — is the parser's to
 * assemble out of plain integers, and only where a term must start (TDD §7.1).
 */
const COUNT = new RegExp(`([0-9]+)(?:\\s*-\\s*([0-9]+))?\\s*(?:×|x${NOT_IN_A_WORD})`, 'iuy');

const KEYWORDS: readonly [RegExp, CriterionTokenBody][] = [
  [new RegExp(`at\\s+most${NOT_IN_A_WORD}`, 'iuy'), { t: 'atMost' }],
  [new RegExp(`no${NOT_IN_A_WORD}`, 'iuy'), { t: 'no' }],
  [new RegExp(`exactly${NOT_IN_A_WORD}`, 'iuy'), { t: 'exactly' }],
  [new RegExp(`then${NOT_IN_A_WORD}`, 'iuy'), { t: 'then' }],
  [new RegExp(`finally${NOT_IN_A_WORD}`, 'iuy'), { t: 'finally' }],
  [new RegExp(`and${NOT_IN_A_WORD}`, 'iuy'), { t: 'and' }],
  [/,/y, { t: 'and' }],
];

function matchAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** The criterion word that starts at `pos`, and its length. */
function keywordAt(text: string, pos: number): [CriterionTokenBody, number] | undefined {
  const count = matchAt(COUNT, text, pos);
  // However many digits: beyond 2^53 the value is inexact, and still far above any count allowed.
  if (count !== null) {
    const n = Number(count[1]);
    const upper = count[2];
    return [
      upper === undefined ? { t: 'count', n } : { t: 'count', n, max: Number(upper) },
      count[0].length,
    ];
  }
  for (const [re, body] of KEYWORDS) {
    const match = matchAt(re, text, pos);
    if (match !== null) return [body, match[0].length];
  }
  return undefined;
}

/**
 * Split a criterion into tokens (TDD §7.1): the description lexer's, plus
 * counts, `at most`, `no`, `exactly`, `then`, `finally`, `and` and the comma,
 * which are
 * tried first wherever a token starts. They are whole words, so `non-tuner`,
 * `normal` and a name in brackets or quotes are never touched; `or` stays the
 * description lexer's,
 * and which of the two "or"s one is is the parser's call. Case-insensitive;
 * never throws; every span indexes into `text` as given.
 */
export function lexCriterion(text: string): CriterionLexResult {
  const tokens: CriterionToken[] = [];
  for (let pos = skipSpace(text, 0); pos < text.length; pos = skipSpace(text, pos)) {
    const previous = tokens.at(-1);
    // After a colon comes a setcode: `"Warrior":0x` is a hex code cut short, not a count.
    const afterColon = previous?.t === 'punct' && previous.ch === ':';
    const keyword = afterColon ? undefined : keywordAt(text, pos);
    if (keyword !== undefined) {
      const [body, length] = keyword;
      tokens.push({ ...body, span: { start: pos, end: pos + length } });
      pos += length;
      continue;
    }
    const result = lexOne(text, pos);
    if (!result.ok) return result;
    tokens.push(result.token);
    pos = result.token.span.end;
  }
  return { ok: true, tokens };
}
