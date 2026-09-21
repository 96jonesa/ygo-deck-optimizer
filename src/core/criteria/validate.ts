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
        if (n === undefined || desc === undefined) return undefined;
        return max === undefined ? { op: 'req', n, desc } : { op: 'req', n, max, desc };
      }
      case 'split': {
        // The root and nowhere else: a hand comes in two pieces, and a `split`
        // under an `and` would be asking which five of which five.
        if (depth > 0)
          return this.fail(
            `${where}: \`split\` is the whole of a criterion — the five cards you open on, then the one you draw — and cannot stand inside \`and\`, \`or\` or another \`split\``,
          );
        const sixth = this.expr(`${where}.sixth`, value.sixth, depth + 1);
        const five =
          value.five === undefined ? undefined : this.expr(`${where}.five`, value.five, depth + 1);
        if (sixth === undefined || (value.five !== undefined && five === undefined))
          return undefined;
        // HOW MANY CARDS `then` may ask for is not a question about this
        // expression: it is one about the TEMPLATE, since draw cards make the
        // drawn set larger than one card (`largestDrawnSet`). So it is left to
        // the parser — which is given the template's bound and can point at the
        // text — and to `expand`, which refuses it for the run. Exactly the
        // reason `stop` is read here whether or not anything draws: what a file
        // may SAY is a different question from what a template makes of it.
        return five === undefined ? { op: 'split', sixth } : { op: 'split', five, sixth };
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
