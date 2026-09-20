import type { Description } from '../desc/ast';
import type { DescContext } from '../desc/context';
import type { Span, Token } from '../desc/lexer';
import { parseTokens } from '../desc/parser';
import { canonicalizeExpr, type Expr, MAX_COUNT, MAX_SIXTH_SLOTS, slotsOf } from './ast';
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

function isPunct(token: CriterionToken | undefined, ch: '(' | ')' | '-'): boolean {
  return token?.t === 'punct' && token.ch === ch;
}

/** The words that can only begin a requirement or a limit. */
function isTermWord(
  token: CriterionToken | undefined,
): token is TokenOf<'count' | 'atMost' | 'no' | 'exactly'> {
  return (
    token?.t === 'count' || token?.t === 'atMost' || token?.t === 'no' || token?.t === 'exactly'
  );
}

/**
 * A plain integer that can stand in for a count whose `x` was left out. The
 * cap is what keeps the better message: `2000 ATK monster` is a description
 * missing its count, not a count of 2000.
 */
function isBareCount(token: CriterionToken | undefined): token is TokenOf<'int'> {
  return token?.t === 'int' && token.value <= MAX_COUNT;
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly CriterionToken[],
    private readonly text: string,
    private readonly ctx: DescContext,
  ) {}

  parseAll(): Expr {
    // `then` binds looser than everything, and a criterion has one: the hand
    // comes in two pieces, not three. A LEADING one says the opening five may
    // be anything and only the card drawn is asked about.
    if (this.peek()?.t === 'then') {
      this.next();
      return { op: 'split', sixth: this.sixthPart() };
    }
    const expr = this.orExpr(0);
    const separator = this.peek();
    if (separator?.t === 'then') {
      this.next();
      return { op: 'split', five: expr, sixth: this.sixthPart() };
    }
    const extra = this.peek();
    // `term` lets only `and`, `or`, `then` and `)` follow it, and the first two are always consumed.
    if (extra !== undefined) throw new Failure('this `)` has no matching `(`', extra.span);
    return expr;
  }

  /** What follows `then`: the sixth card's own criterion, over ONE card. */
  private sixthPart(): Expr {
    if (this.peek() === undefined)
      throw new Failure(
        'expected what the card you draw must be after `then`, as in `1x [Ash Blossom & Joyous Spring]` or `no trap`',
        this.spanAt(this.pos),
      );
    const start = this.pos;
    const sixth = this.orExpr(0);
    const extra = this.peek();
    if (extra?.t === 'then')
      throw new Failure(
        'a criterion has one `then`: it separates the five cards you open on from the one you draw, and there is only one card drawn',
        extra.span,
      );
    if (extra !== undefined) throw new Failure('this `)` has no matching `(`', extra.span);
    const slots = slotsOf(sixth);
    if (slots > MAX_SIXTH_SLOTS)
      throw new Failure(
        `the sixth card is one card, and this asks ${slots} of it: after \`then\`, write one requirement — \`1x …\` — or limits alone, as in \`no trap\``,
        { start: this.spanAt(start).start, end: this.spanAt(this.pos - 1).end },
      );
    return sixth;
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

  /**
   * Whether a term starts AT `index`, where the grammar allows nothing else —
   * so a count may leave its `x` out. Not the same question as `startsTerm`,
   * which is asked after an `or`, where a description may continue instead and
   * only the `x` tells the two apart.
   */
  private startsTermHere(index: number): boolean {
    return isTermWord(this.tokens[index]) || isBareCount(this.tokens[index]);
  }

  private term(depth: number): Expr {
    const expr = this.termBody(depth);
    const after = this.peek();
    // A description runs to the end of its term, so this is what follows a group: `(1x [C]) [D]`.
    if (
      after !== undefined &&
      after.t !== 'and' &&
      after.t !== 'or' &&
      after.t !== 'then' &&
      !isPunct(after, ')')
    )
      throw new Failure(
        `expected \`and\`, \`,\` or \`or\` before \`${this.textOf(after)}\``,
        after.span,
      );
    return expr;
  }

  private termBody(depth: number): Expr {
    const token = this.peek();
    if (isTermWord(token)) return this.leaf(token);
    if (isBareCount(token)) return this.requirement(this.bareCount());
    if (token !== undefined && isPunct(token, '(')) return this.group(token, depth);

    const before = this.tokens[this.pos - 1];
    const where = before === undefined ? '' : ` after \`${this.textOf(before)}\``;
    if (
      token === undefined ||
      token.t === 'and' ||
      token.t === 'or' ||
      token.t === 'then' ||
      isPunct(token, ')')
    )
      throw new Failure(`expected ${TERM_EXAMPLES}${where}`, this.spanAt(this.pos));
    throw this.missingCount(token);
  }

  /**
   * Something that is not a term stands where one must start: most likely a
   * bare description. An integer never gets here unless it is too large to be
   * a count — `isBareCount` has taken every other one for a count already.
   */
  private missingCount(token: CriterionToken): Failure {
    if (token.t === 'hex')
      return new Failure(
        `\`${this.textOf(token)}\` reads as a hex code; put a space after the \`x\` of a count, as in \`0x dark monster\``,
        token.span,
      );
    return new Failure(
      'expected a count before the description, as in `1x level 4 monster`; a limit reads `at most 1x trap` or `no trap`',
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
    if (!this.startsTermHere(inside)) throw this.missingCount(first);

    if (depth >= MAX_DEPTH) throw new Failure('too many nested parentheses', open.span);
    this.next();
    const inner = this.orExpr(depth + 1);
    // As in `parseAll`: what stopped `orExpr` is a `)`, a `then` or the end.
    const stopped = this.peek();
    if (stopped?.t === 'then')
      throw new Failure(
        '`then` separates the five cards you open on from the one you draw, so it stands between them and not inside parentheses',
        stopped.span,
      );
    if (stopped === undefined) throw new Failure('this `(` is never closed', open.span);
    this.next();
    return inner;
  }

  private leaf(word: TokenOf<'count' | 'atMost' | 'no' | 'exactly'>): Expr {
    this.next();
    if (word.t === 'no') return { op: 'atMost', n: 0, desc: this.description() };
    if (word.t === 'count') return this.requirement(word);
    if (word.t === 'exactly') {
      // `exactly` names one number and means it twice, so a range after it says two things at once.
      const counted = this.countAfter('exactly', 'exactly 1x monster');
      if (counted.max !== undefined)
        throw new Failure(
          `\`exactly\` names one count: write \`exactly ${counted.n}x …\`, or make it the range \`${counted.n}-${counted.max}x …\``,
          counted.span,
        );
      return this.requirement({ ...counted, max: counted.n });
    }

    // `at most` names one ceiling, so a count there is a single number.
    const counted = this.countAfter('at most', 'at most 1x trap');
    if (counted.max !== undefined)
      throw new Failure(
        `a limit has one ceiling: write \`at most ${counted.max}x …\`, or make it the requirement \`${counted.n}-${counted.max}x …\``,
        counted.span,
      );
    return { op: 'atMost', n: this.checked(counted.n, counted.span), desc: this.description() };
  }

  /**
   * The count a keyword must be followed by. Nothing else can stand there, so
   * the `x` is optional exactly as it is at the start of a term.
   */
  private countAfter(keyword: string, example: string): TokenOf<'count'> {
    const count = this.peek();
    if (count?.t === 'count') return this.next() as TokenOf<'count'>;
    if (isBareCount(count)) return this.bareCount();
    if (count?.t === 'hex') throw this.missingCount(count);
    throw new Failure(
      `expected a count after \`${keyword}\`, as in \`${example}\``,
      this.spanAt(this.pos),
    );
  }

  /**
   * `1`, or the range `1-2`, standing where a term must start: a count whose
   * `x` was left out. The cursor is on the first integer.
   */
  private bareCount(): TokenOf<'count'> {
    const first = this.next() as TokenOf<'int'>;
    const dash = this.peek();
    const upper = this.tokens[this.pos + 1];
    if (!isPunct(dash, '-') || upper?.t !== 'int')
      return { t: 'count', n: first.value, span: first.span };
    this.next();
    this.next();
    return {
      t: 'count',
      n: first.value,
      max: upper.value,
      span: { start: first.span.start, end: upper.span.end },
    };
  }

  /** `n×`, `a-b×` or `exactly n×` already made `[n, n]`, and the description that follows it. */
  private requirement(word: TokenOf<'count'>): Expr {
    const n = this.checked(word.n, word.span);
    if (word.max === undefined) {
      if (n < 1)
        throw new Failure(
          'a requirement needs at least 1 card; to rule cards out, write `no …` or `at most 1x …`',
          word.span,
        );
      return { op: 'req', n, desc: this.description() };
    }
    const max = this.checked(word.max, word.span);
    if (max < n) throw new Failure(`a range runs low to high: write \`${max}-${n}x\``, word.span);
    return { op: 'req', n, max, desc: this.description() };
  }

  private checked(value: number, span: Span): number {
    if (value > MAX_COUNT)
      throw new Failure(`a count is at most ${MAX_COUNT}, the size of the largest deck`, span);
    return value;
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
      } else if (token.t === 'then') {
        // `then` ends the term it follows, exactly as `and` does; nothing in a
        // description's own parentheses can be the sixth card's part.
        if (depth === 0) break;
        throw new Failure(
          "`then` separates the five cards you open on from the one you draw and cannot stand inside a description's parentheses; close the `)` first",
          token.span,
        );
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
    if (!result.ok) throw new Failure(result.message + this.orCountHint(start, end), result.span);
    this.pos = end;
    return result.desc;
  }

  /**
   * After an `or`, an integer continues the description — `1x [C] or 2000 ATK
   * monster` is one slot either card fills — so a count there needs its `x`,
   * and without one the whole thing was read as a description. When that
   * description will not parse, say so: it is the likeliest thing meant.
   */
  private orCountHint(start: number, end: number): string {
    for (let at = start; at + 1 < end; at++)
      if (this.tokens[at]?.t === 'or' && isBareCount(this.tokens[at + 1]))
        return '; a count after `or` keeps its `x`, as in `or 2x monster`';
    return '';
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
 *
 * A count is `1x`, the range `1-2x`, or either with the `x` left out — but
 * only where the grammar allows nothing but a term, which is the start of the
 * text, after `and` or `,`, after a `(` that opens a group of terms, and after
 * `at most` or `exactly`. A description may itself begin with an integer
 * (`2000 ATK monster`), and the one place a description and a term can both
 * stand is after an `or`; there the `x` is what tells them apart, and a count
 * keeps it.
 *
 * `then` separates the five cards you open on from the one you draw going
 * second (PRD §5.6). It binds looser than everything else, so no parentheses
 * are ever needed around either side, and a criterion holds at most one: the
 * hand comes in two pieces, not three. A LEADING `then` leaves the opening
 * five unasked about. What follows it is about ONE card, so its requirement
 * slots are counted here — `slotsOf` counts them exactly as expansion would —
 * and `… then 2x monster` is refused with the span of what asks too much,
 * rather than scoring zero for a reason nobody can see.
 *
 * `exactly n` is sugar for the range `[n, n]` and nothing more: it parses to
 * the very node `n-nx` parses to, so no later pass can tell the two apart. It
 * belongs to requirements alone — a limit has one ceiling already, and there
 * is no census that means "exactly".
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
