import type { DescContext } from '../desc/context';
import type { Span } from '../desc/lexer';
import { type Expr, MAX_SIXTH_SLOTS, slotsOf, tooManyDrawnSlots } from './ast';
import { lexCriterion } from './lexer';
import { type CriterionParseOptions, type CriterionParseResult, parseCriterion } from './parser';

// A criterion as the EDITOR writes it (PRD §5.5): up to three fields, one per
// window of the hand you draw going second, in the order the cards arrive.
//
// | field | window | the AST's part |
// | -- | -- | -- |
// | `opening` | the five cards you open on | `five` |
// | `drawn` | the cards you draw — the one for turn, and what draw cards fetch | `sixth` |
// | `text` | the whole hand | `whole`, or the whole criterion when it is alone |
//
// The fields ARE the split windows, so nothing downstream of the AST changes:
// a criterion whose only field is the whole hand is the PLAIN expression it has
// always been — not a split with a `whole` part, which would compile to a
// different problem — and any other combination is the split the keywords used
// to write. `then` and `finally` are no longer typed: the field says which
// window a part is about. They are still READ, but only out of a version 1
// template file, whose text `v1Fields` slices into the fields on load.

/** The three fields, in the order the cards arrive and the editor shows them. */
export type CriterionField = 'opening' | 'drawn' | 'text';
export const CRITERION_FIELDS = ['opening', 'drawn', 'text'] as const;

/**
 * What the readouts call each field when they name one — the words the editor's
 * labels say, and the words a printed split criterion is written with
 * (`printCriterionFields`).
 */
export const FIELD_NAMES: Record<CriterionField, string> = {
  opening: 'opening 5',
  drawn: 'drawn',
  text: 'whole hand',
};

/** What a criterion says in each field. `text` is the whole hand, and the one field every criterion has. */
export interface CriterionFieldTexts {
  opening?: string;
  drawn?: string;
  text: string;
}

/**
 * The fields a criterion fills as ONE line of the user's own text, for a
 * reader who cannot see the fields (the CLI's report, a run's breakdown): the
 * whole-hand field alone as it was typed, and otherwise each filled field named,
 * in window order — the form `printCriterionFields` prints an AST in.
 */
export function labelledFields(fields: CriterionFieldTexts): string {
  const filled = filledFields(fields);
  if (filled.length === 0 || (filled.length === 1 && filled[0] === 'text')) return fields.text;
  return filled.map((field) => `${FIELD_NAMES[field]}: ${fields[field]!.trim()}`).join(' · ');
}

/** A field left empty asks nothing: `(anything)`. */
export function fieldIsEmpty(text: string | undefined): boolean {
  return text === undefined || text.trim() === '';
}

/** The fields a criterion fills, in window order. */
export function filledFields(fields: CriterionFieldTexts): CriterionField[] {
  return CRITERION_FIELDS.filter((field) => !fieldIsEmpty(fields[field]));
}

/**
 * Whether a criterion splits the hand at all: something in the opening-5 or the
 * drawn-cards field. Only going second has those windows to split.
 */
export function splitsTheHand(fields: CriterionFieldTexts): boolean {
  return !fieldIsEmpty(fields.opening) || !fieldIsEmpty(fields.drawn);
}

/**
 * Why a keyword the fields replaced was typed into one — with the field to put
 * the words in instead, which is the whole of what the user needs to know.
 */
function keywordInField(keyword: 'then' | 'finally', field: CriterionField): string {
  if (keyword === 'then')
    return field === 'drawn'
      ? 'no `then` needed: this field is already about the cards you draw'
      : 'no `then` needed — put what the drawn cards must be in the drawn-cards field (going second, the second of the three)';
  return field === 'text'
    ? 'no `finally` needed: this field is already about the whole hand'
    : 'no `finally` needed — put what the whole hand must hold in the whole-hand field (the last of the three)';
}

/** The span of the field's words, less the spaces around them. */
function spanOfWords(text: string): Span {
  const start = text.length - text.trimStart().length;
  return { start, end: text.trimEnd().length };
}

/**
 * One field's text, parsed for its window. Never throws.
 *
 * A field is a criterion without `then` or `finally`: those are refused, with
 * the span of the keyword and the field the words belong in. The drawn-cards
 * field is bounded by `maxDrawnSlots` — the cards the drawn set can hold
 * (`largestDrawnSet`), one where nothing draws — exactly as the part after
 * `then` always was, and refused with the span of the whole field. The opening
 * and whole-hand fields are bounded as those parts always were: an alternative
 * asking more cards than its window holds is DROPPED by `expand`, and counted.
 */
export function parseCriterionField(
  field: CriterionField,
  text: string,
  ctx: DescContext,
  opts: CriterionParseOptions = {},
): CriterionParseResult {
  const lexed = lexCriterion(text);
  if (lexed.ok)
    for (const token of lexed.tokens)
      if (token.t === 'then' || token.t === 'finally')
        return { ok: false, message: keywordInField(token.t, field), span: token.span };
  const parsed = parseCriterion(text, ctx, opts);
  if (!parsed.ok || field !== 'drawn') return parsed;
  const allowed = opts.maxDrawnSlots ?? MAX_SIXTH_SLOTS;
  const slots = slotsOf(parsed.expr);
  if (slots > allowed)
    return { ok: false, message: tooManyDrawnSlots(slots, allowed), span: spanOfWords(text) };
  return parsed;
}

export type CriterionFieldsResult =
  | { ok: true; expr: Expr }
  | { ok: false; field: CriterionField; message: string; span: Span };

/**
 * The expression a criterion's fields state, and the first field in window
 * order that does not parse. Never throws.
 *
 * - Only the whole hand filled: that field's expression, PLAIN. Every criterion
 *   written before the fields, going first or going second, is this one, and it
 *   compiles to the problem it always did.
 * - Anything else: a `split` of the fields that are filled, an empty field
 *   leaving its window unasked about. With the opening five alone, the split
 *   has a `five` part only — `expand` judges it over the five you open on.
 * - Nothing filled: the whole-hand field's own parse error, which is the one an
 *   empty criterion has always had.
 */
export function parseCriterionFields(
  fields: CriterionFieldTexts,
  ctx: DescContext,
  opts: CriterionParseOptions = {},
): CriterionFieldsResult {
  const filled = filledFields(fields);
  if (filled.length === 0) {
    const empty = parseCriterionField('text', fields.text, ctx, opts);
    // `parseCriterion` fails on every text that is only spaces; kept total all the same.
    if (empty.ok) return empty;
    return { ok: false, field: 'text', message: empty.message, span: empty.span };
  }
  const parts: Partial<Record<CriterionField, Expr>> = {};
  for (const field of filled) {
    const parsed = parseCriterionField(field, fields[field]!, ctx, opts);
    if (!parsed.ok) return { ok: false, field, message: parsed.message, span: parsed.span };
    parts[field] = parsed.expr;
  }
  if (filled.length === 1 && filled[0] === 'text') return { ok: true, expr: parts.text! };
  const split: Extract<Expr, { op: 'split' }> = { op: 'split' };
  if (parts.opening !== undefined) split.five = parts.opening;
  if (parts.drawn !== undefined) split.sixth = parts.drawn;
  if (parts.text !== undefined) split.whole = parts.text;
  return { ok: true, expr: split };
}

/**
 * The part of a criterion's expression each field states: the inverse of
 * `parseCriterionFields`, used to say which field a stored AST disagrees with.
 * A plain expression is the whole-hand field's.
 */
export function exprFields(expr: Expr): Partial<Record<CriterionField, Expr>> {
  if (expr.op !== 'split') return { text: expr };
  const out: Partial<Record<CriterionField, Expr>> = {};
  if (expr.five !== undefined) out.opening = expr.five;
  if (expr.sixth !== undefined) out.drawn = expr.sixth;
  if (expr.whole !== undefined) out.text = expr.whole;
  return out;
}

/**
 * A version 1 criterion's text, laid out in the fields (TDD §14). Pure, and
 * needing no card database: the conversion redistributes TEXT, and the AST
 * stored beside it is kept as it is — it stays the authority on what the
 * criterion means, and `criterionMeaning` compares it with the fields.
 *
 * THE TRAP THIS EXISTS TO AVOID: a plain version 1 criterion is about the WHOLE
 * hand, and the opening-5 field is about the first five. So a text with no
 * `then` or `finally` goes into the whole-hand field, whatever it is tagged —
 * never into the first field, which would silently change what it means.
 *
 * Otherwise the text is cut at its keywords, keeping the user's own spelling:
 * what came before is the opening five, what follows `then` the cards drawn,
 * what follows `finally` the whole hand. A keyword stands at the top level of
 * any text that parses — the grammar refuses it anywhere else — so the pieces
 * parse to exactly the parts the whole did. A text that cannot be cut cleanly
 * (it does not lex, repeats a keyword, puts `finally` before `then`, puts one
 * inside parentheses, or leaves one with nothing after it) did not parse in
 * version 1 either, and goes whole into the whole-hand field: there it is still
 * refused, and now with a message that points at the fields.
 */
export function v1Fields(text: string): CriterionFieldTexts {
  const whole: CriterionFieldTexts = { text };
  const lexed = lexCriterion(text);
  if (!lexed.ok) return whole;
  let depth = 0;
  let then: Span | undefined;
  let fin: Span | undefined;
  for (const token of lexed.tokens) {
    if (token.t === 'punct' && token.ch === '(') depth++;
    else if (token.t === 'punct' && token.ch === ')') depth--;
    else if (token.t === 'then' || token.t === 'finally') {
      if (depth !== 0) return whole;
      if (token.t === 'then') {
        if (then !== undefined || fin !== undefined) return whole;
        then = token.span;
      } else {
        if (fin !== undefined) return whole;
        fin = token.span;
      }
    }
  }
  if (then === undefined && fin === undefined) return whole;
  const first = (then ?? fin)!;
  const opening = text.slice(0, first.start).trim();
  const drawn = then === undefined ? '' : text.slice(then.end, fin?.start ?? text.length).trim();
  const last = fin === undefined ? '' : text.slice(fin.end).trim();
  if ((then !== undefined && drawn === '') || (fin !== undefined && last === '')) return whole;
  const out: CriterionFieldTexts = { text: last };
  if (opening !== '') out.opening = opening;
  if (drawn !== '') out.drawn = drawn;
  return out;
}
