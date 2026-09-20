import type {
  Analysis,
  Appearance,
  CriterionAnalysis,
  IgnoredLine,
  IntRange,
  Issue,
  IssueCode,
  NearMissAnalysis,
} from '../../../shared/types';
import { rangeLabel } from './copy-range';

// The readouts PRD §6.3–6.4 asks for: which lines fill a requirement, which
// ones nearly do and what they leave unsaid, and what a limit counts and
// ignores. Every one of those judgements is `analyze`'s (TDD §9); this file
// looks them up, labels them and puts them in reading order. Nothing here
// decides whether a line fills anything — the moment it did, the screen would
// start disagreeing with the optimizer.

/** The label a line goes by in a readout: its id, or `the remainder` for the computed row. */
export function lineLabel(analysis: Analysis | null, id: string): string {
  return analysis !== null && id === analysis.remainder.id ? 'the remainder' : id;
}

/** What a criterion is called: the name the user gave it, else the id its row is headed with. */
export function criterionLabel(analysis: Analysis | null, id: string): string {
  const found = analysis?.criteria.find((criterion) => criterion.id === id);
  return found?.name ?? id;
}

/**
 * The canonical printed form, when it is not what the user typed — `1x
 * [Elemental HERO Stratos], …` reads back as `1x #40044918 and …`. Shown
 * beside the text so that what will be scored is never a guess; left out when
 * the two are the same string, where repeating it would say nothing.
 */
export function canonicalText(found: CriterionAnalysis | null): string | null {
  if (found === null || !found.parsed.ok) return null;
  return found.parsed.canonical === found.text ? null : found.parsed.canonical;
}

export interface ExpansionPreview {
  /** Canonical text of each flat alternative, in `analyze`'s order. */
  alternatives: string[];
  /** What was left out for needing more cards than a hand holds; `null` when nothing was. */
  dropped: string | null;
}

/**
 * The flat alternatives a criterion expands to (PRD §5.3), so the user can
 * confirm what will actually be scored. Left out for the ordinary criterion of
 * one alternative, whose canonical form already is that alternative: the
 * preview earns its space when an `OR` made more of them, or when some were
 * dropped and the reader has to be told why there are fewer than they wrote.
 */
export function expansionPreview(
  found: CriterionAnalysis | null,
  handSize: number,
): ExpansionPreview | null {
  if (found === null) return null;
  const { alternatives, dropped } = found;
  if (alternatives.length < 2 && dropped === 0) return null;
  const many = dropped !== 1;
  return {
    alternatives: [...alternatives],
    dropped:
      dropped === 0
        ? null
        : `${dropped} alternative${many ? 's' : ''} need${many ? '' : 's'} more than the ${handSize} cards of a hand, and ${many ? 'were' : 'was'} dropped`,
  };
}

/**
 * The counts a requirement or a limit appears under, written the way a
 * criterion writes them. Two appearances are the same count only when BOTH
 * ends agree: `1x` and `1-2x` are different things and read as `1x / 1-2x`.
 */
function countsOf(
  appearsIn: readonly Appearance[],
  say: (n: number, max: number | undefined) => string,
): string {
  const seen = new Map<string, Appearance>();
  for (const appearance of appearsIn)
    seen.set(`${appearance.n}-${appearance.max ?? ''}`, appearance);
  return [...seen.values()]
    .sort((a, b) => a.n - b.n || (a.max ?? Infinity) - (b.max ?? Infinity))
    .map(({ n, max }) => say(n, max))
    .join(' / ');
}

/** The criteria a requirement or limit belongs to, each named once, in the order they appear. */
function criteriaOf(analysis: Analysis, appearsIn: readonly Appearance[]): string[] {
  const ids = [...new Set(appearsIn.map((appearance) => appearance.criterion))];
  return ids.map((id) => criterionLabel(analysis, id));
}

export interface NearMissRow {
  /** The line's id, as `analyze` gave it. */
  line: string;
  /** What to call it on screen. */
  label: string;
  /** `` `monster`: Level unstated `` — `analyze`'s own sentence. */
  explanation: string;
  /** Canonical text of a line that WOULD fill the requirement; `null` when none can be written. */
  suggestion: string | null;
  /** The line that already says exactly that, when the split has been made; else `null`. */
  alreadyOn: string | null;
}

export interface RequirementRow {
  /** Canonical description: the identity of the requirement, and its test id. */
  text: string;
  /** `1x monster`. */
  heading: string;
  /** `Level 4 or lower · Monster`. */
  echo: string;
  /** The lines that fill it, in template order, labelled. */
  filledBy: string[];
  nearMisses: NearMissRow[];
  /** The criteria that ask for it. */
  neededBy: string[];
  /** Some appearance of it has a ceiling, so what the ceiling cannot see is worth showing. */
  bounded: boolean;
  /** When bounded: the under-specified lines the ceiling does not count, each with its own range. */
  ignored: IgnoredRow[];
  /** What those lines hold together — `13–33`; `null` when there are none. */
  ignoredRange: string | null;
  issues: Issue[];
}

/** The line whose description MEANS exactly this, whatever it was typed as; `null` when none does. */
function lineSaying(analysis: Analysis, canonical: string): string | null {
  const found = analysis.lines.find(
    (line) => line.parsed.ok && line.parsed.canonical === canonical,
  );
  return found?.id ?? null;
}

function nearMissRow(analysis: Analysis, miss: NearMissAnalysis): NearMissRow {
  const suggestion = miss.suggestion ?? null;
  return {
    line: miss.line,
    label: lineLabel(analysis, miss.line),
    explanation: miss.explanation,
    suggestion,
    alreadyOn: suggestion === null ? null : lineSaying(analysis, suggestion),
  };
}

/**
 * Per distinct requirement: what fills it and what nearly does (PRD §6.4).
 *
 * One near miss is filtered, on TDD §9's instruction: "Every generic line is
 * technically a near miss of a named-card requirement; those are kept in the
 * data but hidden once some line fills the requirement, since a generic line
 * stands for cards other than the template's named ones." Both halves of that
 * test are `analyze`'s own facts — the miss's `reason` and the requirement's
 * `filledBy` — so this hides advice, it does not decide anything.
 */
export function requirementRows(analysis: Analysis | null): RequirementRow[] {
  if (analysis === null) return [];
  return analysis.requirements.map((requirement) => {
    const filled = requirement.filledBy.length > 0;
    const misses = filled
      ? requirement.nearMisses.filter((miss) => miss.reason !== 'named')
      : requirement.nearMisses;
    return {
      text: requirement.text,
      heading: `${countsOf(requirement.appearsIn, countLabel)} ${requirement.text}`,
      echo: requirement.echo,
      filledBy: requirement.filledBy.map((id) => lineLabel(analysis, id)),
      nearMisses: misses.map((miss) => nearMissRow(analysis, miss)),
      neededBy: criteriaOf(analysis, requirement.appearsIn),
      bounded: requirement.bounded,
      ignored: ignoredRows(analysis, requirement.ignored),
      ignoredRange: rangeOrNull(requirement.ignoredRange),
      issues: requirement.issues,
    };
  });
}

/** `1x`, or `1-2x` for a range: what `analyze` and the criterion text both call it. */
function countLabel(n: number, max: number | undefined): string {
  return max === undefined ? `${n}x` : `${n}-${max}x`;
}

export interface IgnoredRow {
  label: string;
  /** `13–33`: how many cards that line could be holding, unseen by the limit or the ceiling. */
  range: string;
}

function ignoredRows(analysis: Analysis, ignored: readonly IgnoredLine[]): IgnoredRow[] {
  return ignored.map((line) => ({
    label: lineLabel(analysis, line.line),
    range: rangeLabel(line.min, line.max),
  }));
}

const rangeOrNull = (range: IntRange | null) =>
  range === null ? null : rangeLabel(range.min, range.max);

export interface LimitRow {
  text: string;
  /** `at most 1x trap`, or `no trap`. */
  heading: string;
  echo: string;
  /** The lines whose cards count against it: those known to match (PRD §6.3). */
  counts: string[];
  /** The under-specified lines it does not count, each with its own range. */
  ignored: IgnoredRow[];
  /** What those lines hold together — `13–33`; `null` when there are none. */
  ignoredRange: string | null;
  appliesTo: string[];
  issues: Issue[];
}

/**
 * Per limit: what it counts, and — the point of F1 — what it cannot see. A
 * limit counts only cards a line is specific enough to be KNOWN to match (PRD
 * §6.3), so the cards it ignores are named and totalled rather than quietly
 * left out; `analyze`'s `limit-ignores` notice says the same thing in words,
 * and comes along in `issues`.
 */
export function limitRows(analysis: Analysis | null): LimitRow[] {
  if (analysis === null) return [];
  return analysis.limits.map((limit) => ({
    text: limit.text,
    heading: `${countsOf(limit.appearsIn, (n) => (n === 0 ? 'no' : `at most ${n}x`))} ${limit.text}`,
    echo: limit.echo,
    counts: limit.counts.map((id) => lineLabel(analysis, id)),
    ignored: ignoredRows(analysis, limit.ignored),
    ignoredRange: rangeOrNull(limit.ignoredRange),
    appliesTo: criteriaOf(analysis, limit.appearsIn),
    issues: limit.issues,
  }));
}

/**
 * The issues `analyze` files against the template as a whole that are about
 * the CRITERIA — there being none, the expansion passing its cap, subsumption
 * going unchecked — so that they are read where they apply. The rest of
 * `analysis.issues` is the deck's, and belongs to the template editor.
 */
const CRITERIA_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>([
  'no-criteria',
  'subsumption-skipped',
  'expansion-cap',
]);

export function criteriaIssues(analysis: Analysis | null): Issue[] {
  return (analysis?.issues ?? []).filter((issue) => CRITERIA_CODES.has(issue.code));
}
