import { criterionAnalysisOf } from '../model/analysis-view';
import {
  criteriaIssues,
  type LimitRow,
  limitRows,
  type NearMissRow,
  type RequirementRow,
  requirementRows,
} from '../model/criteria-readout';
import { selectAnalysis, useApp } from '../store';
import { CriterionRow } from './criterion-row';
import { IssueList } from './line-row';

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
          <strong className="tabular">{row.ignoredRange}</strong> cards of lines that do not say
          whether they match:{' '}
          {row.ignored.map((line, at) => (
            <span key={line.label}>
              {at > 0 && ', '}
              <code>{line.label}</code> <span className="dim">{line.range}</span>
            </span>
          ))}
        </Fact>
      )}
      <Fact label="Applies to">{row.appliesTo.join(' · ')}</Fact>
      <IssueList issues={row.issues} />
    </li>
  );
}

export function CriteriaView() {
  const criteria = useApp((state) => state.template.criteria);
  const handSize = useApp((state) => state.template.hand.size);
  const analysis = useApp(selectAnalysis);
  const problem = useApp((state) => state.analysis.problem);
  const addCriterion = useApp((state) => state.addCriterion);
  const dropCriterion = useApp((state) => state.dropCriterion);
  const setCriterionText = useApp((state) => state.setCriterionText);
  const setCriterionName = useApp((state) => state.setCriterionName);
  const moveCriterion = useApp((state) => state.moveCriterion);

  const requirements = requirementRows(analysis);
  const limits = limitRows(analysis);

  return (
    <section className="panel" data-region="criteria">
      <h2>Criteria</h2>
      <p className="hint">
        A hand succeeds if it meets <strong>any one</strong> criterion. Each is a list of
        requirements — <code>1x [Ash Blossom]</code> — and limits — <code>at most 1x [Brick]</code>{' '}
        — joined by <code>and</code>, with <code>or</code> in parentheses for alternatives that
        differ (PRD §5.3).
      </p>

      <ul className="lines" data-testid="criteria">
        {criteria.map((criterion, at) => (
          <CriterionRow
            key={criterion.id}
            criterion={criterion}
            found={criterionAnalysisOf(analysis, criterion.id)}
            handSize={handSize}
            first={at === 0}
            last={at === criteria.length - 1}
            onText={(text) => setCriterionText(criterion.id, text)}
            onName={(name) => setCriterionName(criterion.id, name)}
            onMove={(by) => moveCriterion(criterion.id, by)}
            onRemove={() => dropCriterion(criterion.id)}
          />
        ))}
      </ul>

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

      <h3>Requirements</h3>
      <p className="hint flush">
        A line fills a requirement only if what it says <em>implies</em> it (PRD §6.2): a{' '}
        <code>monster</code> line does not count toward <code>level 4 or lower monster</code>,
        because its Level is unstated. Where one nearly does, the split that would count is one
        click away.
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
            match (PRD §6.3). Cards it cannot see are listed rather than assumed: if some of them
            really do match, give them a line that says so.
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
