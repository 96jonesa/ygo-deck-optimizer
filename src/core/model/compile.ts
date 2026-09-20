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
import { type Count, toCount } from '../util/count';
import { normalize } from '../util/normalize';
import {
  type ClassInfo,
  type CompiledCriterion,
  type CompiledRequirement,
  type HandSize,
  MAX_CLASSES,
  type Problem,
  validateProblem,
} from './problem';
import { countSums, type IntRange } from './ranges';
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

/** A requirement: `n` cards at least, and `max` at most when it was written `a-b×`. */
export interface ResolvedRange extends ResolvedCounted {
  max?: number;
}

export interface ResolvedFlat {
  reqs: ResolvedRange[];
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

/** Which column of the match matrix a description is, and in what role it was met. */
export type ColumnOf = (desc: Description, role: 'inRequirement' | 'inLimit') => number;

/**
 * Flat criteria with their descriptions replaced by match-matrix columns —
 * the one place a requirement's BOUNDS are carried across that boundary.
 * `resolveTemplate` and `analyze` both need it and index their columns
 * differently, so the indexing is the caller's and the carrying is not: a
 * second copy of this is how a ceiling goes missing between the two.
 */
export function indexFlat(flat: readonly FlatCriterion[], columnOf: ColumnOf): ResolvedFlat[] {
  return flat.map(({ reqs, limits }) => ({
    reqs: reqs.map(({ n, max, desc }) => {
      const at = columnOf(desc, 'inRequirement');
      return max === undefined ? { n, desc: at } : { n, max, desc: at };
    }),
    limits: limits.map(({ n, desc }) => ({ n, desc: columnOf(desc, 'inLimit') })),
  }));
}

export function groupLookupOf(groups: readonly TemplateGroup[]): GroupLookup {
  return {
    idOf: (name) => groups.find((group) => normalize(group.name) === normalize(name.trim()))?.id,
    nameOf: (id) => groups.find((group) => group.id === id)?.name,
    names: () => groups.map((group) => group.name),
  };
}

export function groupMembersOf(groups: readonly TemplateGroup[]): Groups {
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
 * Resolve everything symbolic in a template, once (TDD §8 step 1);
 * `compileProblem` builds classes and masks on top of the match matrix:
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
    // A generic line needs no existing card: it states what its cards are known to be, not
    // which cards exist (PRD §5.1). `count` is reported, and analyze() notes a zero.
    const count = ctx.cards.count(matcher(desc, members));
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
  const indexed = (flat: readonly FlatCriterion[]) => indexFlat(flat, column);

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

// ---------------------------------------------------------------------------
// Classes and masks (TDD §8 steps 2 and 3)
// ---------------------------------------------------------------------------

/** What `compileProblem` reads of a resolved template; `ResolvedTemplate` satisfies it. */
export interface CompileInput {
  deckSize: number;
  /** The hand size the criteria were expanded for: larger alternatives are already gone. */
  handSize: number;
  /** The template's lines in order, then the remainder — the only line whose `max` may be `null`. */
  lines: readonly { id: string; isRemainder: boolean; min: number; max: number | null }[];
  /** `matrix[line][description]`, one row per entry of `lines`. */
  matrix: readonly (readonly boolean[])[];
  flat: readonly FlatAlternative[];
}

/** What `compileCriterion` reads of one flat alternative; `ResolvedFlat` satisfies it. */
export interface FlatAlternative {
  reqs: readonly ResolvedRange[];
  limits: readonly ResolvedCounted[];
}

/** A member line of a class: its index in `CompileInput.lines`, and its range with `max: null` clamped. */
export interface CompiledLine {
  id: string;
  line: number;
  min: number;
  max: number;
}

/** `Problem.classes[i]` in detail: what it takes to expand a class total back to lines. */
export interface CompiledClassInfo {
  /** In template order; the blank class may have none. */
  lines: CompiledLine[];
  /** The range of the class total: the sum of its lines' ranges. */
  min: number;
  max: number;
  /** The match matrix row its lines share: the descriptions (columns) they fill or count against. */
  fills: number[];
}

/**
 * A limit left out of the compiled criterion because it holds of every hand:
 * `counts-nothing` — no line implies its description, so its mask is 0 — or
 * `never-binds` — its `n` is at least the largest hand.
 */
export interface DroppedLimit {
  /** Index into `CompileInput.flat` and `Problem.criteria`. */
  criterion: number;
  desc: number;
  n: number;
  reason: DroppedReason;
}

export type DroppedReason = 'counts-nothing' | 'never-binds';

/**
 * A requirement's CEILING left out for the same two reasons: no class can
 * reach it, or it is at least the largest hand and so can never be exceeded.
 * The requirement itself stays — only its ceiling goes, which makes it the
 * plain `n×` it would have been.
 */
export interface DroppedCeiling {
  criterion: number;
  desc: number;
  /** The requirement's lower bound, which is kept: enough to print `1-6x` as written. */
  n: number;
  max: number;
  reason: DroppedReason;
}

/** What one flat alternative compiled to, and the ceilings and limits that fell away doing it. */
interface CompiledAlternative {
  criterion: CompiledCriterion;
  droppedLimits: Omit<DroppedLimit, 'criterion'>[];
  droppedCeilings: Omit<DroppedCeiling, 'criterion'>[];
}

/**
 * One flat alternative as the engine judges it (TDD §8 steps 2 and 3), shared
 * by `compileProblem` and the optimizer's per-criterion `breakdown` so that
 * the two can never read a range differently.
 *
 * - a requirement becomes its LOWER bound in slots, each holding the mask of
 *   the classes that fill it;
 * - a requirement written `a-b×` also becomes a ceiling, unless the ceiling
 *   can never bind — no class reaches it, or `b` is at least `largestHand`,
 *   since a hand never holds more cards than that. A requirement with no
 *   ceiling, and one whose ceiling was dropped, puts its classes in `free`:
 *   surplus there can always be assigned, so no ceiling traps it;
 * - a limit becomes a mask, dropped on the same two grounds.
 */
export function compileCriterion(
  { reqs, limits }: FlatAlternative,
  maskOf: (desc: number) => number,
  largestHand: number,
): CompiledAlternative {
  const droppedLimits: Omit<DroppedLimit, 'criterion'>[] = [];
  const droppedCeilings: Omit<DroppedCeiling, 'criterion'>[] = [];
  const compiled = reqs.map(({ n, max, desc }): CompiledRequirement => {
    const mask = maskOf(desc);
    if (max === undefined) return { mask, min: n, max: null };
    const reason = mask === 0 ? 'counts-nothing' : max >= largestHand ? 'never-binds' : undefined;
    if (reason === undefined) return { mask, min: n, max };
    droppedCeilings.push({ desc, n, max, reason });
    return { mask, min: n, max: null };
  });
  const criterion: CompiledCriterion = {
    slots: compiled.flatMap(({ mask, min }) => new Array<number>(min).fill(mask)),
    limits: limits.flatMap(({ n, desc }) => {
      const mask = maskOf(desc);
      const reason = mask === 0 ? 'counts-nothing' : n >= largestHand ? 'never-binds' : undefined;
      if (reason === undefined) return [{ mask, n }];
      droppedLimits.push({ desc, n, reason });
      return [];
    }),
  };
  // Left out when nothing is left to say: `slots` alone is the criterion the
  // language had before ranges, and the matcher's old path judges it.
  if (compiled.some(({ max }) => max !== null)) criterion.reqs = compiled;
  return { criterion, droppedLimits, droppedCeilings };
}

export type CompileResult =
  | {
      ok: true;
      problem: Problem;
      /** Parallel to `problem.classes`. */
      classes: CompiledClassInfo[];
      /** The class of each entry of `CompileInput.lines`, the remainder last. */
      classOfLine: number[];
      droppedLimits: DroppedLimit[];
      /** Requirement ceilings the engine leaves out; the requirements themselves stay. */
      droppedCeilings: DroppedCeiling[];
    }
  | { ok: false; errors: string[] };

export interface CompileOptions {
  /** Default: the template's hand size, weight 1. A blend needs a template resolved at its LARGEST hand. */
  handSizes?: HandSize[];
}

/**
 * Classes and masks from a match matrix (TDD §8):
 *
 * 1. Lines with IDENTICAL rows are interchangeable for scoring and merge into
 *    one class, whose range is the sum of theirs. Lines with an all-false row
 *    — they fill nothing and count against nothing — form the BLANK class,
 *    index 0, which is there even when it is empty (no line, range 0–0).
 *    The remainder is a line like any other: it joins the blank class iff ITS
 *    row is all-false, which `1x card` makes untrue. Its `max: null` is the
 *    deck size (or its `min`, should that be larger: no vector then fills the
 *    deck, and the counts say 0 rather than the range being malformed).
 *    ORDER: blank first; the other classes by their first member line, in
 *    template order (the remainder being the last line). Members of a class
 *    are in template order too.
 * 2. Every flat alternative goes through `compileCriterion`: a requirement
 *    `n×` becomes `n` slots holding the mask of the classes that fill it, and
 *    a requirement `a-b×` also becomes a ceiling. A slot no class fills keeps
 *    its mask of 0: that criterion can never be met, and says so by scoring 0.
 * 3. A limit becomes the mask of the classes it counts. A limit that holds of
 *    every hand is DROPPED and listed in `droppedLimits`: one that counts
 *    nothing, and one whose `n` is at least the largest hand size. A ceiling
 *    goes the same way, into `droppedCeilings`.
 *
 * More than `MAX_CLASSES` classes, the blank class included, is an error.
 * The problem that comes back has passed `validateProblem`.
 */
export function compileProblem(input: CompileInput, opts: CompileOptions = {}): CompileResult {
  const { deckSize, lines, matrix, flat } = input;
  const handSizes = opts.handSizes ?? [{ H: input.handSize, weight: 1 }];
  const errors: string[] = [];

  const largestHand = Math.max(...handSizes.map(({ H }) => H));
  if (largestHand > input.handSize)
    errors.push(
      `a hand of ${largestHand} cannot be judged: the criteria were expanded for a hand of ${input.handSize}, and larger alternatives are already dropped — resolve the template at the largest hand size`,
    );
  for (const { id, min, max } of lines) {
    const isCount = (value: number) => Number.isInteger(value) && value >= 0;
    if (!isCount(min) || (max !== null && (!isCount(max) || min > max)))
      errors.push(
        `line ${JSON.stringify(id)}: a range is 0 <= min <= max in whole cards, not ${min} to ${max}`,
      );
  }
  if (errors.length > 0) return { ok: false, errors };

  const blank: CompiledClassInfo = { lines: [], min: 0, max: 0, fills: [] };
  const classes = [blank];
  const classOfRow = new Map<string, number>();
  const classOfLine = lines.map(({ id, min, max }, line) => {
    const row = matrix[line]!;
    const fills = row.flatMap((fill, desc) => (fill ? [desc] : []));
    const key = fills.join(',');
    let cls = fills.length === 0 ? 0 : classOfRow.get(key);
    if (cls === undefined) {
      cls = classes.length;
      classOfRow.set(key, cls);
      classes.push({ lines: [], min: 0, max: 0, fills });
    }
    const member = { id, line, min, max: max ?? Math.max(deckSize, min) };
    const into = classes[cls]!;
    into.lines.push(member);
    into.min += member.min;
    into.max += member.max;
    return cls;
  });
  if (classes.length > MAX_CLASSES)
    return {
      ok: false,
      errors: [
        `the criteria tell ${classes.length} classes of card apart, the blank class included; the engine scores at most ${MAX_CLASSES} — merge lines, or drop requirements that split them`,
      ],
    };

  const maskOf = (desc: number): number => {
    let mask = 0;
    classes.forEach(({ fills }, cls) => {
      if (fills.includes(desc)) mask |= 1 << cls;
    });
    return mask >>> 0;
  };
  const droppedLimits: DroppedLimit[] = [];
  const droppedCeilings: DroppedCeiling[] = [];
  const criteria = flat.map((alternative, criterion) => {
    const compiled = compileCriterion(alternative, maskOf, largestHand);
    for (const dropped of compiled.droppedLimits) droppedLimits.push({ criterion, ...dropped });
    for (const dropped of compiled.droppedCeilings) droppedCeilings.push({ criterion, ...dropped });
    return compiled.criterion;
  });

  const problem: Problem = {
    deckSize,
    handSizes,
    classes: classes.map(
      ({ lines: members, min, max }): ClassInfo => ({
        lineIds: members.map((member) => member.id),
        min,
        max,
      }),
    ),
    criteria,
  };
  try {
    validateProblem(problem);
  } catch (failure) {
    if (!(failure instanceof RangeError)) throw failure;
    return { ok: false, errors: [failure.message] };
  }
  return { ok: true, problem, classes, classOfLine, droppedLimits, droppedCeilings };
}

/** One class of a class-total vector, as the raw line counts it stands for (TDD §11.2). */
export interface ExpandedClass {
  cls: number;
  total: number;
  /** The ways to split `total` among the lines within their ranges; 0 when it is outside the class range. */
  splits: Count;
  /**
   * For each member line, the counts it can take while the others make up
   * the rest — `[max(min_i, t − Σ_{j≠i} max_j), min(max_i, t − Σ_{j≠i} min_j)]`,
   * every value of which IS taken by some split. Empty when `splits` is 0.
   */
  lines: { id: string; min: number; max: number }[];
  /** `3 copies of \`a\``, or `4 copies among \`a\`, \`c\` — any split`. */
  text: string;
}

function checkTotals(classes: readonly CompiledClassInfo[], classTotals: ArrayLike<number>): void {
  if (classTotals.length !== classes.length)
    throw new RangeError(
      `expected a total for each of the ${classes.length} classes, got ${classTotals.length}`,
    );
}

const copies = (total: number) => (total === 1 ? '1 copy' : `${total} copies`);

/**
 * The counts ONE line of a class can take while the class holds `total` and
 * the other lines make up the rest: at least what they cannot hold, at most
 * what they must leave — `[max(min_i, t − Σ_{j≠i} max_j), min(max_i, t − Σ_{j≠i} min_j)]`,
 * every value of which IS taken by some split (TDD §11.2). Empty (`min > max`)
 * when `total` is outside the class range. `cls` is the class range — the sum
 * of its lines' — so the others' sums need no loop.
 */
export function lineInterval(cls: IntRange, line: IntRange, total: number): IntRange {
  return {
    min: Math.max(line.min, total - (cls.max - line.max)),
    max: Math.min(line.max, total - (cls.min - line.min)),
  };
}

/**
 * What a class-total vector means in lines: a single-line class holds exactly
 * its total; a merged class holds its total "among" its lines, in any split
 * their ranges allow. `classes` is `compileProblem`'s — a `Problem` alone does
 * not keep the lines' own ranges.
 */
export function expandClassVector(
  classes: readonly CompiledClassInfo[],
  classTotals: ArrayLike<number>,
): ExpandedClass[] {
  checkTotals(classes, classTotals);
  return classes.map(({ lines, min, max }, cls) => {
    const total = classTotals[cls]!;
    const names = lines.map(({ id }) => `\`${id}\``).join(', ');
    if (lines.length === 0)
      return { cls, total, splits: total === 0 ? 1 : 0, lines: [], text: 'no cards' };
    if (total < min || total > max)
      return {
        cls,
        total,
        splits: 0,
        lines: [],
        text: `${copies(total)} ${lines.length === 1 ? 'of' : 'among'} ${names} — outside the range ${min}–${max}`,
      };
    return {
      cls,
      total,
      splits: toCount(countSums(lines, total)),
      lines: lines.map((line) => ({ id: line.id, ...lineInterval({ min, max }, line, total) })),
      text:
        lines.length === 1
          ? `${copies(total)} of ${names}`
          : `${copies(total)} among ${names} — any split`,
    };
  });
}

/**
 * How many raw line ratios map to this class vector: the product, over the
 * classes, of the ways to split the class total among its lines. Whether the
 * totals fill the deck is the caller's business.
 */
export function countRawRatios(
  classes: readonly CompiledClassInfo[],
  classTotals: ArrayLike<number>,
): Count {
  checkTotals(classes, classTotals);
  let product = 1n;
  classes.forEach(({ lines }, cls) => {
    product *= countSums(lines as readonly IntRange[], classTotals[cls]!);
  });
  return toCount(product);
}
