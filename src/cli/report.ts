import { countPrefix } from '../core/criteria/print';
import type { Analysis, Appearance, Issue, Severity } from '../core/model/analyze';
import { REMAINDER_ID } from '../core/model/compile';
import type { IntRange } from '../core/model/ranges';
import { formatCount } from '../core/util/count';

/**
 * The readable report of an `Analysis` (TDD §9), section by section: what was
 * understood, what matches what, and what it will cost. `analyze` prints all
 * of it; `estimate` prints the part its number is an estimate OF.
 */

export function int(value: number): string {
  return value.toLocaleString('en-US');
}

/** Left-aligned columns, except those named in `right`; two spaces apart, indented by two. */
export function table(rows: readonly (readonly string[])[], right: readonly number[] = []): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  return rows
    .map((row) =>
      `  ${row.map((cell, i) => (right.includes(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join('  ')}`.trimEnd(),
    )
    .join('\n');
}

/** `under 1 ms`, `12 ms`, `3.4 s`, `5.2 min`, `7.1 h`, `12 days`. */
export function formatDuration(ms: number): string {
  if (ms < 1) return 'under 1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${int(Math.round(ms / 86_400_000))} days`;
}

const nameOf = (id: string): string => (id === REMAINDER_ID ? '(remainder)' : id);
const namesOf = (ids: readonly string[]): string =>
  ids.length === 0 ? '(no line)' : ids.map(nameOf).join(', ');
const span = ({ min, max }: IntRange): string => (min === max ? `${min}` : `${min}–${max}`);

/** Each line as it was understood; `counts` adds the copies an estimate is run at, the remainder's last. */
export function templateSection(
  a: Analysis,
  templatePath: string,
  counts?: readonly number[],
): string {
  const header = ['line', 'description', 'understood as', 'matches', 'range'];
  const rows = a.lines.map((line) => [
    line.id,
    line.text,
    line.parsed.ok ? (line.parsed.echo ?? '') : '(not understood)',
    line.count === null ? '-' : int(line.count),
    `${line.min}-${line.max}`,
  ]);
  const { remainder } = a;
  rows.push([
    nameOf(remainder.id),
    remainder.canonical,
    remainder.echo,
    int(remainder.count),
    remainder.max === null ? `${remainder.min}+` : `${remainder.min}-${remainder.max}`,
  ]);
  if (counts !== undefined) {
    header.push('count');
    rows.forEach((row, i) => {
      row.push(String(counts[i]));
    });
  }
  return [
    `Template — ${templatePath}: deck of ${a.deckSize}, hand of ${a.handSize}`,
    table([header, ...rows], [3, 5]),
  ].join('\n');
}

export function criteriaSection(a: Analysis): string {
  const out = ['Criteria — a hand succeeds if it meets any one'];
  for (const criterion of a.criteria) {
    const title =
      criterion.name === undefined ? criterion.id : `${criterion.id} (${criterion.name})`;
    out.push(`  ${title}: ${criterion.text}`);
    if (!criterion.parsed.ok) out.push('      (not understood)');
    criterion.alternatives.forEach((alternative, i) => {
      out.push(`      ${i + 1}. ${alternative}`);
    });
    if (criterion.dropped > 0)
      out.push(`      (${criterion.dropped} more need over ${a.handSize} cards: never met)`);
  }
  if (a.criteria.length === 0) out.push('  (none)');
  if (a.classes !== null)
    out.push(`  judged as ${a.classes.alternatives} distinct flat alternative(s)`);
  return out.join('\n');
}

/**
 * The counts a requirement or a limit appears under, as the criteria editor
 * writes them: distinct counts joined by `/`, and a range kept apart from the
 * plain count it would otherwise read as — `1x monster` and `1-2x monster` are
 * different criteria and must not print alike.
 */
function countsOf(
  appearsIn: readonly Appearance[],
  say: (appearance: Appearance) => string,
): string {
  const seen = new Map<string, Appearance>();
  for (const appearance of appearsIn)
    seen.set(`${appearance.n}-${appearance.max ?? ''}`, appearance);
  return [...seen.values()]
    .sort(
      (x, y) =>
        x.n - y.n || (x.max ?? Number.POSITIVE_INFINITY) - (y.max ?? Number.POSITIVE_INFINITY),
    )
    .map(say)
    .join(' / ');
}

/** Filled-by and near misses per requirement, the readout per limit, and the lines that match nothing. */
export function matchingSection(a: Analysis): string {
  const out = [
    'Matching — a line fills a requirement, or counts toward a limit, only if its description implies it',
  ];
  const rows = [
    ...a.requirements.map((r) => [
      'requirement',
      `${countsOf(r.appearsIn, ({ n, max }) => countPrefix(n, max))} ${r.text}`,
      `[${r.echo}]`,
      `filled by: ${namesOf(r.filledBy)}`,
    ]),
    ...a.limits.map((l) => [
      'limit',
      `${countsOf(l.appearsIn, ({ n }) => (n === 0 ? 'no' : `at most ${n}x`))} ${l.text}`,
      `[${l.echo}]`,
      `counts: ${namesOf(l.counts)}`,
    ]),
  ];
  const aligned = rows.length === 0 ? [] : table(rows).split('\n');
  a.requirements.forEach((requirement, i) => {
    out.push(aligned[i]!);
    // Lines that miss for the same reason, with the same way out, read as one. That a generic
    // line is not the named card is only worth saying while no line IS that card.
    const grouped = new Map<string, string[]>();
    for (const miss of requirement.nearMisses) {
      if (miss.dimension === 'named' && requirement.filledBy.length > 0) continue;
      const what = miss.explanation.slice(miss.explanation.indexOf(': ') + 2);
      const advice =
        miss.suggestion === undefined ? what : `${what}; a \`${miss.suggestion}\` line would count`;
      grouped.set(advice, [...(grouped.get(advice) ?? []), nameOf(miss.line)]);
    }
    for (const [advice, lines] of grouped)
      out.push(`      near miss: ${lines.join(', ')} — ${advice}`);
    // A ceiling counts cards, so it has a limit's blind spot and says so the same way.
    if (requirement.ignored.length === 0) return;
    const each = requirement.ignored
      .map((line) => `${nameOf(line.line)} (${span(line)})`)
      .join(', ');
    const total =
      requirement.ignoredRange === null ? '' : ` — ${span(requirement.ignoredRange)} cards in all`;
    out.push(`      the ceiling ignores: ${each}${total}`);
  });
  a.limits.forEach((limit, i) => {
    out.push(aligned[a.requirements.length + i]!);
    if (limit.ignored.length === 0) return;
    const each = limit.ignored.map((line) => `${nameOf(line.line)} (${span(line)})`).join(', ');
    const total = limit.ignoredRange === null ? '' : ` — ${span(limit.ignoredRange)} cards in all`;
    out.push(`      ignores: ${each}${total}`);
  });
  if (rows.length === 0) out.push('  (nothing is required or limited)');

  const matched = new Set([
    ...a.requirements.flatMap((r) => r.filledBy),
    ...a.limits.flatMap((l) => l.counts),
  ]);
  const idle = [
    ...a.lines.filter((line) => line.parsed.ok).map((line) => line.id),
    a.remainder.id,
  ].filter((id) => !matched.has(id));
  if (idle.length > 0)
    out.push(`  match nothing, so they cannot affect the odds: ${namesOf(idle)}`);
  return out.join('\n');
}

export function totalsSection(a: Analysis): string {
  const out = ['Totals — read off the lines; nothing states a total'];
  const rows = a.totals.kinds.map(({ kind, lines, range }) => [
    `Known ${kind}s`,
    range === null ? '-' : span(range),
    namesOf(lines),
  ]);
  rows.push([
    'Unspecified',
    a.totals.remainder === null ? '-' : span(a.totals.remainder),
    `what the lines (${span(a.totals.lines)} cards) leave of a deck of ${a.deckSize}`,
  ]);
  out.push(table(rows, [1]));
  if (!a.totals.feasible) out.push('  the ranges cannot sum to the deck size');
  return out.join('\n');
}

export function classesSection(a: Analysis): string {
  const out = ['Classes — lines the criteria cannot tell apart are scored as one'];
  if (a.classes === null)
    return [...out, '  (not available until every error is fixed)'].join('\n');
  out.push(
    table(
      a.classes.classes.map(({ lines, min, max }, cls) => [
        cls === 0 ? '0 (blank)' : String(cls),
        span({ min, max }),
        lines.length === 0 ? '(empty)' : namesOf(lines),
      ]),
      [1],
    ),
  );
  for (const { text, n, reason } of a.classes.droppedLimits)
    out.push(
      `  the limit \`${n === 0 ? 'no' : `at most ${n}x`} ${text}\` holds of every hand and is left out: ${
        reason === 'counts-nothing' ? 'no line counts against it' : 'no hand holds more cards'
      }`,
    );
  for (const { text, n, max, reason } of a.classes.droppedCeilings)
    out.push(
      `  the ceiling of \`${n}-${max}x ${text}\` can never be exceeded and is left out, leaving \`${n}x ${text}\`: ${
        reason === 'counts-nothing' ? 'no line fills it' : 'no hand holds more cards'
      }`,
    );
  return out.join('\n');
}

export function workSection(a: Analysis): string {
  const { rawRatios, classVectors, hands, estimatedMs } = a.work;
  const rows = [
    ['raw ratios', rawRatios === null ? '-' : formatCount(rawRatios)],
    ['class vectors', classVectors === null ? '-' : formatCount(classVectors)],
    [
      'terms per score',
      hands === null
        ? '-'
        : hands
            .map(
              ({ H, terms, complemented }) =>
                `${int(terms)} at a hand of ${H}${complemented ? ' (failing hands, subtracted)' : ''}`,
            )
            .join('; '),
    ],
    ['estimated time', estimatedMs === null ? '-' : formatDuration(estimatedMs)],
  ];
  return ['Work — what an exhaustive run would score', table(rows)].join('\n');
}

const SECTION_TITLES: Record<Severity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  notice: 'Notices',
};

/** Every issue of the given severities, each under its heading and named by where it belongs. */
export function issueSections(a: Analysis, severities: readonly Severity[]): string[] {
  const located: [string, readonly Issue[]][] = [
    ['', a.issues],
    ['the remainder: ', a.remainder.issues],
    ...a.lines.map((line): [string, Issue[]] => [`line ${JSON.stringify(line.id)}: `, line.issues]),
    ...a.groups.map((g): [string, Issue[]] => [`group ${JSON.stringify(g.id)}: `, g.issues]),
    // A requirement's or a limit's message names its description itself.
    ...a.requirements.map((r): [string, Issue[]] => ['', r.issues]),
    ...a.limits.map((l): [string, Issue[]] => ['', l.issues]),
    ...a.criteria.map((c): [string, Issue[]] => [`criterion ${JSON.stringify(c.id)}: `, c.issues]),
  ];
  return severities.flatMap((severity) => {
    const messages = located.flatMap(([prefix, issues]) =>
      issues.filter((issue) => issue.severity === severity).map((i) => `  ${prefix}${i.message}`),
    );
    return messages.length === 0 ? [] : [[SECTION_TITLES[severity], ...messages].join('\n')];
  });
}

/** The whole analysis, as `analyze` prints it. */
export function formatAnalysis(a: Analysis, templatePath: string): string {
  const sections = [
    templateSection(a, templatePath),
    criteriaSection(a),
    matchingSection(a),
    totalsSection(a),
    classesSection(a),
    workSection(a),
    ...issueSections(a, ['error', 'warning', 'notice']),
  ];
  return `${sections.join('\n\n')}\n`;
}

/** What an estimate is an estimate OF: the template at the chosen counts, and what matches what. */
export function formatEstimateReport(
  a: Analysis,
  templatePath: string,
  counts: readonly number[],
): string {
  const remainder = a.deckSize - counts.reduce((sum, n) => sum + n, 0);
  const sections = [
    templateSection(a, templatePath, [...counts, remainder]),
    criteriaSection(a),
    matchingSection(a),
    ...issueSections(a, ['warning', 'notice']),
  ];
  return `${sections.join('\n\n')}\n`;
}
