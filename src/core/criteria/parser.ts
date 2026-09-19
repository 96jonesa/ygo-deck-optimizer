import type { Description } from '../desc/ast';
import type { DescContext } from '../desc/context';
import type { Span, Token } from '../desc/lexer';
import { parseTokens } from '../desc/parser';
import { canonicalizeExpr, type Expr, MAX_COUNT } from './ast';
import { type CriterionToken, lexCriterion } from './lexer';

export type CriterionParseResult =
  | { ok: true; expr: Expr }
  | { ok: false; message: string; span: Span };

/** Parentheses only group, so real input nests once or twice; the cap keeps the stack bounded. */
const MAX_DEPTH = 32;

const TERM_EXAMPLES =
  'a requirement such as `1x level 4 monster`, or a limit such as `at most 1x trap` or `no trap`';

/** Internal control flow only: `parseCriterion` catches it and never lets it escape. */
class Failure {
  constructor(
    readonly message: string,
    readonly span: Span,
  ) {}
}

type TokenOf<T extends CriterionToken['t']> = Extract<CriterionToken, { t: T }>;

function isPunct(token: CriterionToken | undefined, ch: '(' | ')'): boolean {
  return token?.t === 'punct' && token.ch === ch;
}

/** The words that can only begin a requirement or a limit. */
function isTermWord(
  token: CriterionToken | undefined,
): token is TokenOf<'count' | 'atMost' | 'no'> {
  return token?.t === 'count' || token?.t === 'atMost' || token?.t === 'no';
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly CriterionToken[],
    private readonly text: string,
    private readonly ctx: DescContext,
  ) {}

  parseAll(): Expr {
    const expr = this.orExpr(0);
    const extra = this.peek();
    // `term` lets only `and`, `or` and `)` follow it, and the first two are always consumed.
    if (extra !== undefined) throw new Failure('this `)` has no matching `(`', extra.span);
    return expr;
  }

  private peek(): CriterionToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): CriterionToken {
    return this.tokens[this.pos++]!;
  }

  private spanAt(index: number): Span {
    return this.tokens[index]?.span ?? { start: this.text.length, end: this.text.length };
  }

  private textOf(token: CriterionToken): string {
    return this.text.slice(token.span.start, token.span.end);
  }

  private orExpr(depth: number): Expr {
    const args = [this.andExpr(depth)];
    while (this.peek()?.t === 'or') {
      this.next();
      args.push(this.andExpr(depth));
    }
    return { op: 'or', args };
  }

  private andExpr(depth: number): Expr {
    const args = [this.term(depth)];
    while (this.peek()?.t === 'and') {
      this.next();
      args.push(this.term(depth));
    }
    return { op: 'and', args };
  }

  /**
   * The index of the first token at or after `index` that is not a `(`. The
   * one token of lookahead that tells the two "or"s, and the two kinds of
   * parentheses, apart (TDD §7.1) looks through however many `(` precede it.
   */
  private pastOpenParens(index: number): number {
    let i = index;
    while (isPunct(this.tokens[i], '(')) i++;
    return i;
  }

  private startsTerm(index: number): boolean {
    return isTermWord(this.tokens[this.pastOpenParens(index)]);
  }

  private term(depth: number): Expr {
    const expr = this.termBody(depth);
    const after = this.peek();
    // A description runs to the end of its term, so this is what follows a group: `(1x [C]) [D]`.
    if (after !== undefined && after.t !== 'and' && after.t !== 'or' && !isPunct(after, ')'))
      throw new Failure(
        `expected \`and\`, \`,\` or \`or\` before \`${this.textOf(after)}\``,
        after.span,
      );
    return expr;
  }

  private termBody(depth: number): Expr {
    const token = this.peek();
    if (isTermWord(token)) return this.leaf(token);
    if (token !== undefined && isPunct(token, '(')) return this.group(token, depth);

    const before = this.tokens[this.pos - 1];
    const where = before === undefined ? '' : ` after \`${this.textOf(before)}\``;
    if (token === undefined || token.t === 'and' || token.t === 'or' || isPunct(token, ')'))
      throw new Failure(`expected ${TERM_EXAMPLES}${where}`, this.spanAt(this.pos));
    throw this.missingCount(token);
  }

  /** Something that is not a term stands where one must start: most likely a bare description. */
  private missingCount(token: CriterionToken): Failure {
    if (token.t === 'hex')
      return new Failure(
        `\`${this.textOf(token)}\` reads as a hex code; put a space after the \`x\` of a count, as in \`0x dark monster\``,
        token.span,
      );
    const hint =
      token.t === 'int' && token.value <= MAX_COUNT
        ? `; a count ends in x: \`${token.value}x\``
        : '';
    return new Failure(
      `expected a count before the description, as in \`1x level 4 monster\`${hint}; a limit reads \`at most 1x trap\` or \`no trap\``,
      token.span,
    );
  }

  /** A `(` where a term must start: a group of terms, if a term is what it opens on. */
  private group(open: CriterionToken, depth: number): Expr {
    const inside = this.pastOpenParens(this.pos);
    const first = this.tokens[inside];
    if (first === undefined)
      throw new Failure(`expected ${TERM_EXAMPLES} after \`(\``, this.spanAt(inside));
    if (isPunct(first, ')'))
      throw new Failure('there is nothing between these parentheses', {
        start: open.span.start,
        end: first.span.end,
      });
    // `([C] or [E])` is a description, which belongs after a count.
    if (!isTermWord(first)) throw this.missingCount(first);

    if (depth >= MAX_DEPTH) throw new Failure('too many nested parentheses', open.span);
    this.next();
    const inner = this.orExpr(depth + 1);
    // As in `parseAll`: what stopped `orExpr` is a `)` or the end.
    if (this.peek() === undefined) throw new Failure('this `(` is never closed', open.span);
    this.next();
    return inner;
  }

  private leaf(word: TokenOf<'count' | 'atMost' | 'no'>): Expr {
    this.next();
    if (word.t === 'no') return { op: 'atMost', n: 0, desc: this.description() };
    if (word.t === 'count') {
      if (word.n < 1)
        throw new Failure(
          'a requirement needs at least 1 card; to rule cards out, write `no …` or `at most 1x …`',
          word.span,
        );
      return { op: 'req', n: this.count(word), desc: this.description() };
    }
    const count = this.peek();
    if (count?.t !== 'count') {
      if (count?.t === 'hex') throw this.missingCount(count);
      throw new Failure(
        'expected a count after `at most`, as in `at most 1x trap`',
        this.spanAt(this.pos),
      );
    }
    this.next();
    return { op: 'atMost', n: this.count(count), desc: this.description() };
  }

  private count(token: TokenOf<'count'>): number {
    if (token.n > MAX_COUNT)
      throw new Failure(
        `a count is at most ${MAX_COUNT}, the size of the largest deck`,
        token.span,
      );
    return token.n;
  }

  /**
   * The description after a count or `no`: every token up to the end of the
   * term, handed to the description parser. A term ends at `and`, at a `)`
   * that closes a group of terms, and at the criterion-level `or` — the one
   * a term follows. Any other `or` continues the description, and so does
   * everything inside the description's own parentheses.
   */
  private description(): Description {
    const start = this.pos;
    let depth = 0;
    let end = start;
    for (; end < this.tokens.length; end++) {
      const token = this.tokens[end]!;
      if (isPunct(token, '(')) depth++;
      else if (isPunct(token, ')')) {
        if (depth === 0) break;
        depth--;
      } else if (token.t === 'or') {
        if (depth === 0 && this.startsTerm(end + 1)) break;
      } else if (token.t === 'and' || isTermWord(token)) {
        // With nothing read yet the description is what is missing, and its parser says so.
        if (depth === 0 && (token.t === 'and' || end === start)) break;
        throw this.termWordInDescription(token, depth);
      }
    }
    const result = parseTokens(
      this.tokens.slice(start, end) as Token[],
      this.spanAt(end),
      this.ctx,
    );
    if (!result.ok) throw new Failure(result.message, result.span);
    this.pos = end;
    return result.desc;
  }

  private termWordInDescription(token: CriterionToken, depth: number): Failure {
    const word = `\`${this.textOf(token)}\``;
    if (depth === 0)
      return new Failure(`expected \`and\`, \`,\` or \`or\` before ${word}`, token.span);
    return new Failure(
      token.t === 'and'
        ? `${word} joins requirements and cannot stand inside a description's parentheses; write \`or\` between alternatives`
        : `${word} starts a new requirement or limit, which cannot stand inside a description's parentheses; close the \`)\` first`,
      token.span,
    );
  }
}

/**
 * Parse criterion text into a canonical AST (TDD §7.1). Never throws: every
 * problem — the description parser's included — comes back as a message for
 * the user with the span of `text` it is about.
 *
 * Two different "or"s exist (PRD §5.3) and one token of lookahead, through
 * any parentheses, separates them: an `or` followed by a count, `at most` or
 * `no` chooses between terms; any other `or` continues the description, so
 * that `1x [C] or [E]` is ONE slot either card can fill. The same lookahead
 * reads a `(` where a term must start; after a count, a `(` always opens a
 * description.
 */
export function parseCriterion(text: string, ctx: DescContext): CriterionParseResult {
  const lexed = lexCriterion(text);
  if (!lexed.ok) return lexed;
  try {
    return { ok: true, expr: canonicalizeExpr(new Parser(lexed.tokens, text, ctx).parseAll()) };
  } catch (failure) {
    if (failure instanceof Failure)
      return { ok: false, message: failure.message, span: failure.span };
    throw failure;
  }
}
