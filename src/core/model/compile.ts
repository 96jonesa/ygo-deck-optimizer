import type { CardRecord } from '../cards/record';
import type { Expr, FlatCriterion } from '../criteria/ast';
import { expand, expandAll } from '../criteria/expand';
import { parseCriterion } from '../criteria/parser';
import { printCriterion } from '../criteria/print';
import type { Description } from '../desc/ast';
import type { CardLookup, DescContext, GroupLookup, SetnameLookup } from '../desc/context';
import { type Groups, matcher } from '../desc/evaluate';
import { implies, UNIVERSE } from '../desc/implies';
import type { Span } from '../desc/lexer';
import { parse } from '../desc/parser';
import { echo, print } from '../desc/print';
import { normalize } from '../util/normalize';
import { NAMED_CARD_MAX, type Template, type TemplateGroup } from './template';

/** What resolving a template looks things up in; the real `CardIndex` and `SetnameTable` satisfy it. */
export interface ResolveContext {
  cards: CardLookup & { count(pred: (card: CardRecord) => boolean): number };
  /** `null` when the install has no `strings.conf`. */
  setnames: SetnameLookup | null;
}

export interface ResolvedLine {
  id: string;
  /** The unspecified cards: always the LAST line, with the description `card` (TDD §6.2). */
  isRemainder: boolean;
  /** As written; a picker-chosen card reads `#passcode`. */
  text: string;
  desc: Description;
  /** What was understood, for the reader (PRD §5.2). */
  echo: string;
  /** How many cards in the database match. Informative only: matching is never decided by it (TDD §6.3). */
  count: number;
  min: number;
  /** `null` is unbounded, which only the remainder can be. */
  max: number | null;
}

/** A distinct description of some requirement or limit: one column of the match matrix. */
export interface ResolvedDescription {
  /** Canonical JSON — the identity `expand` merges by. */
  key: string;
  desc: Description;
  /** Canonical text. */
  text: string;
  echo: string;
  inRequirement: boolean;
  inLimit: boolean;
  /** Indices into `lines` of the lines whose cards fill it, or count against it. */
  lines: number[];
}

/** `n×` the description at index `desc` of `descriptions`. */
export interface ResolvedCounted {
  n: number;
  desc: number;
}

export interface ResolvedFlat {
  reqs: ResolvedCounted[];
  limits: ResolvedCounted[];
}

export interface ResolvedCriterion {
  id: string;
  name?: string;
  text: string;
  expr: Expr;
  /** Canonical text of `expr`. */
  canonical: string;
  /** This criterion's own expansion, for the reader; `flat` is what is judged. */
  alternatives: ResolvedFlat[];
  dropped: number;
}

/**
 * A template with everything symbolic resolved (TDD §8 step 1): what scoring
 * needs is `deckSize`, `matrix` and `flat`; the rest is there to be shown.
 */
export interface ResolvedTemplate {
  deckSize: number;
  handSize: number;
  /** The template's lines in order, then the remainder. */
  lines: ResolvedLine[];
  descriptions: ResolvedDescription[];
  /** `matrix[line][description]`: whether the line's description IMPLIES it — the single matching relation. */
  matrix: boolean[][];
  criteria: ResolvedCriterion[];
  /** Every criterion expanded together, duplicates removed: a hand succeeds if it meets any one. */
  flat: ResolvedFlat[];
  /** Alternatives left out of `flat` for needing more cards than the hand holds. */
  dropped: number;
  warnings: string[];
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedTemplate }
  | { ok: false; errors: string[] };

export const REMAINDER_ID = 'remainder';

function groupLookupOf(groups: readonly TemplateGroup[]): GroupLookup {
  return {
    idOf: (name) => groups.find((group) => normalize(group.name) === normalize(name.trim()))?.id,
    nameOf: (id) => groups.find((group) => group.id === id)?.name,
    names: () => groups.map((group) => group.name),
  };
}

function groupMembersOf(groups: readonly TemplateGroup[]): Groups {
  return new Map(
    groups.map((group) => [group.id, new Set(group.cards.map((card) => card.passcode))]),
  );
}

/** `message (at "monstr")`: the span matters most when the text is long. */
function located(message: string, text: string, span: Span): string {
  const slice = text.slice(span.start, span.end);
  return slice === '' ? message : `${message} (at ${JSON.stringify(slice)})`;
}

/**
 * Resolve everything symbolic in a template, once (TDD §8). Minimal for M0f —
 * M1b adds classes and masks on top of the same match matrix:
 *
 * 1. every line and criterion is parsed; an error names the line or criterion
 *    by id and carries the parser's message. A line whose description matches
 *    NO card in the database is an error (PRD §5.1) — almost always a typo;
 * 2. the criteria are expanded to flat alternatives at the template's hand size
 *    — alternatives needing more cards are dropped HERE, so to judge at another
 *    hand size, resolve again with that size rather than reuse this result;
 * 3. the match matrix is `implies(line, description)` for every line — the
 *    remainder included, as the description `card` — and every distinct
 *    description of any flat criterion.
 *
 * TODO(M2g): a stored `desc` / `expr` is authoritative (TDD §14); until then
 * it is ignored and the text is parsed.
 */
export function resolveTemplate(template: Template, ctx: ResolveContext): ResolveResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const members = groupMembersOf(template.groups);
  const descCtx: DescContext = {
    cards: ctx.cards,
    setnames: ctx.setnames,
    groups: groupLookupOf(template.groups),
  };

  const lines: ResolvedLine[] = [];
  for (const line of template.lines) {
    const label = `line ${JSON.stringify(line.id)}`;
    let desc: Description;
    let text: string;
    if ('card' in line) {
      desc = { anyOf: [{ t: 'card', passcode: line.card.passcode }] };
      text = `#${line.card.passcode}`;
      if (ctx.cards.get(line.card.passcode) === undefined)
        warnings.push(
          `${label}: #${line.card.passcode} (${line.card.name}) is not in the card database; only a requirement that names it can be filled by it`,
        );
    } else {
      const parsed = parse(line.text, descCtx);
      if (!parsed.ok) {
        errors.push(`${label}: ${located(parsed.message, line.text, parsed.span)}`);
        continue;
      }
      desc = parsed.desc;
      text = line.text;
    }
    const count = ctx.cards.count(matcher(desc, members));
    if (count === 0 && 'text' in line)
      errors.push(`${label}: \`${line.text}\` matches no card in the database — check for a typo`);
    const [only] = desc.anyOf;
    if (desc.anyOf.length === 1 && only?.t === 'card' && line.max > NAMED_CARD_MAX)
      errors.push(
        `${label}: \`max\` is ${line.max}, but a deck holds at most ${NAMED_CARD_MAX} copies of one card`,
      );
    lines.push({
      id: line.id,
      isRemainder: false,
      text,
      desc,
      echo: echo(desc, descCtx),
      count,
      min: line.min,
      max: line.max,
    });
  }
  lines.push({
    id: REMAINDER_ID,
    isRemainder: true,
    text: print(UNIVERSE, descCtx),
    desc: UNIVERSE,
    echo: echo(UNIVERSE, descCtx),
    count: ctx.cards.count(() => true),
    min: template.remainder.min,
    max: template.remainder.max,
  });

  const handSize = template.hand.size;
  const parsedCriteria: { id: string; name?: string; text: string; expr: Expr }[] = [];
  for (const { id, name, text } of template.criteria) {
    const parsed = parseCriterion(text, descCtx);
    if (!parsed.ok) {
      errors.push(`criterion ${JSON.stringify(id)}: ${located(parsed.message, text, parsed.span)}`);
      continue;
    }
    parsedCriteria.push(
      name === undefined ? { id, text, expr: parsed.expr } : { id, name, text, expr: parsed.expr },
    );
  }

  const descriptions: ResolvedDescription[] = [];
  const columnOf = new Map<string, number>();
  const column = (desc: Description, role: 'inRequirement' | 'inLimit'): number => {
    // `expand` hands back canonical descriptions, so their JSON is their identity.
    const key = JSON.stringify(desc);
    let at = columnOf.get(key);
    if (at === undefined) {
      at = descriptions.length;
      columnOf.set(key, at);
      descriptions.push({
        key,
        desc,
        text: print(desc, descCtx),
        echo: echo(desc, descCtx),
        inRequirement: false,
        inLimit: false,
        lines: [],
      });
    }
    descriptions[at]![role] = true;
    return at;
  };
  const indexed = (flat: readonly FlatCriterion[]): ResolvedFlat[] =>
    flat.map(({ reqs, limits }) => ({
      reqs: reqs.map(({ n, desc }) => ({ n, desc: column(desc, 'inRequirement') })),
      limits: limits.map(({ n, desc }) => ({ n, desc: column(desc, 'inLimit') })),
    }));

  const criteria: ResolvedCriterion[] = [];
  for (const criterion of parsedCriteria) {
    const expanded = expand(criterion.expr, { maxHandSize: handSize });
    if (!expanded.ok) {
      errors.push(`criterion ${JSON.stringify(criterion.id)}: ${expanded.message}`);
      continue;
    }
    criteria.push({
      ...criterion,
      canonical: printCriterion(criterion.expr, descCtx),
      alternatives: indexed(expanded.flat),
      dropped: expanded.dropped,
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const all = expandAll(
    parsedCriteria.map((criterion) => criterion.expr),
    { maxHandSize: handSize },
  );
  if (!all.ok) return { ok: false, errors: [all.message] };
  const flat = indexed(all.flat);

  const impliesCtx = { cards: ctx.cards, groups: members };
  const matrix = lines.map((line) =>
    descriptions.map((description) => implies(line.desc, description.desc, impliesCtx)),
  );
  matrix.forEach((row, line) => {
    row.forEach((fills, at) => {
      if (fills) descriptions[at]!.lines.push(line);
    });
  });

  if (all.dropped > 0)
    warnings.push(
      `${all.dropped} alternative(s) need more than the ${handSize} cards of a hand and can never be met`,
    );
  if (flat.length === 0) warnings.push('no criterion can ever be met: every hand fails');
  for (const description of descriptions)
    if (description.inRequirement && description.lines.length === 0)
      warnings.push(`no line fills the requirement \`${description.text}\``);

  return {
    ok: true,
    resolved: {
      deckSize: template.deckSize,
      handSize,
      lines,
      descriptions,
      matrix,
      criteria,
      flat,
      dropped: all.dropped,
      warnings,
    },
  };
}
