import type { CardRecord } from '../cards/record';
import type { Expr, FlatCriterion } from '../criteria/ast';
import { expand, expandAll } from '../criteria/expand';
import { printCriterion } from '../criteria/print';
import type { Description } from '../desc/ast';
import type { CardLookup, DescContext, GroupLookup, SetnameLookup } from '../desc/context';
import { type Groups, matcher } from '../desc/evaluate';
import { implies, UNIVERSE } from '../desc/implies';
import type { Span } from '../desc/lexer';
import { echo, print } from '../desc/print';
import { type Count, toCount } from '../util/count';
import { normalize } from '../util/normalize';
import { criterionMeaning, lineMeaning } from './meaning';
import {
  type ClassInfo,
  type CompiledCriterion,
  type CompiledRequirement,
  type DrawClass,
  type DrawSpec,
  type HandSize,
  isSplit,
  largestDrawnSet,
  largestHand,
  MAX_CLASSES,
  type Problem,
  type SixthCard,
  validateProblem,
} from './problem';
import { countSums, type IntRange } from './ranges';
import {
  type CriterionWhen,
  countsFor,
  NAMED_CARD_MAX,
  partsOfMode,
  type RunMode,
  splitNeedsSecond,
  stopsFor,
  type Template,
  type TemplateGroup,
  weightOf,
  whenOf,
} from './template';

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
  /** Set when the line's cards DRAW (PRD §5.7). */
  draw?: DrawSpec;
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

/** One side of a resolved alternative: requirements and limits over columns. */
export interface ResolvedSide {
  reqs: ResolvedRange[];
  limits: ResolvedCounted[];
}

export interface ResolvedFlat extends ResolvedSide {
  /**
   * The SIXTH CARD's own part (PRD §5.6). Present: `reqs` and `limits` are then
   * about the five cards opened on, and this about the one drawn. Absent: the
   * alternative is judged over the whole hand, as every alternative was before.
   */
  sixth?: ResolvedSide;
  /**
   * The WHOLE HAND's own part — what `finally` writes (PRD §5.5). Present: `reqs`
   * and `limits` are about the cards opened on, as they are when `sixth` is, and
   * this is about the whole hand. Absent: nothing is asked of the whole hand as
   * such.
   */
  whole?: ResolvedSide;
  /** An alternative the player would STOP for: met by the opening, nothing is drawn (PRD §5.7). */
  stop?: true;
  /**
   * What a hand meeting this alternative is WORTH (PRD §5.6). Absent is 1, and
   * is what every alternative of a template that does not weight its criteria
   * carries — such a template compiles to the problem it always did.
   *
   * An alternative that several criteria produced is worth the HIGHEST of their
   * weights: meeting it means meeting each of them, and a hand is worth the best
   * thing it does. `expandAll` merges duplicates across criteria and says which
   * criteria each one came from, which is where this comes from.
   */
  weight?: number;
}

export interface ResolvedCriterion {
  id: string;
  name?: string;
  text: string;
  expr: Expr;
  /** Which hand it is judged for, defaulted: `both` unless the template says otherwise. */
  when: CriterionWhen;
  /**
   * What meeting it is worth, defaulted: 1 unless the template weights its
   * criteria and gives this one a weight of its own (`weightOf`).
   */
  weight: number;
  /** Whether the player would STOP for it, defaulted (`stopsFor`). */
  stop: boolean;
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
  /** The OPENING hand: 5 going first, 6 going second. */
  handSize: number;
  /**
   * The largest hand the criteria were expanded for: `handSize` without draw
   * cards, and the hand they can build with them (`largestHand`). It is what
   * `compileProblem` holds the run to, and what a dropped alternative was
   * dropped against.
   */
  judgedHand: number;
  /** The template's lines in order, then the remainder. */
  lines: ResolvedLine[];
  descriptions: ResolvedDescription[];
  /** `matrix[line][description]`: whether the line's description IMPLIES it — the single matching relation. */
  matrix: boolean[][];
  criteria: ResolvedCriterion[];
  /** Every criterion expanded together, duplicates removed: a hand succeeds if it meets any one. */
  flat: ResolvedFlat[];
  /**
   * Parallel to `flat`: the `criteria` each alternative came from
   * (`expandAll`'s `sources`). It is what `handSizesForMode` selects a part's
   * alternatives by, and so — through the union of the parts — what decides
   * which alternatives `compileProblem` builds classes from at all.
   */
  flatSources: number[][];
  /** Alternatives left out of `flat` for needing more cards than the hand holds. */
  dropped: number;
  /** Whether the template weights its criteria at all (`criterionWeights`). */
  weighted: boolean;
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
export function indexFlat(
  flat: readonly FlatCriterion[],
  columnOf: ColumnOf,
  /** What alternative `at` is worth; the default leaves every one unweighted. */
  weightOf: (at: number) => number | undefined = () => undefined,
  /**
   * Whether alternative `at` is one the player would STOP for (PRD §5.7). Like
   * `weightOf` it comes from the CRITERIA an alternative was produced by — the
   * OR of theirs, where the weight is the maximum: a hand meeting the
   * alternative meets each of them, so one of them stopping is enough.
   */
  stopOf: (at: number) => boolean = () => false,
): ResolvedFlat[] {
  const side = ({ reqs, limits }: Pick<FlatCriterion, 'reqs' | 'limits'>): ResolvedSide => ({
    reqs: reqs.map(({ n, max, desc }) => {
      const column = columnOf(desc, 'inRequirement');
      return max === undefined ? { n, desc: column } : { n, max, desc: column };
    }),
    limits: limits.map(({ n, desc }) => ({ n, desc: columnOf(desc, 'inLimit') })),
  });
  return flat.map(({ reqs, limits, sixth, whole }, at) => {
    const indexed: ResolvedFlat = side({ reqs, limits });
    // Every window's descriptions are columns of the SAME match matrix: a
    // class has to tell apart every description any criterion mentions,
    // wherever in the criterion it stands.
    if (sixth !== undefined) indexed.sixth = side(sixth);
    if (whole !== undefined) indexed.whole = side(whole);
    // Whether the player would stop for it travels with it, for the reason its
    // bounds do: a second copy of this rule is how it goes missing.
    if (stopOf(at)) indexed.stop = true;
    const weight = weightOf(at);
    // Left out when it is 1, so an unweighted template is byte for byte what it was.
    if (weight !== undefined && weight !== 1) indexed.weight = weight;
    return indexed;
  });
}

/**
 * What the criteria of `template` weigh, by index (PRD §5.6).
 *
 * Weighting is a template-wide SWITCH, and it is the whole of the difference:
 * with it off the weights are not read at all, so a template that once weighted
 * its criteria and no longer does scores exactly as it would have if they had
 * never been written — and one that never did is untouched by any of this. With
 * it on, a criterion that says nothing about its weight is worth 1.
 *
 * The switch decides how the answer READS as well, and that is why it is a
 * switch and not "some weight differs": with weighting on, the headline is an
 * expected weight per hand, even where every criterion happens to be worth 1
 * and that expectation is the probability. One setting, one reading.
 */
export function criterionWeights(template: Pick<Template, 'weighted' | 'criteria'>): number[] {
  return template.criteria.map((criterion) =>
    template.weighted === true ? weightOf(criterion) : 1,
  );
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
 * What a line or criterion MEANS is `lineMeaning` / `criterionMeaning` and not
 * a parse of its own: a stored AST is authoritative (TDD §14), and `analyze`
 * has to judge the very thing this compiles.
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
    const meant = lineMeaning(line, descCtx);
    if (!meant.ok) {
      errors.push(
        `${label}: ${located(meant.message, 'text' in line ? line.text : '', meant.span)}`,
      );
      continue;
    }
    const { desc } = meant;
    const text = 'card' in line ? `#${line.card.passcode}` : line.text;
    if ('card' in line && ctx.cards.get(line.card.passcode) === undefined)
      warnings.push(
        `${label}: #${line.card.passcode} (${line.card.name}) is not in the card database; only a requirement that names it can be filled by it`,
      );
    if (meant.stale !== null) warnings.push(`${label}: ${meant.stale}`);
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
      // What a line DRAWS travels with it into the classes, where it is part of
      // the class key: a draw line is never merged into the blank class.
      ...(line.draw === undefined ? {} : { draw: line.draw }),
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
  // The largest hand a criterion will be held against. Draw cards make it
  // larger than the hand size, and a criterion asking for more than the opening
  // holds is then perfectly satisfiable — so it is this, and not `handSize`,
  // that decides what `expand` drops and what a ceiling can bind against.
  //
  // Read off the LINES rather than off the classes, which do not exist yet: the
  // two agree, since once-per-turn lines never merge and the rest contribute
  // `(n − 1) · max` whether their maxima are summed before or after.
  const templateDraws = template.lines.flatMap(({ draw, max }, at) =>
    draw === undefined ? [] : [{ cls: at, max, ...draw }],
  );
  const judgedHand = largestHand(handSize, templateDraws);
  // What `then` may ask for: the card drawn for turn, and everything the draw
  // cards fetch (PRD §5.7). One card where nothing draws, which is the bound
  // every template had before them.
  const maxDrawnSlots = largestDrawnSet(handSize, templateDraws);
  const weights = criterionWeights(template);
  const weighted = template.weighted === true;
  const parsedCriteria: {
    id: string;
    name?: string;
    text: string;
    expr: Expr;
    when: CriterionWhen;
    weight: number;
    stop: boolean;
  }[] = [];
  // Parsing may drop a criterion, so the weights are carried on the entries
  // that survive rather than looked up by position afterwards.
  template.criteria.forEach((criterion, at) => {
    const { id, name, text } = criterion;
    const meant = criterionMeaning(criterion, descCtx, { maxDrawnSlots });
    if (!meant.ok) {
      errors.push(`criterion ${JSON.stringify(id)}: ${located(meant.message, text, meant.span)}`);
      return;
    }
    if (meant.stale !== null) warnings.push(`criterion ${JSON.stringify(id)}: ${meant.stale}`);
    const when = whenOf(criterion);
    if (meant.expr.op === 'split' && when !== 'second')
      errors.push(`criterion ${JSON.stringify(id)}: ${splitNeedsSecond(when)}`);
    const weight = weights[at]!;
    const stop = stopsFor(criterion);
    parsedCriteria.push(
      name === undefined
        ? { id, text, expr: meant.expr, when, weight, stop }
        : { id, name, text, expr: meant.expr, when, weight, stop },
    );
  });

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
  const indexed = (flat: readonly FlatCriterion[], stop: boolean) =>
    indexFlat(
      flat,
      column,
      () => undefined,
      () => stop,
    );

  const criteria: ResolvedCriterion[] = [];
  for (const criterion of parsedCriteria) {
    const expanded = expand(criterion.expr, {
      maxHandSize: judgedHand,
      maxOpenedSize: handSize - 1,
      maxDrawnSlots,
    });
    if (!expanded.ok) {
      errors.push(`criterion ${JSON.stringify(criterion.id)}: ${expanded.message}`);
      continue;
    }
    criteria.push({
      ...criterion,
      canonical: printCriterion(criterion.expr, descCtx),
      alternatives: indexed(expanded.flat, criterion.stop),
      dropped: expanded.dropped,
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const all = expandAll(
    parsedCriteria.map((criterion) => criterion.expr),
    { maxHandSize: judgedHand, maxOpenedSize: handSize - 1, maxDrawnSlots },
  );
  if (!all.ok) return { ok: false, errors: [all.message] };
  // An alternative several criteria produced is worth the HIGHEST of their
  // weights, and is stopped for if ANY of them stops: a hand meeting it meets
  // each of them at once.
  const flat = indexFlat(
    all.flat,
    column,
    (at) => all.sources[at]!.reduce((most, who) => Math.max(most, parsedCriteria[who]!.weight), 0),
    (at) => all.sources[at]!.some((who) => parsedCriteria[who]!.stop),
  );

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
      `${all.dropped} alternative(s) need more than the ${judgedHand} cards of a hand and can never be met`,
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
      judgedHand,
      lines,
      descriptions,
      matrix,
      criteria,
      flat,
      flatSources: all.sources,
      dropped: all.dropped,
      weighted,
      warnings,
    },
  };
}

/**
 * The hand sizes a MODE scores, each with the flat alternatives it is judged
 * against (PRD §5.5) — the whole of what tells the three modes apart.
 *
 * - `first`   — a hand of five over the criteria tagged `first` or `both`;
 * - `second`  — a hand of six over those tagged `second` or `both`;
 * - `average` — both, weighted 1 : 1.
 *
 * `weights` overrides the 1 : 1 of an average (the CLI's `--blend 3:2`).
 *
 * `compileProblem` reads the UNION of these lists as the criteria the run
 * judges, and builds its classes from those alone. So a single mode is
 * compiled to exactly the problem it would have been had the other hand's
 * criteria never been written, and an average — which judges every criterion —
 * to the union of both sets, where a class vector must mean one deck to both
 * of its parts.
 */
export function handSizesForMode(
  resolved: Pick<ResolvedTemplate, 'criteria' | 'flatSources'>,
  mode: RunMode,
  weights: readonly number[] = [],
): HandSize[] {
  return partsOfMode(mode).map(
    (part, at): HandSize => ({
      H: part === 'first' ? 5 : 6,
      weight: weights[at] ?? 1,
      criteria: resolved.flatSources.flatMap((sources, alternative) =>
        sources.some((criterion) => countsFor(resolved.criteria[criterion]!.when, part))
          ? [alternative]
          : [],
      ),
    }),
  );
}

// ---------------------------------------------------------------------------
// Classes and masks (TDD §8 steps 2 and 3)
// ---------------------------------------------------------------------------

/** What `compileProblem` reads of a resolved template; `ResolvedTemplate` satisfies it. */
export interface CompileInput {
  deckSize: number;
  /**
   * The largest HAND the criteria were expanded for: larger alternatives are
   * already gone. Without draw cards that is the hand size; with them it is the
   * hand the draw cards can build (`largestHand`), which is larger.
   */
  handSize: number;
  /** The template's lines in order, then the remainder — the only line whose `max` may be `null`. */
  lines: readonly {
    id: string;
    isRemainder: boolean;
    min: number;
    max: number | null;
    /** Set when the line's cards DRAW (PRD §5.7). */
    draw?: DrawSpec;
  }[];
  /** `matrix[line][description]`, one row per entry of `lines`. */
  matrix: readonly (readonly boolean[])[];
  flat: readonly FlatAlternative[];
  /**
   * The largest hand the criteria were expanded for, where draw cards make it
   * larger than `handSize`; absent is `handSize`, which is every template
   * without them.
   */
  judgedHand?: number;
  /**
   * Whether this run's score is a WEIGHTED score rather than a probability
   * (PRD §5.6). Carried through compilation because the answer has to say which
   * of the two it is wherever it is read, and a finished run's readout is a
   * pure function of its result (TDD §3). Absent is false.
   */
  weighted?: boolean;
}

/** What `compileCriterion` reads of one flat alternative; `ResolvedFlat` satisfies it. */
export interface FlatAlternative {
  reqs: readonly ResolvedRange[];
  limits: readonly ResolvedCounted[];
  /** What meeting it is worth; absent is 1 (PRD §5.6). */
  weight?: number;
  /** The sixth card's own part; absent is a criterion judged over the whole hand. */
  sixth?: { reqs: readonly ResolvedRange[]; limits: readonly ResolvedCounted[] };
  /** The whole hand's own part, what `finally` writes (PRD §5.5). */
  whole?: { reqs: readonly ResolvedRange[]; limits: readonly ResolvedCounted[] };
  /** An alternative the player would STOP for (PRD §5.7). */
  stop?: true;
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
  /** What its cards DRAW (PRD §5.7); every line of the class says the same thing. */
  draw?: DrawSpec;
}

/**
 * A limit left out of the compiled criterion because it holds of every hand:
 * `counts-nothing` — no line implies its description, so its mask is 0 — or
 * `never-binds` — its `n` is at least the largest hand.
 */
export interface DroppedLimit {
  /**
   * Index into `Problem.criteria` — the alternatives this run JUDGES, which
   * are `CompileInput.flat`'s only when the run judges all of them.
   */
  criterion: number;
  desc: number;
  n: number;
  reason: DroppedReason;
  /** Whether it was the SIXTH CARD's limit, where one card is the whole hand. */
  sixth?: true;
  /** Whether it was the `finally` part's limit, whose window is the whole hand. */
  whole?: true;
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
  /** Whether it was the SIXTH CARD's ceiling, where one card is the whole hand. */
  sixth?: true;
  /** Whether it was the `finally` part's ceiling, whose window is the whole hand. */
  whole?: true;
}

/**
 * How many cards each WINDOW of a criterion can hold. It is what decides
 * whether a ceiling or a limit can ever bind, and the three genuinely differ
 * once draw cards are in play:
 *
 * - `hand`: the whole hand, `largestHand` — six going second, and more where
 *   draw cards build one;
 * - `opened`: the cards a SPLIT criterion opens on, which is `H − 1` however
 *   deep the prefix goes. Without draw cards that is `hand − 1`, which is why
 *   one number sufficed before;
 * - `drawn`: what a split criterion's `then` part is about, `largestDrawnSet` —
 *   one card without draw cards, and the card drawn for turn plus everything
 *   fetched with them.
 */
export interface WindowRooms {
  hand: number;
  opened: number;
  drawn: number;
}

/** The three rooms of a hand of `H` with `draws`; all three are `H`-shaped without them. */
export function roomsOf(H: number, draws: readonly DrawClass[] = []): WindowRooms {
  return { hand: largestHand(H, draws), opened: H - 1, drawn: largestDrawnSet(H, draws) };
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
 *   can never bind — no class reaches it, or `b` is at least the ROOM of the
 *   window it is in, since a window never holds more cards than that. A
 *   requirement with no ceiling, and one whose ceiling was dropped, puts its
 *   classes in `free`: surplus there can always be assigned, so no ceiling
 *   traps it;
 * - a limit becomes a mask, dropped on the same two grounds.
 */
export function compileCriterion(
  { reqs, limits, weight, sixth, whole, stop }: FlatAlternative,
  maskOf: (desc: number) => number,
  rooms: WindowRooms,
): CompiledAlternative {
  const droppedLimits: Omit<DroppedLimit, 'criterion'>[] = [];
  const droppedCeilings: Omit<DroppedCeiling, 'criterion'>[] = [];
  /**
   * One window: the whole hand, the cards opened on, or the cards drawn.
   * `room` is how many cards it holds, which is what decides whether a ceiling
   * or a limit can ever bind — ONE for the card drawn where nothing draws, so
   * `at most 1x trap` there is dropped while `no trap` is kept and means what
   * it says. With draw cards the drawn set is larger and `at most 1x trap`
   * binds, which is the same rule reaching a different answer.
   */
  const window = (
    side: { reqs: readonly ResolvedRange[]; limits: readonly ResolvedCounted[] },
    room: number,
    /** Stamped on what this window drops, so a readout can say which window it was. */
    from: { sixth?: true; whole?: true },
  ): SixthCard => {
    const compiled = side.reqs.map(({ n, max, desc }): CompiledRequirement => {
      const mask = maskOf(desc);
      if (max === undefined) return { mask, min: n, max: null };
      const reason = mask === 0 ? 'counts-nothing' : max >= room ? 'never-binds' : undefined;
      if (reason === undefined) return { mask, min: n, max };
      droppedCeilings.push({ desc, n, max, reason, ...from });
      return { mask, min: n, max: null };
    });
    const part: SixthCard = {
      slots: compiled.flatMap(({ mask, min }) => new Array<number>(min).fill(mask)),
      limits: side.limits.flatMap(({ n, desc }) => {
        const mask = maskOf(desc);
        const reason = mask === 0 ? 'counts-nothing' : n >= room ? 'never-binds' : undefined;
        if (reason === undefined) return [{ mask, n }];
        droppedLimits.push({ desc, n, reason, ...from });
        return [];
      }),
    };
    // Left out when nothing is left to say: `slots` alone is the criterion the
    // language had before ranges, and the matcher's old path judges it.
    if (compiled.some(({ max }) => max !== null)) part.reqs = compiled;
    return part;
  };

  // A split criterion's own requirements are judged over the cards opened on,
  // which is `H − 1` and not the whole hand — and with draw cards those are two
  // different numbers rather than one apart. A `finally` part makes the criterion
  // split just as a `then` part does, so it is `isSplit` and not `sixth` that
  // decides which room the first window gets.
  const criterion: CompiledCriterion = window(
    { reqs, limits },
    isSplit({ sixth, whole }) ? rooms.opened : rooms.hand,
    {},
  );
  if (sixth !== undefined) criterion.sixth = window(sixth, rooms.drawn, { sixth: true });
  // The `finally` part's window is the WHOLE hand, so its room is `rooms.hand` —
  // which is exactly the room an unsplit criterion is judged in, and the reason
  // `at most 6x <desc>` is a vacuous `finally` at a hand of six.
  if (whole !== undefined) criterion.whole = window(whole, rooms.hand, { whole: true });
  // Left out at 1 for the same reason: the weigher then answers exactly what
  // the matcher answered, and the success set carries the 1s it always did.
  if (weight !== undefined && weight !== 1) criterion.weight = weight;
  // Left out unless the player would stop for it, which is the default and
  // every criterion written before draw cards.
  if (stop === true) criterion.stop = true;
  return { criterion, droppedLimits, droppedCeilings };
}

export type CompileResult =
  | {
      ok: true;
      problem: Problem;
      /** Whether the run's score is a weighted score rather than a probability (PRD §5.6). */
      weighted: boolean;
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
 * **Classes come from the criteria THIS RUN JUDGES** (PRD §5.5) — the union of
 * the hand sizes' `criteria`, which for a run that names none is every
 * alternative there is. A criterion for the other hand tells no class apart
 * here: its alternatives are left out of `problem.criteria`, and a description
 * only it mentions splits nothing. Going first is therefore compiled to
 * exactly the problem it would have been had the going-second criteria never
 * been written.
 *
 * One rule, not a special case: an AVERAGE judges every criterion, so its
 * partition is the union of both sets and nothing changes for it — the
 * renumbering is the identity and no description goes dead.
 *
 * It matters because the partition is what `MAX_CLASSES` counts and what the
 * search walks. Splitting one criteria list into two must not make a
 * going-first run slower — or refuse it outright — over criteria it never
 * evaluates.
 *
 * More than `MAX_CLASSES` classes, the blank class included, is an error.
 * The problem that comes back has passed `validateProblem`.
 */
export function compileProblem(input: CompileInput, opts: CompileOptions = {}): CompileResult {
  const { deckSize, lines, matrix, flat } = input;
  const handSizes = opts.handSizes ?? [{ H: input.handSize, weight: 1 }];
  const errors: string[] = [];

  // What this run JUDGES: the union of the parts' criteria, which for a run
  // whose parts name none is every alternative there is — one criteria list,
  // and every average.
  const judged = handSizes.some((hand) => hand.criteria === undefined)
    ? flat.map((_, at) => at)
    : [...new Set(handSizes.flatMap((hand) => hand.criteria ?? []))].sort((a, b) => a - b);
  const indexOf = new Map(judged.map((old, at) => [old, at]));
  const mine = new Set(judged);
  for (const at of judged)
    if (flat[at] === undefined)
      errors.push(
        `there is no criterion ${at}: the template expanded to ${flat.length} alternative(s)`,
      );
  if (errors.length > 0) return { ok: false, errors };

  /**
   * Descriptions only the OTHER hand's criteria mention. They tell this run's
   * classes nothing — no criterion it judges can see them — so two lines that
   * differ only there are one class here.
   *
   * Stated as what to take OUT rather than what to keep, and deliberately: a
   * column no alternative mentions at all is left splitting classes exactly as
   * it always has. Dead columns are a question about match matrices, not about
   * hands, and answering it here would change every run rather than the ones
   * this is about.
   */
  const columnsOf = (which: (at: number) => boolean): Set<number> => {
    const out = new Set<number>();
    flat.forEach((alternative, at) => {
      if (!which(at)) return;
      // EVERY WINDOW, and it has to be every window: a description named only
      // after `then` or `finally` is a column of the match matrix like any other
      // (`indexFlat` makes one), and leaving it out here would put it in `dead`
      // whenever some criterion this run does NOT judge also names it — which
      // drops it from the class partition, makes its mask 0, and turns that half
      // of a criterion this run DOES judge into something no hand can meet.
      // Nothing throws; the run just answers a different question.
      for (const side of [alternative, alternative.sixth, alternative.whole]) {
        if (side === undefined) continue;
        for (const { desc } of side.reqs) out.add(desc);
        for (const { desc } of side.limits) out.add(desc);
      }
    });
    return out;
  };
  const seen = columnsOf((at) => mine.has(at));
  const dead = new Set([...columnsOf((at) => !mine.has(at))].filter((desc) => !seen.has(desc)));

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
  const classOfLine = lines.map(({ id, min, max, draw }, line) => {
    const row = matrix[line]!;
    // A description only the other hand's criteria mention distinguishes
    // nothing this run can see (`dead`), so it splits no class here.
    const fills = row.flatMap((fill, desc) => (fill && !dead.has(desc) ? [desc] : []));
    // WHAT A LINE DRAWS tells it apart as surely as what it matches, and it
    // must enter the key as well as block the shortcut below: a `3x [Pot of
    // Greed]` no criterion mentions has an all-false row, and a blank class of
    // cards that DRAW would quietly report today's number for tomorrow's deck.
    //
    // ONCE-PER-TURN is a property of the CARD, so such a line joins no other:
    // two different cards each get their own once, and merging them into one
    // class would let one of the two stand for both.
    const drawKey =
      draw === undefined
        ? ''
        : `|draws ${draw.n}${draw.oncePerTurn === true ? ` once per turn as ${id}` : ''}`;
    const key = `${fills.join(',')}${drawKey}`;
    let cls = fills.length === 0 && draw === undefined ? 0 : classOfRow.get(key);
    if (cls === undefined) {
      cls = classes.length;
      classOfRow.set(key, cls);
      classes.push({ lines: [], min: 0, max: 0, fills, ...(draw === undefined ? {} : { draw }) });
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

  // The ROOM each window of a criterion is judged in: the largest any part of
  // this run can hold, which draw cards make larger than the hand size. It is
  // what decides whether a ceiling or a limit can ever bind, and — through
  // `input.handSize` — whether the criteria were expanded wide enough to judge.
  const draws = classes.flatMap(({ draw, max }, cls) =>
    draw === undefined ? [] : [{ cls, max, ...draw }],
  );
  const perHand = handSizes.map(({ H }) => roomsOf(H, draws));
  const rooms: WindowRooms = {
    hand: Math.max(...perHand.map(({ hand }) => hand)),
    opened: Math.max(...perHand.map(({ opened }) => opened)),
    drawn: Math.max(...perHand.map(({ drawn }) => drawn)),
  };
  const room = rooms.hand;
  const judgedHand = input.judgedHand ?? input.handSize;
  if (room > judgedHand)
    return {
      ok: false,
      errors: [
        `a hand of ${room} cannot be judged: the criteria were expanded for a hand of ${judgedHand}, and larger alternatives are already dropped — resolve the template at the largest hand it can hold`,
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
  // Only what this run judges, renumbered from 0, so that `problem.criteria`
  // holds no alternative no hand is ever held against: the parts' indices are
  // remapped onto it below, and `criterion` in the dropped lists is an index
  // into it too.
  // The switch is applied HERE as well as where the weights come from, so that
  // it is the whole of the difference and a compiled problem cannot carry
  // weights the run is not meant to read. Off, every alternative is worth 1 and
  // the problem is the one this template always compiled to.
  const weighted = input.weighted === true;
  const criteria = judged.map((at, criterion) => {
    const alternative = weighted ? flat[at]! : { ...flat[at]!, weight: 1 };
    const compiled = compileCriterion(alternative, maskOf, rooms);
    for (const dropped of compiled.droppedLimits) droppedLimits.push({ criterion, ...dropped });
    for (const dropped of compiled.droppedCeilings) droppedCeilings.push({ criterion, ...dropped });
    return compiled.criterion;
  });

  const problem: Problem = {
    deckSize,
    handSizes: handSizes.map((hand) => {
      // A hand DRAWS its last card wherever an alternative it judges reads the
      // hand as more than one window — `then`, which asks about that card, or
      // `finally`, which asks nothing about it but still makes the alternative's
      // own part a question about the first `H − 1`. Either way the hand has to be
      // dealt in two pieces for the reading to mean anything. And wherever the
      // caller says so, which is how a criterion's own row of a breakdown ends up
      // a fraction over the headline's denominator instead of one sixth of it.
      const mineHere = hand.criteria ?? flat.map((_, at) => at);
      const drawn =
        hand.drawn === true ||
        mineHere.some((at) => {
          const alternative = flat[at];
          return alternative !== undefined && isSplit(alternative);
        });
      const out: HandSize = { H: hand.H, weight: hand.weight };
      if (hand.criteria !== undefined) out.criteria = hand.criteria.map((old) => indexOf.get(old)!);
      if (drawn) out.drawn = true;
      return out;
    }),
    classes: classes.map(
      ({ lines: members, min, max, draw }): ClassInfo => ({
        lineIds: members.map((member) => member.id),
        min,
        max,
        ...(draw === undefined ? {} : { draw }),
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
  return {
    ok: true,
    problem,
    weighted,
    classes,
    classOfLine,
    droppedLimits,
    droppedCeilings,
  };
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
