import type { DescContext } from '../desc/context';
import { print } from '../desc/print';
import { type Counted, canonicalizeExpr, type Expr } from './ast';

type PrintContext = Pick<DescContext, 'setnames' | 'groups'>;

/**
 * A description-level `or` is ALWAYS parenthesized — `1x (#1 or #2)` — so
 * that no reader, and no re-parse, can take it for the criterion-level `or`
 * of `1x #1 or 2x #2` (PRD §5.3).
 */
function printCounted(prefix: string, { desc }: Counted, ctx: PrintContext): string {
  const text = print(desc, ctx);
  return `${prefix} ${desc.anyOf.length > 1 ? `(${text})` : text}`;
}

function printExpr(expr: Expr, ctx: PrintContext): string {
  switch (expr.op) {
    case 'req':
      return printCounted(`${expr.n}x`, expr, ctx);
    case 'atMost':
      return printCounted(expr.n === 0 ? 'no' : `at most ${expr.n}x`, expr, ctx);
    case 'or':
      return expr.args.map((arg) => printExpr(arg, ctx)).join(' or ');
    case 'and':
      // `and` binds tighter than `or`, so an `or` inside it is the one place parentheses are needed.
      return expr.args
        .map((arg) => (arg.op === 'or' ? `(${printExpr(arg, ctx)})` : printExpr(arg, ctx)))
        .join(' and ');
  }
}

/**
 * The canonical text of a criterion (TDD §7.1): `parseCriterion` of it is
 * `canonicalizeExpr(expr)` for every `expr` the grammar can express — counts
 * within their ranges, descriptions the description grammar can express, and
 * no `and` / `or` without arguments, which prints as nothing. Terms are
 * joined by `and`, alternatives by `or`, and `at most 0x` reads `no`.
 */
export function printCriterion(expr: Expr, ctx: PrintContext): string {
  return printExpr(canonicalizeExpr(expr), ctx);
}
