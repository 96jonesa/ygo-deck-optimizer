import type { DescContext } from '../desc/context';
import { print } from '../desc/print';
import { type Counted, canonicalizeExpr, type Expr } from './ast';
import { CRITERION_FIELDS, type CriterionField, exprFields, FIELD_NAMES } from './fields';

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

/**
 * A requirement's count, `x` always written: `1x` for no ceiling, `1-2x` for a
 * range, and `exactly 2x` for a range whose ends agree. `[2, 2]` is never
 * `2x` — one has a ceiling and the other has none — and `exactly 2x` says
 * which it is in words, which is the point of the shorthand: this text is what
 * every readout, every CLI report and every saved template shows.
 *
 * A `unique` requirement reads `3x unique`, `exactly 2x unique` or `2-3x
 * unique`: the word after the count, where it was typed.
 */
export function countPrefix(n: number, max: number | undefined, unique?: boolean): string {
  const count = max === undefined ? `${n}x` : max === n ? `exactly ${n}x` : `${n}-${max}x`;
  return unique === true ? `${count} unique` : count;
}

function printExpr(expr: Expr, ctx: PrintContext): string {
  switch (expr.op) {
    case 'req':
      return printCounted(countPrefix(expr.n, expr.max, expr.unique), expr, ctx);
    case 'atMost':
      return printCounted(expr.n === 0 ? 'no' : `at most ${expr.n}x`, expr, ctx);
    case 'or':
      return expr.args.map((arg) => printExpr(arg, ctx)).join(' or ');
    case 'and':
      // `and` binds tighter than `or`, so an `or` inside it is the one place parentheses are needed.
      return expr.args
        .map((arg) => (arg.op === 'or' ? `(${printExpr(arg, ctx)})` : printExpr(arg, ctx)))
        .join(' and ');
    case 'split': {
      // `then` binds looser than `and` and `or` both, `finally` looser still,
      // and a criterion holds at most one of each — so no part ever needs
      // parentheses to read back as itself, and writing them in window order is
      // the whole of printing a split.
      const parts: string[] = [];
      if (expr.five !== undefined) parts.push(printExpr(expr.five, ctx));
      if (expr.sixth !== undefined) parts.push(`then ${printExpr(expr.sixth, ctx)}`);
      if (expr.whole !== undefined) parts.push(`finally ${printExpr(expr.whole, ctx)}`);
      return parts.join(' ');
    }
  }
}

/**
 * The canonical text of a criterion (TDD §7.1): `parseCriterion` of it is
 * `canonicalizeExpr(expr)` for every `expr` the grammar can express — counts
 * within their ranges, descriptions the description grammar can express, and
 * no `and` / `or` without arguments, which prints as nothing. Terms are
 * joined by `and`, alternatives by `or`, and `at most 0x` reads `no`. A split
 * criterion writes its parts in WINDOW order — the cards opened on, `then` the
 * cards drawn, `finally` the whole hand — leaving out those it does not have,
 * so a split with no five-card part leads with its separator.
 */
export function printCriterion(expr: Expr, ctx: PrintContext): string {
  return printExpr(canonicalizeExpr(expr), ctx);
}

/**
 * The canonical text of each FIELD a criterion's expression fills (PRD §5.5):
 * what the editor shows under a field whose typed text reads differently. A
 * plain expression is the whole-hand field's.
 */
export function printFields(
  expr: Expr,
  ctx: PrintContext,
): Partial<Record<CriterionField, string>> {
  const parts = exprFields(canonicalizeExpr(expr));
  const out: Partial<Record<CriterionField, string>> = {};
  for (const field of CRITERION_FIELDS) {
    const part = parts[field];
    if (part !== undefined) out[field] = printExpr(part, ctx);
  }
  return out;
}

/**
 * A criterion as one line of text for a reader who cannot see the fields — a
 * readout, a stale-AST warning, the CLI's report. A plain criterion is its
 * canonical text, as it always was; a split one names each field it fills, in
 * window order: `opening 5: 1x A · drawn: no trap · whole hand: at most 1x B`.
 *
 * Not `printCriterion`, whose split text is the version 1 keyword form and is
 * kept because the parser still reads it (`parseCriterion` of it is the AST).
 * This is for reading, and nothing parses it back.
 */
export function printCriterionFields(expr: Expr, ctx: PrintContext): string {
  if (expr.op !== 'split') return printCriterion(expr, ctx);
  const fields = printFields(expr, ctx);
  return CRITERION_FIELDS.filter((field) => fields[field] !== undefined)
    .map((field) => `${FIELD_NAMES[field]}: ${fields[field]}`)
    .join(' · ');
}
