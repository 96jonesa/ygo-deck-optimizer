import { canonicalizeExpr, type Expr } from '../criteria/ast';
import { parseCriterion } from '../criteria/parser';
import { printCriterion } from '../criteria/print';
import { canonicalize, type Description } from '../desc/ast';
import type { DescContext } from '../desc/context';
import type { Span } from '../desc/lexer';
import { parse } from '../desc/parser';
import { print } from '../desc/print';
import type { TemplateCriterion, TemplateLine } from './template';

// What a line and a criterion MEAN (TDD §14). One answer, used by `analyze`
// and by `resolveTemplate` alike: the two must never disagree about what is
// being judged, and a second copy of this rule is how they would.
//
// **The stored AST is authoritative; the text is kept for editing.** A file
// written by an older build still means what it meant, however the grammar has
// moved on — and when the text no longer reads as the AST beside it, the line
// is FLAGGED rather than quietly re-read.
//
// The other half of that rule lives in the editor: every transform that
// changes a line's or criterion's text drops the AST stored with it
// (`withLineText`, `withCriterionText`). The two halves are a pair. Without
// the drop, typing would change the text and change nothing that runs; without
// the authority here, a file whose text no longer parses would lose its
// meaning. A test on either side pins the pair.

/** A stale AST is flagged, never silently replaced: `stale` is the sentence that says so. */
export type Meaning<T> =
  | ({ ok: true; stale: string | null } & T)
  | { ok: false; message: string; span: Span };

export type LineMeaning = Meaning<{ desc: Description }>;
export type CriterionMeaning = Meaning<{ expr: Expr }>;

/** `a and b are the same value`, for two ASTs the printer puts in one fixed key order. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function staleText(what: 'line' | 'criterion', saved: string, reads: string | null): string {
  const head = `this ${what} means the saved ${what === 'line' ? 'description' : 'expression'} \`${saved}\``;
  const tail =
    reads === null
      ? 'no longer parses'
      : `now reads as \`${reads}\`. Editing the text replaces the saved one.`;
  return `${head}; the text beside it ${tail}`;
}

/**
 * The description a template line states. A picker-chosen card is the card it
 * names; a description line is its stored AST when it has one, and its text
 * otherwise. What comes back is canonical, so two lines that say the same
 * thing key the match matrix to one column.
 */
export function lineMeaning(line: TemplateLine, ctx: DescContext): LineMeaning {
  if ('card' in line)
    return {
      ok: true,
      desc: { anyOf: [{ t: 'card', passcode: line.card.passcode }] },
      stale: null,
    };

  const parsed = parse(line.text, ctx);
  if (line.desc === undefined) {
    return parsed.ok
      ? { ok: true, desc: canonicalize(parsed.desc), stale: null }
      : { ok: false, message: parsed.message, span: parsed.span };
  }

  const desc = canonicalize(line.desc);
  if (parsed.ok && same(canonicalize(parsed.desc), desc)) return { ok: true, desc, stale: null };
  const reads = parsed.ok ? print(parsed.desc, ctx) : null;
  const message = staleText('line', print(desc, ctx), reads);
  return {
    ok: true,
    desc,
    stale: parsed.ok ? message : `${message} (${parsed.message})`,
  };
}

/** The expression a criterion states, by the same rule as `lineMeaning`. */
export function criterionMeaning(criterion: TemplateCriterion, ctx: DescContext): CriterionMeaning {
  const parsed = parseCriterion(criterion.text, ctx);
  if (criterion.expr === undefined) {
    return parsed.ok
      ? { ok: true, expr: canonicalizeExpr(parsed.expr), stale: null }
      : { ok: false, message: parsed.message, span: parsed.span };
  }

  const expr = canonicalizeExpr(criterion.expr);
  if (parsed.ok && same(canonicalizeExpr(parsed.expr), expr))
    return { ok: true, expr, stale: null };
  const reads = parsed.ok ? printCriterion(parsed.expr, ctx) : null;
  const message = staleText('criterion', printCriterion(expr, ctx), reads);
  return {
    ok: true,
    expr,
    stale: parsed.ok ? message : `${message} (${parsed.message})`,
  };
}
