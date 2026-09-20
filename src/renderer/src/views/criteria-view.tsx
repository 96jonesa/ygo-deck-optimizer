import { CRITERION_SYNTAX } from '../../../shared/syntax';
import { criterionAnalysisOf } from '../model/analysis-view';
import {
  criteriaIssues,
  type IgnoredRow,
  type LimitRow,
  limitRows,
  type NearMissRow,
  type RequirementRow,
  requirementRows,
} from '../model/criteria-readout';
import { selectAnalysis, useApp } from '../store';
import { CriterionRow } from './criterion-row';
import { IssueList } from './line-row';
import { SyntaxReference } from './syntax-reference';

// The criteria editor (PRD §8.3), and the two readouts that make the tool's
// semantics visible: which lines fill which requirement and why the others do
// not (PRD §6.4), and what a limit counts and what it cannot see (PRD §6.3).
// Every one of those facts is read off the `Analysis` (TDD §9) — the renderer
// arranges them and decides none of them.

/** A labelled line of a readout: `Filled by  A, level4`. */
function Fact({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <p className="readout-line" data-testid={testId}>
      <span className="readout-label">{label}</span>
      <span>{children}</span>
    </p>
  );
}

/** A list of line ids, or the reason there are none. */
function Lines({ lines, none }: { lines: readonly string[]; none: string }) {
  if (lines.length === 0) return <span className="dim">{none}</span>;
  return (
    <>
      {lines.map((line, at) => (
        <span key={line}>
          {at > 0 && ', '}
          <code>{line}</code>
        </span>
      ))}
    </>
  );
}

/**
 * One near miss: a line compatible with the requirement that does not imply
 * it, what it leaves unsaid, and — this is the affordance PRD §6.4 asks for —
 * the one click that splits the line `analyze` says would count off the
 * template. Quiet: a near miss is advice, not a fault.
 */
function NearMiss({ requirement, miss }: { requirement: string; miss: NearMissRow }) {
  const addSuggestedLine = useApp((state) => state.addSuggestedLine);
  const { suggestion } = miss;

  return (
    <p className="near-miss" data-testid={`near-miss-${requirement}-${miss.line}`}>
      <span className="readout-label">Near miss</span>
      <span>
        {miss.explanation}
        {suggestion !== null &&
          (miss.alreadyOn === null ? (
            <>
              {' '}
              <button
                type="button"
                className="link"
                data-testid={`near-miss-fix-${requirement}-${miss.line}`}
                onClick={() => addSuggestedLine(suggestion)}
              >
                Add a <code>{suggestion}</code> line
              </button>
            </>
          ) : (
            <span className="dim">
              {' '}
              — line <code>{miss.alreadyOn}</code> already says this
            </span>
          ))}
      </span>
    </p>
  );
}

/** What a count over the hand — a limit, or a requirement's ceiling — cannot see. */
function Ignored({ lines, total }: { lines: IgnoredRow[]; total: string }) {
  return (
    <>
      <strong className="tabular">{total}</strong> cards of lines that do not say whether they
      match:{' '}
      {lines.map((line, at) => (
        <span key={line.label}>
          {at > 0 && ', '}
          <code>{line.label}</code> <span className="dim">{line.range}</span>
        </span>
      ))}
    </>
  );
}

function Requirement({ row }: { row: RequirementRow }) {
  return (
    <li className="readout-row" data-testid={`requirement-${row.text}`}>
      <p className="readout-head">
        <code>{row.heading}</code> <span className="dim">{row.echo}</span>
      </p>
      <Fact label="Filled by" testId={`filled-by-${row.text}`}>
        <Lines lines={row.filledBy} none="no line — nothing in the deck can be it" />
      </Fact>
      {row.nearMisses.map((miss) => (
        <NearMiss key={miss.line} requirement={row.text} miss={miss} />
      ))}
      {/* A ceiling counts cards, so it is blind to the same lines a limit is. */}
      {row.ignoredRange !== null && (
        <Fact label="Ceiling ignores" testId={`requirement-ignores-${row.text}`}>
          <Ignored lines={row.ignored} total={row.ignoredRange} />
        </Fact>
      )}
      {/* A criterion's own name may hold commas — the example's do — so the
          separator between names cannot be one. */}
      <Fact label="Needed by">{row.neededBy.join(' · ')}</Fact>
      <IssueList issues={row.issues} />
    </li>
  );
}

function Limit({ row }: { row: LimitRow }) {
  return (
    <li className="readout-row" data-testid={`limit-${row.text}`}>
      <p className="readout-head">
        <code>{row.heading}</code> <span className="dim">{row.echo}</span>
      </p>
      <Fact label="Counts" testId={`limit-counts-${row.text}`}>
        <Lines lines={row.counts} none="no line — so it holds of every hand" />
      </Fact>
      {row.ignoredRange !== null && (
        <Fact label="Ignores" testId={`limit-ignores-${row.text}`}>
          <Ignored lines={row.ignored} total={row.ignoredRange} />
        </Fact>
      )}
      <Fact label="Applies to">{row.appliesTo.join(' · ')}</Fact>
      <IssueList issues={row.issues} />
    </li>
  );
}

/**
 * The criteria grouped by the hand they are judged for (PRD §5.5). Three
 * sections, not two: a criterion tagged `both` counts in each of the two runs,
 * and listing it under both headings would put one editable criterion on
 * screen twice. The headings say how to read the union instead —
 * **going first is the first section and the middle one together**, and going
 * second is the middle one and the last.
 *
 * The order within a section is the template's own, so moving a criterion up
 * or down still moves it through the whole list; a criterion whose tag the run
 * does not judge is dimmed rather than hidden.
 */
const SECTIONS = [
  {
    when: 'first' as const,
    title: 'Going first — a hand of 5',
    hint: 'Judged in a going-first run, and in the first half of an average.',
  },
  {
    when: 'both' as const,
    title: 'Either hand',
    hint: 'Judged in every run: written once, counted going first and going second.',
  },
  {
    when: 'second' as const,
    title: 'Going second — a hand of 6',
    hint: 'Judged in a going-second run, and in the second half of an average.',
  },
];

export function CriteriaView() {
  const criteria = useApp((state) => state.template.criteria);
  const handSize = useApp((state) => state.template.hand.size);
  const analysis = useApp(selectAnalysis);
  const problem = useApp((state) => state.analysis.problem);
  const addCriterion = useApp((state) => state.addCriterion);
  const dropCriterion = useApp((state) => state.dropCriterion);
  const setCriterionText = useApp((state) => state.setCriterionText);
  const setCriterionName = useApp((state) => state.setCriterionName);
  const setCriterionWhen = useApp((state) => state.setCriterionWhen);
  const moveCriterion = useApp((state) => state.moveCriterion);

  const requirements = requirementRows(analysis);
  const limits = limitRows(analysis);
  // Which section a criterion is in, and whether the run judges it, are the
  // ANALYSIS's answers (TDD §3): the renderer reads the tag it was given and
  // works out neither the default nor which part the mode scores.
  const foundOf = (id: string) => criterionAnalysisOf(analysis, id);
  const whenOf = (id: string, fallback: 'first' | 'second' | 'both') =>
    foundOf(id)?.when ?? fallback;

  const row = (criterion: (typeof criteria)[number], at: number) => (
    <CriterionRow
      key={criterion.id}
      criterion={criterion}
      found={foundOf(criterion.id)}
      handSize={handSize}
      uncounted={foundOf(criterion.id)?.counted === false}
      first={at === 0}
      last={at === criteria.length - 1}
      onText={(text) => setCriterionText(criterion.id, text)}
      onName={(name) => setCriterionName(criterion.id, name)}
      onWhen={(when) => setCriterionWhen(criterion.id, when)}
      onMove={(by) => moveCriterion(criterion.id, by)}
      onRemove={() => dropCriterion(criterion.id)}
    />
  );

  return (
    <section className="panel" data-region="criteria">
      <h2>Criteria</h2>
      <p className="hint">
        A hand succeeds if it meets <strong>any one</strong> criterion. Each is a list of
        requirements — <code>2x level 4 monster</code> — and limits — <code>no trap</code> — joined
        by <code>and</code>. Each criterion says which hand it is for; one that applies either way
        is written once.
      </p>
      <SyntaxReference section={CRITERION_SYNTAX} />

      {SECTIONS.map((section) => {
        const mine = criteria
          .map((criterion, at) => ({ criterion, at }))
          .filter(
            ({ criterion }) => whenOf(criterion.id, criterion.when ?? 'both') === section.when,
          );
        if (mine.length === 0) return null;
        return (
          <div key={section.when} data-testid={`criteria-${section.when}`}>
            <h3 className="criteria-heading">{section.title}</h3>
            <p className="hint flush">{section.hint}</p>
            <ul className="lines">{mine.map(({ criterion, at }) => row(criterion, at))}</ul>
          </div>
        );
      })}
      {criteria.length === 0 && (
        <p className="seam" data-testid="no-criteria">
          No criterion yet: every hand fails until there is one.
        </p>
      )}

      <div className="actions">
        <button type="button" onClick={addCriterion} data-testid="add-criterion">
          Add criterion
        </button>
      </div>
      <IssueList issues={criteriaIssues(analysis)} />
      {problem !== null && (
        <p className="line-error" data-testid="criteria-problem">
          {problem}
        </p>
      )}

      {/* What this readout is FOR — the implication rule and the one-click
          split — and not what the syntax of a requirement is, which the
          disclosure above now owns. */}
      <h3>Requirements</h3>
      <p className="hint flush">
        A line fills a requirement only if what it says <em>implies</em> it: a <code>monster</code>{' '}
        line does not count toward <code>level 4 or lower monster</code>, because its Level is
        unstated. Where one nearly does, the split that would count is one click away.
      </p>
      {requirements.length === 0 ? (
        <p className="seam" data-testid="no-requirements">
          Nothing is required yet: a criterion with a requirement in it fills this in.
        </p>
      ) : (
        <ul className="readouts" data-testid="requirements">
          {requirements.map((row) => (
            <Requirement key={row.text} row={row} />
          ))}
        </ul>
      )}

      {limits.length > 0 && (
        <>
          <h3>Limits</h3>
          <p className="hint flush">
            A limit counts <strong>only</strong> cards a line is specific enough to be known to
            match. Cards it cannot see are listed rather than assumed: if some of them really do
            match, give them a line that says so. A range requirement&rsquo;s ceiling counts cards
            the same way, and is blind to the same lines.
          </p>
          <ul className="readouts" data-testid="limits">
            {limits.map((row) => (
              <Limit key={row.text} row={row} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
