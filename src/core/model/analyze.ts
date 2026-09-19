import type { CardRecord } from '../cards/record';
import { KINDS, type Kind } from '../cards/vocabulary';
import type { Expr, FlatCriterion } from '../criteria/ast';
import { expand, expandAll } from '../criteria/expand';
import { parseCriterion } from '../criteria/parser';
import { printCriterion } from '../criteria/print';
import { findSubsumed } from '../criteria/subsumes';
import type { Description } from '../desc/ast';
import type { CardLookup, DescContext, SetnameLookup } from '../desc/context';
import { type Groups, matcher } from '../desc/evaluate';
import { type ImpliesContext, implies, intersects, UNIVERSE } from '../desc/implies';
import type { Span } from '../desc/lexer';
import {
  type NearMissContext,
  type NearMissDimension,
  type NearMissReason,
  nearMiss,
} from '../desc/near-miss';
import { parse } from '../desc/parser';
import { echo, print } from '../desc/print';
import { successSet } from '../prob/success-set';
import { type Count, countToNumber, toCount } from '../util/count';
import {
  type CompileInput,
  compileProblem,
  groupLookupOf,
  groupMembersOf,
  REMAINDER_ID,
} from './compile';
import { MAX_DECK_SIZE } from './problem';
import { achievableRange, countSums, type IntRange } from './ranges';
import {
  DECK_SIZE_MAX,
  DECK_SIZE_MIN,
  HAND_SIZES,
  NAMED_CARD_MAX,
  type Template,
} from './template';

/**
 * The Analysis API (TDD §9): everything the tool understood of a template,
 * and every rule that will shape the result, as ONE plain JSON value — it
 * crosses IPC, and is recomputed on every edit. Nothing here is scored; what
 * is scored is `compileProblem`'s, and `classes` shows it.
 */

/** `error` blocks a run; `warning` is probably a mistake; `notice` explains a rule at work. */
export type Severity = 'error' | 'warning' | 'notice';

export type IssueCode =
  // a line
  | 'parse'
  | 'no-match'
  | 'card-missing'
  | 'named-max'
  | 'min-over-max'
  | 'shared-limit'
  | 'duplicate-card'
  | 'unsatisfiable'
  | 'group-missing-members'
  // a group
  | 'empty-group'
  // a requirement or a limit
  | 'unfilled'
  | 'limit-ignores'
  | 'limit-counts-nothing'
  // a criterion
  | 'expansion-cap'
  | 'never-satisfiable'
  | 'subsumed'
  | 'absent-card'
  // the template
  | 'deck-size'
  | 'hand-size'
  | 'no-criteria'
  | 'subsumption-skipped'
  | 'infeasible'
  | 'compile'
  | 'internal';

export interface Issue {
  severity: Severity;
  code: IssueCode;
  message: string;
  /** Where in the line's or criterion's text, for a `parse` error. */
  span?: Span;
}

export type ParsedText =
  | {
      ok: true;
      /** Canonical text. */
      canonical: string;
      /** What was understood, for the reader (PRD §5.2); a criterion has none. */
      echo?: string;
    }
  | { ok: false; message: string; span: Span };

export interface LineAnalysis {
  id: string;
  /** A picker-chosen card reads `#passcode`. */
  text: string;
  min: number;
  max: number;
  parsed: ParsedText;
  /** Cards in the database that match; informative only (TDD §6.3). `null` when the text did not parse. */
  count: number | null;
  /** Names of up to `SAMPLE_SIZE` of them. */
  samples: string[];
  issues: Issue[];
}

export interface RemainderAnalysis {
  id: string;
  /** The unspecified cards are described as `card`, echoed `Any card`, and match the whole database. */
  canonical: string;
  echo: string;
  count: number;
  /** As stated; `max: null` is unbounded. */
  min: number;
  max: number | null;
  /** What the lines leave it: `13–33`. `null` when the ranges cannot fill the deck. */
  range: IntRange | null;
  issues: Issue[];
}

export interface GroupAnalysis {
  id: string;
  name: string;
  size: number;
  /** Members the card database lacks. */
  missing: number[];
  issues: Issue[];
}

/** Where a requirement or limit appears: alternative `alternative` of the criterion's expansion. */
export interface Appearance {
  criterion: string;
  alternative: number;
  n: number;
}

export interface NearMissAnalysis {
  /** A line id, or the remainder's. */
  line: string;
  isRemainder: boolean;
  dimension: NearMissDimension;
  reason: NearMissReason;
  /** `\`monster\`: Level unstated`. */
  explanation: string;
  /** Canonical text of a line that WOULD fill the requirement, for the one-click split (PRD §6.4). */
  suggestion?: string;
}

/** One distinct description that some flat alternative REQUIRES. */
export interface RequirementAnalysis {
  /** Canonical text. */
  text: string;
  echo: string;
  appearsIn: Appearance[];
  /** Lines whose description implies it, the remainder included; template order. */
  filledBy: string[];
  /** Lines that are compatible with it and do not imply it. */
  nearMisses: NearMissAnalysis[];
  issues: Issue[];
}

export interface IgnoredLine extends IntRange {
  line: string;
  isRemainder: boolean;
}

/** One distinct description that some flat alternative LIMITS. */
export interface LimitAnalysis {
  text: string;
  echo: string;
  appearsIn: Appearance[];
  /** Lines whose cards count against it: those that imply it. */
  counts: string[];
  /** Lines that might hold matching cards and are NOT counted (PRD §6.3), each with its own range. */
  ignored: IgnoredLine[];
  /** How many cards those lines can hold together, the deck size considered; `null` with none, or an infeasible template. */
  ignoredRange: IntRange | null;
  /** No line counts against it: it holds of every hand. */
  countsNothing: boolean;
  issues: Issue[];
}

export interface SubsumedAlternative {
  alternative: number;
  by: { criterion: string; alternative: number };
}

export interface CriterionAnalysis {
  id: string;
  name?: string;
  text: string;
  parsed: ParsedText;
  /** The expansion preview: canonical text of each flat alternative, in order. */
  alternatives: string[];
  /** Alternatives left out for needing more cards than the hand holds. */
  dropped: number;
  /**
   * Set when no hand can ever meet the criterion: every alternative was
   * dropped, or each one has a requirement no line fills — `unfilled[i]` lists
   * those of alternative `i`.
   */
  neverSatisfiable?: {
    reason: 'every-alternative-dropped' | 'unfilled-requirement';
    unfilled: string[][];
  };
  /** Alternatives that add no hand another alternative does not already accept (TDD §7.2). */
  subsumed: SubsumedAlternative[];
  /** Every alternative is subsumed by one of ANOTHER criterion: this criterion adds nothing. */
  redundant: boolean;
  /** Cards it names that no line of the template names. */
  absentCards: { passcode: number; name?: string }[];
  issues: Issue[];
}

export interface KindTotal {
  kind: Kind;
  /** Lines known to be of the kind: those that imply it. */
  lines: string[];
  /** `Known monsters: 7–14`. `null` when the ranges cannot fill the deck. */
  range: IntRange | null;
}

export interface TotalsAnalysis {
  /** Whether the ranges can sum to the deck size at all. */
  feasible: boolean;
  kinds: KindTotal[];
  /** The plain sum of the lines' stated ranges, the remainder not among them. */
  lines: IntRange;
  remainder: IntRange | null;
}

export interface ClassAnalysis {
  /** Member line ids, the remainder's included; the blank class (index 0) may have none. */
  lines: string[];
  min: number;
  max: number;
}

export interface ClassesAnalysis {
  /** What `compileProblem` made of the template; index 0 is the blank class. */
  classes: ClassAnalysis[];
  /** The criteria expanded TOGETHER, duplicates removed: a hand succeeds if it meets any one of these. */
  alternatives: number;
  /** The blank class's lines: "cannot affect the odds" (PRD §5.6). */
  irrelevant: string[];
  /** Limits the engine leaves out because they hold of every hand, by description text. */
  droppedLimits: {
    criterion: number;
    text: string;
    n: number;
    reason: 'counts-nothing' | 'never-binds';
  }[];
}

/** What a score costs, per class vector (TDD §10.3): the M1a benchmark, until it is calibrated at startup. */
export interface CostModel {
  perVectorUs: number;
  perTermNs: number;
}

export const DEFAULT_COST: CostModel = { perVectorUs: 0.05, perTermNs: 6 };

export interface WorkAnalysis {
  /**
   * Valid raw line ratios. A `Count`: a number up to 2^53, exact decimal
   * digits as a string beyond. `null` when the deck size is not one to count for.
   */
  rawRatios: Count | null;
  /** Class-total vectors the optimizer would score; `null` when the template does not compile. */
  classVectors: Count | null;
  /** Per hand size, the products summed per score: `createScorer(...).terms`. */
  hands: { H: number; terms: number; complemented: boolean }[] | null;
  estimatedMs: number | null;
  cost: CostModel;
}

export interface Analysis {
  /** No `error` anywhere: the template can be run. */
  ok: boolean;
  deckSize: number;
  handSize: number;
  lines: LineAnalysis[];
  remainder: RemainderAnalysis;
  groups: GroupAnalysis[];
  requirements: RequirementAnalysis[];
  limits: LimitAnalysis[];
  criteria: CriterionAnalysis[];
  /** Issues of the template as a whole. */
  issues: Issue[];
  totals: TotalsAnalysis;
  /** `null` until every line and criterion resolves. */
  classes: ClassesAnalysis | null;
  work: WorkAnalysis;
}

/** What the database says of one description: how many cards match, and the names of the first few. */
export interface MatchSummary {
  count: number;
  samples: string[];
}

/** What `analyze` looks things up in; the real `CardIndex` and `SetnameTable` satisfy it. */
export interface AnalyzeContext {
  cards: CardLookup & {
    /**
     * Must call `pred` once per card, in display order, as `CardIndex.count`
     * does: the first `SAMPLE_SIZE` cards it accepts become the line's samples,
     * so that a line costs ONE pass over the database and not two.
     */
    count(pred: (card: CardRecord) => boolean): number;
  };
  /** `null` when the install has no `strings.conf`. */
  setnames: SetnameLookup | null;
  /**
   * Optional, and the caller's to keep for as long as `cards` stays the same:
   * what the database said of each description already asked about. Scanning
   * the database is most of what a line costs, and an edit changes one line.
   * The analysis is the same with it or without.
   */
  memo?: Map<string, MatchSummary>;
}

export interface AnalyzeOptions {
  cost?: CostModel;
}

export const SAMPLE_SIZE = 5;

/**
 * Subsumption compares every pair of flat alternatives. Past this many it is
 * skipped — with a notice, and nothing scored depends on it — so that
 * `analyze` stays fast on criteria that expand towards the cap of 256 each.
 */
export const MAX_SUBSUMPTION_ALTERNATIVES = 128;

const error = (code: IssueCode, message: string): Issue => ({ severity: 'error', code, message });
const warning = (code: IssueCode, message: string): Issue => ({
  severity: 'warning',
  code,
  message,
});
const notice = (code: IssueCode, message: string): Issue => ({ severity: 'notice', code, message });

const quoted = (ids: readonly string[]) => ids.map((id) => JSON.stringify(id)).join(', ');
const ticked = (texts: readonly string[]) => texts.map((text) => `\`${text}\``).join(', ');
const span = ({ min, max }: IntRange) => (min === max ? `${min}` : `${min}–${max}`);

/** A line as the matching sees it: the template's lines that parsed, then the remainder. */
interface Row {
  id: string;
  isRemainder: boolean;
  desc: Description;
  canonical: string;
  /** Index into the ranges: the template's lines in order, then the remainder. */
  at: number;
}

/** One distinct description of the criteria: a column of the match matrix. */
interface Column {
  desc: Description;
  text: string;
  echo: string;
  required: Appearance[];
  limited: Appearance[];
  /** Per `Row`: whether it implies the description. */
  fills: boolean[];
}

interface ParsedCriterion {
  expr: Expr;
  /** `null` when the expansion passed the cap. */
  flat: FlatCriterion[] | null;
}

/** The descriptions of a criterion, as written. */
function descsOf(expr: Expr): Description[] {
  return expr.op === 'and' || expr.op === 'or' ? expr.args.flatMap(descsOf) : [expr.desc];
}

function flatText(flat: FlatCriterion, ctx: DescContext): string {
  const counted = (prefix: string, desc: Description) => {
    const text = print(desc, ctx);
    return `${prefix} ${desc.anyOf.length > 1 ? `(${text})` : text}`;
  };
  const parts = [
    ...flat.reqs.map(({ n, desc }) => counted(`${n}x`, desc)),
    ...flat.limits.map(({ n, desc }) => counted(n === 0 ? 'no' : `at most ${n}x`, desc)),
  ];
  return parts.length === 0 ? '(nothing: every hand meets it)' : parts.join(', ');
}

/** One pass over the database; remembered in `ctx.memo`, under a key that holds all it depends on. */
function summarize(desc: Description, members: Groups, ctx: AnalyzeContext): MatchSummary {
  // A group is only an id in the description: what it matches depends on its members.
  const groups = desc.anyOf.flatMap((alt) =>
    alt.t === 'group' ? [[alt.groupId, [...(members.get(alt.groupId) ?? [])]]] : [],
  );
  const key = JSON.stringify([desc, groups]);
  const known = ctx.memo?.get(key);
  if (known !== undefined) return { count: known.count, samples: [...known.samples] };

  const matches = matcher(desc, members);
  const samples: string[] = [];
  const count = ctx.cards.count((card) => {
    if (!matches(card)) return false;
    if (samples.length < SAMPLE_SIZE) samples.push(card.name);
    return true;
  });
  ctx.memo?.set(key, { count, samples: [...samples] });
  return { count, samples };
}

function analyzeUnguarded(template: Template, ctx: AnalyzeContext, cost: CostModel): Analysis {
  const { deckSize } = template;
  const handSize = template.hand.size;
  const members = groupMembersOf(template.groups);
  const descCtx: DescContext = {
    cards: ctx.cards,
    setnames: ctx.setnames,
    groups: groupLookupOf(template.groups),
  };
  const impliesCtx: ImpliesContext = { cards: ctx.cards, groups: members };
  const nearCtx: NearMissContext = { desc: descCtx, implies: impliesCtx };
  const issues: Issue[] = [];

  if (!Number.isInteger(deckSize) || deckSize < DECK_SIZE_MIN || deckSize > DECK_SIZE_MAX)
    issues.push(
      error(
        'deck-size',
        `the deck size is ${deckSize}; a Main Deck holds ${DECK_SIZE_MIN} to ${DECK_SIZE_MAX} cards`,
      ),
    );
  const handIsValid = HAND_SIZES.includes(handSize as 5 | 6);
  if (!handIsValid)
    issues.push(
      error(
        'hand-size',
        `the hand size is ${handSize}; an opening hand is ${HAND_SIZES.join(' or ')} cards`,
      ),
    );

  // --- groups ---------------------------------------------------------------------
  const groups = template.groups.map((group): GroupAnalysis => {
    const missing = group.cards
      .map((card) => card.passcode)
      .filter((passcode) => ctx.cards.get(passcode) === undefined);
    const found: Issue[] = [];
    if (group.cards.length === 0)
      found.push(warning('empty-group', `the group {${group.name}} is empty: it matches no card`));
    if (missing.length > 0)
      found.push(
        warning(
          'group-missing-members',
          `the group {${group.name}} names cards the database lacks: ${missing.map((code) => `#${code}`).join(', ')} — they match only requirements that name them`,
        ),
      );
    return { id: group.id, name: group.name, size: group.cards.length, missing, issues: found };
  });

  // --- lines ------------------------------------------------------------------------
  const rows: Row[] = [];
  /** The one card a line names, by line index; lines that name a choice, or none, are not here. */
  const namedCard = new Map<number, number>();
  const lines = template.lines.map((line, at): LineAnalysis => {
    const found: Issue[] = [];
    let desc: Description | undefined;
    let parsed: ParsedText | undefined;
    let text: string;
    if ('card' in line) {
      desc = { anyOf: [{ t: 'card', passcode: line.card.passcode }] };
      text = `#${line.card.passcode}`;
      if (ctx.cards.get(line.card.passcode) === undefined)
        found.push(
          warning(
            'card-missing',
            `#${line.card.passcode} (${line.card.name}) is not in the card database; only a requirement that names it can be filled by it`,
          ),
        );
    } else {
      text = line.text;
      const result = parse(line.text, descCtx);
      if (result.ok) desc = result.desc;
      else {
        found.push({ ...error('parse', result.message), span: result.span });
        parsed = { ok: false, message: result.message, span: result.span };
      }
    }

    if (line.min > line.max)
      found.push(error('min-over-max', `\`min\` ${line.min} is greater than \`max\` ${line.max}`));
    let count: number | null = null;
    let samples: string[] = [];
    if (desc !== undefined) {
      const canonical = print(desc, descCtx);
      parsed = { ok: true, canonical, echo: echo(desc, descCtx) };
      rows.push({ id: line.id, isRemainder: false, desc, canonical, at });
      ({ count, samples } = summarize(desc, members, ctx));

      const [only] = desc.anyOf;
      if (desc.anyOf.length === 1 && only?.t === 'card') {
        namedCard.set(at, only.passcode);
        if (line.max > NAMED_CARD_MAX)
          found.push(
            error(
              'named-max',
              `\`max\` is ${line.max}, but a deck holds at most ${NAMED_CARD_MAX} copies of one card`,
            ),
          );
      }
      if (!intersects(desc, UNIVERSE, impliesCtx)) {
        const empty = desc.anyOf.flatMap((alt) =>
          alt.t === 'group' && (members.get(alt.groupId)?.size ?? 0) === 0
            ? [`{${descCtx.groups.nameOf(alt.groupId) ?? '?'}}`]
            : [],
        );
        found.push(
          error(
            'unsatisfiable',
            empty.length > 0
              ? `this line can hold no card: the group ${empty.join(', ')} is empty`
              : 'this line can hold no card: its description contradicts itself',
          ),
        );
      } else if (count === 0 && 'text' in line)
        found.push(
          notice(
            'no-match',
            `\`${line.text}\` matches no card in the database today — allowed: a line states what its cards are known to be, not which cards exist`,
          ),
        );
      for (const alt of desc.anyOf) {
        if (alt.t !== 'group') continue;
        const group = groups.find((g) => g.id === alt.groupId);
        if (group !== undefined && group.missing.length > 0)
          found.push(
            warning(
              'group-missing-members',
              `the group {${group.name}} names cards the database lacks: ${group.missing.map((code) => `#${code}`).join(', ')}`,
            ),
          );
      }
    }
    return {
      id: line.id,
      text,
      min: line.min,
      max: line.max,
      parsed: parsed!,
      count,
      samples,
      issues: found,
    };
  });

  // Lines that name one card each share a copy limit when the cards do (TDD §4.3):
  // `limitCode` is the alias target of an "always treated as" card.
  const byLimit = new Map<number, number[]>();
  const byPasscode = new Map<number, number[]>();
  for (const [at, passcode] of namedCard) {
    const limitCode = ctx.cards.get(passcode)?.limitCode ?? passcode;
    byLimit.set(limitCode, [...(byLimit.get(limitCode) ?? []), at]);
    byPasscode.set(passcode, [...(byPasscode.get(passcode) ?? []), at]);
  }
  for (const sharing of byLimit.values()) {
    const most = sharing.reduce((sum, at) => sum + template.lines[at]!.max, 0);
    if (sharing.length < 2 || most <= NAMED_CARD_MAX) continue;
    const ids = quoted(sharing.map((at) => lines[at]!.id));
    for (const at of sharing)
      lines[at]!.issues.unshift(
        error(
          'shared-limit',
          `lines ${ids} count as the same card for the copy limit and together allow up to ${most} copies; a deck holds at most ${NAMED_CARD_MAX}`,
        ),
      );
  }
  for (const [passcode, same] of byPasscode) {
    if (same.length < 2) continue;
    const ids = quoted(same.map((at) => lines[at]!.id));
    for (const at of same)
      lines[at]!.issues.push(
        warning('duplicate-card', `lines ${ids} all name #${passcode}; one line would do`),
      );
  }

  const remainderAt = template.lines.length;
  rows.push({
    id: REMAINDER_ID,
    isRemainder: true,
    desc: UNIVERSE,
    canonical: print(UNIVERSE, descCtx),
    at: remainderAt,
  });

  // --- ranges: totals, and the raw ratios -----------------------------------------
  const remainderIssues: Issue[] = [];
  const { remainder } = template;
  if (remainder.max !== null && remainder.min > remainder.max)
    remainderIssues.push(
      error(
        'min-over-max',
        `the remainder's \`min\` ${remainder.min} is greater than its \`max\` ${remainder.max}`,
      ),
    );
  const countable = Number.isInteger(deckSize) && deckSize >= 0 && deckSize <= MAX_DECK_SIZE;
  const ranges: IntRange[] = [
    ...template.lines.map(({ min, max }) => ({ min, max })),
    { min: remainder.min, max: remainder.max ?? Math.max(deckSize, remainder.min) },
  ];
  const rangeOver = (chosen: (at: number) => boolean): IntRange | null =>
    countable
      ? achievableRange(
          ranges,
          ranges.map((_, at) => chosen(at)),
          deckSize,
        )
      : null;
  const remainderRange = rangeOver((at) => at === remainderAt);
  const feasible = remainderRange !== null;
  const rangesAreValid = ranges.every(({ min, max }) => min <= max);
  if (countable && !feasible && rangesAreValid) {
    const least = ranges.reduce((sum, { min }) => sum + min, 0);
    const most = ranges.reduce((sum, { max }) => sum + max, 0);
    issues.push(
      error(
        'infeasible',
        least > deckSize
          ? `the ranges cannot sum to the deck size: the lines and the remainder hold at least ${least} cards, ${least - deckSize} more than the deck of ${deckSize}`
          : `the ranges cannot sum to the deck size: the lines and the remainder hold at most ${most} cards, ${deckSize - most} fewer than the deck of ${deckSize}`,
      ),
    );
  }
  const kinds = KINDS.map((kind): KindTotal => {
    const ofKind: Description = { anyOf: [{ t: 'clause', clause: { kinds: [kind] } }] };
    const known = rows.filter((row) => !row.isRemainder && implies(row.desc, ofKind, impliesCtx));
    const at = new Set(known.map((row) => row.at));
    return { kind, lines: known.map((row) => row.id), range: rangeOver((i) => at.has(i)) };
  });
  const totals: TotalsAnalysis = {
    feasible,
    kinds,
    lines: {
      min: template.lines.reduce((sum, line) => sum + line.min, 0),
      max: template.lines.reduce((sum, line) => sum + line.max, 0),
    },
    remainder: remainderRange,
  };

  // --- criteria: parse, expand, collect the distinct descriptions ----------------------
  const columns: Column[] = [];
  const columnOf = new Map<string, number>();
  const columnAt = (desc: Description): number => {
    // `expand` hands back canonical descriptions, so their JSON is their identity.
    const key = JSON.stringify(desc);
    let at = columnOf.get(key);
    if (at === undefined) {
      at = columns.length;
      columnOf.set(key, at);
      columns.push({
        desc,
        text: print(desc, descCtx),
        echo: echo(desc, descCtx),
        required: [],
        limited: [],
        fills: rows.map((row) => implies(row.desc, desc, impliesCtx)),
      });
    }
    return at;
  };
  const column = (desc: Description): Column => columns[columnAt(desc)]!;

  const parsedCriteria: (ParsedCriterion | null)[] = [];
  const criteria = template.criteria.map((criterion): CriterionAnalysis => {
    const out: CriterionAnalysis = {
      id: criterion.id,
      text: criterion.text,
      parsed: { ok: true, canonical: '' },
      alternatives: [],
      dropped: 0,
      subsumed: [],
      redundant: false,
      absentCards: [],
      issues: [],
    };
    if (criterion.name !== undefined) out.name = criterion.name;
    const result = parseCriterion(criterion.text, descCtx);
    if (!result.ok) {
      out.parsed = { ok: false, message: result.message, span: result.span };
      out.issues.push({ ...error('parse', result.message), span: result.span });
      parsedCriteria.push(null);
      return out;
    }
    out.parsed = { ok: true, canonical: printCriterion(result.expr, descCtx) };
    const expanded = expand(result.expr, { maxHandSize: handSize });
    if (!expanded.ok) {
      out.issues.push(error('expansion-cap', expanded.message));
      parsedCriteria.push({ expr: result.expr, flat: null });
      return out;
    }
    out.dropped = expanded.dropped;
    out.alternatives = expanded.flat.map((flat) => flatText(flat, descCtx));
    expanded.flat.forEach(({ reqs, limits }, alternative) => {
      for (const { n, desc } of reqs)
        column(desc).required.push({ criterion: criterion.id, alternative, n });
      for (const { n, desc } of limits)
        column(desc).limited.push({ criterion: criterion.id, alternative, n });
    });
    parsedCriteria.push({ expr: result.expr, flat: expanded.flat });
    return out;
  });
  if (template.criteria.length === 0)
    issues.push(warning('no-criteria', 'there is no criterion: every hand fails'));

  // --- requirements and limits -----------------------------------------------------------
  const fillers = (col: Column) => rows.filter((_, i) => col.fills[i]).map((row) => row.id);
  const requirements = columns
    .filter((col) => col.required.length > 0)
    .map((col): RequirementAnalysis => {
      const filledBy = fillers(col);
      const nearMisses = rows.flatMap((row, i): NearMissAnalysis[] => {
        if (col.fills[i]) return [];
        const miss = nearMiss(row.desc, col.desc, nearCtx);
        if (miss === null) return [];
        const { what, ...rest } = miss;
        return [
          {
            line: row.id,
            isRemainder: row.isRemainder,
            ...rest,
            explanation: `\`${row.canonical}\`: ${what}`,
          },
        ];
      });
      return {
        text: col.text,
        echo: col.echo,
        appearsIn: col.required,
        filledBy,
        nearMisses,
        issues:
          filledBy.length === 0
            ? [warning('unfilled', `no line fills the requirement \`${col.text}\``)]
            : [],
      };
    });

  const limits = columns
    .filter((col) => col.limited.length > 0)
    .map((col): LimitAnalysis => {
      const counts = fillers(col);
      const ignoredRows = rows.filter(
        (row, i) => !col.fills[i] && intersects(row.desc, col.desc, impliesCtx),
      );
      const ignored = ignoredRows.map(
        (row): IgnoredLine => ({
          line: row.id,
          isRemainder: row.isRemainder,
          ...(row.isRemainder && remainderRange !== null ? remainderRange : ranges[row.at]!),
        }),
      );
      const ignoredAt = new Set(ignoredRows.map((row) => row.at));
      const ignoredRange = ignored.length === 0 ? null : rangeOver((at) => ignoredAt.has(at));
      const found: Issue[] = [];
      if (counts.length === 0)
        found.push(
          warning(
            'limit-counts-nothing',
            `no line counts against the limit on \`${col.text}\`: it holds of every hand`,
          ),
        );
      if (ignoredRange !== null && ignoredRange.max > 0) {
        const names = ignoredRows.map((row) =>
          row.isRemainder ? 'the remainder' : JSON.stringify(row.id),
        );
        found.push(
          notice(
            'limit-ignores',
            `a limit on \`${col.text}\` ignores ${span(ignoredRange)} cards of lines that do not say whether they match: ${names.join(', ')} — if some do, give them a line that says so`,
          ),
        );
      }
      return {
        text: col.text,
        echo: col.echo,
        appearsIn: col.limited,
        counts,
        ignored,
        ignoredRange,
        countsNothing: counts.length === 0,
        issues: found,
      };
    });

  // --- criteria: what can never be met, what adds nothing, what is not in the template ---
  const namedOnLines = new Set(
    rows.flatMap((row) =>
      row.desc.anyOf.flatMap((alt) =>
        alt.t === 'card'
          ? [alt.passcode]
          : alt.t === 'group'
            ? [...(members.get(alt.groupId) ?? [])]
            : [],
      ),
    ),
  );
  criteria.forEach((out, at) => {
    const criterion = parsedCriteria[at];
    if (criterion === null || criterion === undefined) return;
    const absent = new Set(
      descsOf(criterion.expr).flatMap((desc) =>
        desc.anyOf.flatMap((alt) =>
          alt.t === 'card' && !namedOnLines.has(alt.passcode) ? [alt.passcode] : [],
        ),
      ),
    );
    out.absentCards = [...absent].map((passcode) => {
      const name = ctx.cards.get(passcode)?.name;
      return name === undefined ? { passcode } : { passcode, name };
    });
    if (absent.size > 0) {
      const names = out.absentCards.map(({ passcode, name }) =>
        name === undefined ? `#${passcode}` : `${name} (#${passcode})`,
      );
      out.issues.push(
        warning(
          'absent-card',
          `names ${names.join(', ')}, which no line of the template names: no card in the deck can be it`,
        ),
      );
    }

    if (criterion.flat === null) return;
    const unfilled = criterion.flat.map(({ reqs }) =>
      reqs.map(({ desc }) => column(desc)).filter((col) => !col.fills.some(Boolean)),
    );
    if (criterion.flat.length === 0) {
      out.neverSatisfiable = { reason: 'every-alternative-dropped', unfilled: [] };
      out.issues.push(
        warning(
          'never-satisfiable',
          `can never be met: every alternative needs more than the ${handSize} cards of a hand`,
        ),
      );
    } else if (unfilled.every((cols) => cols.length > 0)) {
      out.neverSatisfiable = {
        reason: 'unfilled-requirement',
        unfilled: unfilled.map((cols) => cols.map((col) => col.text)),
      };
      const texts = [...new Set(unfilled.flat().map((col) => col.text))];
      out.issues.push(
        warning(
          'never-satisfiable',
          `can never be met: every alternative needs a card no line provides — ${ticked(texts)}`,
        ),
      );
    }
  });

  // Subsumption over every criterion's own alternatives, side by side: two identical ones
  // subsume each other, and `findSubsumed` then reports the later. It asks about the same
  // few pairs of descriptions over and over, so `implies` is memoized by column.
  const owners = parsedCriteria.flatMap((criterion, at) =>
    (criterion?.flat ?? []).map((flat, alternative) => ({ at, alternative, flat })),
  );
  const atOf = new WeakMap<Description, number>();
  const known = new Int8Array(columns.length * columns.length);
  const cached = (desc: Description): number => {
    let at = atOf.get(desc);
    if (at === undefined) {
      at = columnAt(desc);
      atOf.set(desc, at);
    }
    return at;
  };
  const columnImplies = (L: Description, q: Description): boolean => {
    const cell = cached(L) * columns.length + cached(q);
    if (known[cell] === 0) known[cell] = implies(L, q, impliesCtx) ? 1 : -1;
    return known[cell] === 1;
  };
  const compared = owners.length <= MAX_SUBSUMPTION_ALTERNATIVES;
  if (!compared)
    issues.push(
      notice(
        'subsumption-skipped',
        `the criteria expand to ${owners.length} alternatives; past ${MAX_SUBSUMPTION_ALTERNATIVES}, they are not checked for alternatives that add nothing`,
      ),
    );
  const pairs = compared
    ? findSubsumed(
        owners.map((owner) => owner.flat),
        columnImplies,
        handSize,
      )
    : [];
  for (const [index, owner] of owners.entries()) {
    const by = pairs.filter((pair) => pair.subsumed === index).map((pair) => owners[pair.by]!);
    if (by.length === 0) continue;
    // Another criterion's alternative says more than a sibling does.
    const chosen = by.find((other) => other.at !== owner.at) ?? by[0]!;
    criteria[owner.at]!.subsumed.push({
      alternative: owner.alternative,
      by: { criterion: criteria[chosen.at]!.id, alternative: chosen.alternative },
    });
  }
  for (const out of criteria) {
    if (out.subsumed.length === 0) continue;
    const others = out.subsumed.filter(({ by }) => by.criterion !== out.id);
    out.redundant = others.length === out.alternatives.length;
    if (out.redundant) {
      const ids = [...new Set(others.map(({ by }) => by.criterion))];
      out.issues.push(
        notice(
          'subsumed',
          `adds nothing: every hand that meets it already meets criterion ${quoted(ids)}`,
        ),
      );
      continue;
    }
    for (const { alternative, by } of out.subsumed) {
      const where = by.criterion === out.id ? '' : ` of criterion ${JSON.stringify(by.criterion)}`;
      out.issues.push(
        notice(
          'subsumed',
          `alternative ${alternative + 1} (\`${out.alternatives[alternative]}\`) adds nothing: every hand that meets it already meets alternative ${by.alternative + 1}${where}`,
        ),
      );
    }
  }

  // --- classes and work ------------------------------------------------------------------
  const work: WorkAnalysis = {
    rawRatios: countable ? toCount(countSums(ranges, deckSize)) : null,
    classVectors: null,
    hands: null,
    estimatedMs: null,
    cost,
  };
  let classes: ClassesAnalysis | null = null;
  const resolves =
    rows.length === template.lines.length + 1 &&
    parsedCriteria.every((criterion) => criterion !== null && criterion.flat !== null);
  if (resolves) {
    const all = expandAll(
      parsedCriteria.map((criterion) => criterion!.expr),
      { maxHandSize: handSize },
    );
    if (!all.ok) issues.push(error('expansion-cap', all.message));
    else if (countable && handIsValid && rangesAreValid) {
      const input: CompileInput = {
        deckSize,
        handSize,
        lines: rows.map((row) => ({
          id: row.id,
          isRemainder: row.isRemainder,
          min: ranges[row.at]!.min,
          max: row.isRemainder ? remainder.max : ranges[row.at]!.max,
        })),
        matrix: rows.map((_, i) => columns.map((col) => col.fills[i]!)),
        flat: all.flat.map(({ reqs, limits }) => ({
          reqs: reqs.map(({ n, desc }) => ({ n, desc: columnAt(desc) })),
          limits: limits.map(({ n, desc }) => ({ n, desc: columnAt(desc) })),
        })),
      };
      const compiled = compileProblem(input);
      if (!compiled.ok) issues.push(...compiled.errors.map((message) => error('compile', message)));
      else {
        classes = {
          classes: compiled.problem.classes.map(({ lineIds, min, max }) => ({
            lines: lineIds,
            min,
            max,
          })),
          alternatives: compiled.problem.criteria.length,
          irrelevant: compiled.problem.classes[0]!.lineIds,
          droppedLimits: compiled.droppedLimits.map(({ criterion, desc, n, reason }) => ({
            criterion,
            text: columns[desc]!.text,
            n,
            reason,
          })),
        };
        work.classVectors = toCount(countSums(compiled.problem.classes, deckSize));
        work.hands = compiled.problem.handSizes.map(({ H }) => {
          const { count, complemented } = successSet(compiled.problem, H);
          return { H, terms: count, complemented };
        });
        const perVectorUs = work.hands.reduce(
          (sum, { terms }) => sum + cost.perVectorUs + (cost.perTermNs / 1000) * terms,
          0,
        );
        work.estimatedMs = (countToNumber(work.classVectors) * perVectorUs) / 1000;
      }
    }
  }

  const everyIssue = [
    ...issues,
    ...remainderIssues,
    ...[...lines, ...groups, ...requirements, ...limits, ...criteria].flatMap(
      (part) => part.issues,
    ),
  ];
  return {
    ok: !everyIssue.some((issue) => issue.severity === 'error'),
    deckSize,
    handSize,
    lines,
    remainder: {
      id: REMAINDER_ID,
      canonical: print(UNIVERSE, descCtx),
      echo: echo(UNIVERSE, descCtx),
      count: summarize(UNIVERSE, members, ctx).count,
      min: remainder.min,
      max: remainder.max,
      range: remainderRange,
      issues: remainderIssues,
    },
    groups,
    requirements,
    limits,
    criteria,
    issues,
    totals,
    classes,
    work,
  };
}

/**
 * Everything the tool understands of `template` (TDD §9). Pure, and NEVER
 * throws: on a broken template it returns all it can, each error attached to
 * the line, group, requirement, limit or criterion it belongs to, and the
 * rest to the template (`issues`). Counting is by closed form and small DP —
 * no ratio and no class vector is ever listed — so it is cheap enough to run
 * on every edit; the one thing that grows with the problem is the success set
 * behind `work.hands` (TDD §10.2).
 *
 * `classes` and the class-vector side of `work` need every line and criterion
 * to resolve; until then they are `null` and everything else is still there.
 *
 * TODO(M2g): a stored `desc` / `expr` is authoritative (TDD §14); until then
 * the text is parsed, as in `resolveTemplate`.
 */
export function analyze(
  template: Template,
  ctx: AnalyzeContext,
  opts: AnalyzeOptions = {},
): Analysis {
  const cost = opts.cost ?? DEFAULT_COST;
  try {
    return analyzeUnguarded(template, ctx, cost);
  } catch (failure) {
    // Not expected — the fuzz oracle holds this at zero — but the contract is "never throws".
    const message = failure instanceof Error ? failure.message : String(failure);
    return {
      ok: false,
      deckSize: template.deckSize,
      handSize: template.hand.size,
      lines: [],
      remainder: {
        id: REMAINDER_ID,
        canonical: 'card',
        echo: 'Any card',
        count: 0,
        ...template.remainder,
        range: null,
        issues: [],
      },
      groups: [],
      requirements: [],
      limits: [],
      criteria: [],
      issues: [error('internal', `the analysis failed: ${message}`)],
      totals: {
        feasible: false,
        kinds: KINDS.map((kind) => ({ kind, lines: [], range: null })),
        lines: { min: 0, max: 0 },
        remainder: null,
      },
      classes: null,
      work: { rawRatios: null, classVectors: null, hands: null, estimatedMs: null, cost },
    };
  }
}
