import type { Description } from '../desc/ast';
import { validateDescription } from '../desc/validate';
import { canonicalizeExpr, type Expr, MAX_COUNT } from './ast';

// Checking a criterion AST that came from outside (TDD §14) — the `expr` beside
// a criterion's text, as `validateDescription` checks the `desc` beside a
// line's. Structural only: whether the criterion can ever be met is `expand`'s
// and `analyze`'s business, and an alternative needing more cards than a hand
// holds is dropped there, not refused here.

/** The parser's own nesting cap (`src/core/criteria/parser.ts`), applied to a stored AST. */
export const MAX_EXPR_DEPTH = 32;

export type ValidateExprResult = { ok: true; expr: Expr } | { ok: false; errors: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
}

class ExprValidator {
  readonly errors: string[] = [];

  fail(message: string): undefined {
    this.errors.push(message);
    return undefined;
  }

  count(where: string, field: 'n' | 'max', value: unknown): number | undefined {
    if (isCount(value)) return value;
    return this.fail(
      `${where}: \`${field}\` must be a whole number from 0 to ${MAX_COUNT}, not ${show(value)}`,
    );
  }

  /** The leaf's description, with the validator's messages located inside the expression. */
  desc(where: string, value: unknown): Description | undefined {
    const result = validateDescription(value, `${where}.desc`);
    if (result.ok) return result.desc;
    for (const message of result.errors) this.errors.push(message);
    return undefined;
  }

  expr(where: string, value: unknown, depth: number): Expr | undefined {
    if (!isObject(value))
      return this.fail(`${where}: must be an expression object, not ${show(value)}`);
    if (depth > MAX_EXPR_DEPTH)
      return this.fail(
        `${where}: nested more than ${MAX_EXPR_DEPTH} deep; no criterion is written that way`,
      );

    switch (value.op) {
      case 'and':
      case 'or': {
        const op = value.op;
        if (!Array.isArray(value.args))
          return this.fail(`${where}: \`args\` must be a list, not ${show(value.args)}`);
        if (value.args.length === 0)
          return this.fail(`${where}: \`${op}\` needs at least one argument`);
        const args = value.args.map((arg, i) => this.expr(`${where}.args[${i}]`, arg, depth + 1));
        return args.some((arg) => arg === undefined) ? undefined : { op, args: args as Expr[] };
      }
      case 'atMost': {
        const desc = this.desc(where, value.desc);
        const n = this.count(where, 'n', value.n);
        if (value.max !== undefined)
          this.fail(`${where}: a limit has no \`max\`; \`at most n\` is the ceiling`);
        if (value.unique !== undefined)
          this.fail(`${where}: a limit counts copies and has no \`unique\``);
        return n === undefined || desc === undefined ? undefined : { op: 'atMost', n, desc };
      }
      case 'req': {
        const desc = this.desc(where, value.desc);
        const n = this.count(where, 'n', value.n);
        let max: number | undefined;
        if (value.max !== undefined) {
          const ceiling = this.count(where, 'max', value.max);
          if (ceiling !== undefined && n !== undefined && ceiling < n)
            this.fail(
              `${where}: \`max\` ${ceiling} is less than \`n\` ${n}; a range requirement counts up`,
            );
          else max = ceiling;
        }
        // `unique` is `true` or absent — never `false`, which would stringify
        // differently from the absent key every other AST carries — and it is a
        // floor on different cards, so it takes neither a ceiling nor a count of 0.
        let unique = false;
        if (value.unique !== undefined) {
          if (value.unique !== true)
            this.fail(`${where}: \`unique\` is \`true\` or left out, not ${show(value.unique)}`);
          else if (value.max !== undefined)
            this.fail(
              `${where}: a \`unique\` requirement takes no \`max\`; it asks for at least \`n\` different cards`,
            );
          else if (n === 0)
            this.fail(`${where}: a \`unique\` requirement asks for at least 1 card, not 0`);
          else unique = true;
        }
        if (n === undefined || desc === undefined) return undefined;
        if (unique) return { op: 'req', n, unique: true, desc };
        return max === undefined ? { op: 'req', n, desc } : { op: 'req', n, max, desc };
      }
      case 'split': {
        // The root and nowhere else: a hand comes in three windows at most, and
        // a `split` under an `and` would be asking which five of which five.
        // The same check keeps a `then` or a `finally` out of a `finally` part,
        // which is refused for the same reason and in the same words.
        if (depth > 0)
          return this.fail(
            `${where}: \`split\` is the whole of a criterion — the cards you open on, then the cards you draw, finally the whole hand — and cannot stand inside \`and\`, \`or\` or another \`split\``,
          );
        // A split with NEITHER dealt-window part nor a whole-hand part says
        // nothing: no text writes it, and it would read as a criterion met by
        // every hand rather than as the mistake it is.
        if (value.sixth === undefined && value.whole === undefined)
          return this.fail(
            `${where}: a \`split\` needs a \`sixth\` (what you drew) or a \`whole\` (the whole hand), or both — with neither it asks nothing`,
          );
        const parts = {
          five:
            value.five === undefined
              ? undefined
              : this.expr(`${where}.five`, value.five, depth + 1),
          sixth:
            value.sixth === undefined
              ? undefined
              : this.expr(`${where}.sixth`, value.sixth, depth + 1),
          whole:
            value.whole === undefined
              ? undefined
              : this.expr(`${where}.whole`, value.whole, depth + 1),
        };
        // HOW MANY CARDS `then` may ask for is not a question about this
        // expression: it is one about the TEMPLATE, since draw cards make the
        // drawn set larger than one card (`largestDrawnSet`). So it is left to
        // the parser — which is given the template's bound and can point at the
        // text — and to `expand`, which refuses it for the run. Exactly the
        // reason `stop` is read here whether or not anything draws: what a file
        // may SAY is a different question from what a template makes of it.
        const out: Extract<Expr, { op: 'split' }> = { op: 'split' };
        for (const key of ['five', 'sixth', 'whole'] as const) {
          if (value[key] === undefined) continue;
          const part = parts[key];
          if (part === undefined) return undefined;
          out[key] = part;
        }
        return out;
      }
      default:
        return this.fail(
          `${where}: \`op\` must be "and", "or", "req", "atMost" or "split", not ${show(value.op)}`,
        );
    }
  }
}

/**
 * An `Expr` read out of a template file or an IPC payload (TDD §14), every
 * problem reported and each message located inside the expression. What comes
 * back is the canonical form — descriptions canonical, an `and` inside an `and`
 * spliced — so that a stored AST and a fresh parse of the text beside it can be
 * compared by stringifying both.
 */
export function validateExpr(value: unknown, where: string): ValidateExprResult {
  const v = new ExprValidator();
  const expr = v.expr(where, value, 0);
  if (v.errors.length > 0 || expr === undefined)
    return {
      ok: false,
      errors: v.errors.length > 0 ? v.errors : [`${where}: is not an expression`],
    };
  return { ok: true, expr: canonicalizeExpr(expr) };
}
