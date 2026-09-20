import type { CriterionAnalysis, TemplateCriterion } from '../../../shared/types';
import { issuesToList, parseFailureOf, worstSeverity } from '../model/analysis-view';
import { canonicalText, expansionPreview } from '../model/criteria-readout';
import { CRITERION_WHENS, type CriterionWhen, WHEN_LABELS } from '../model/deck-form';
import { CompletingInput } from './completing-input';
import { useField } from './fields';
import { IssueList, ParseFailure } from './line-row';

// One criterion of the template: what it says, what the tool understood of it,
// and — where an `OR` made more than one of them — the flat alternatives it
// will actually be scored as (PRD §5.3). The row is the line row's markup down
// to the class names, so the two editors line up in the same left column.

export interface CriterionRowProps {
  criterion: TemplateCriterion;
  /** What `analyze` made of it; `null` while the analysis is one edit behind. */
  found: CriterionAnalysis | null;
  /** The hand the alternatives were expanded for, which is what a drop is measured against. */
  handSize: number;
  /** The run does not judge this criterion: its tag is for the other hand. */
  uncounted: boolean;
  first: boolean;
  last: boolean;
  onText: (text: string) => void;
  onName: (name: string) => void;
  onWhen: (when: CriterionWhen) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}

export function CriterionRow({
  criterion,
  found,
  handSize,
  uncounted,
  first,
  last,
  onText,
  onName,
  onWhen,
  onMove,
  onRemove,
}: CriterionRowProps) {
  const { id } = criterion;
  const [text, setText] = useField(criterion.text);
  const [name, setName] = useField(criterion.name ?? '');
  const failure = parseFailureOf(found);
  const canonical = canonicalText(found);
  const preview = expansionPreview(found, handSize);
  const issues = issuesToList(found);
  const severity = worstSeverity(found?.issues ?? []);
  // The tag comes off the ANALYSIS, which is where the default lives (TDD
  // §3); the template's own field is only what the picker writes back.
  const when = found?.when ?? criterion.when ?? 'both';

  return (
    <li
      className={[
        severity === 'error' ? 'line criterion bad' : 'line criterion',
        uncounted ? 'off' : '',
      ]
        .join(' ')
        .trim()}
      data-testid={`criterion-${id}`}
    >
      <div className="line-main">
        <span className="line-id" title="a criterion">
          {id}
        </span>
        <CompletingInput
          id={`criterion-text-${id}`}
          value={text}
          label={`Criterion ${id}`}
          placeholder="1x [Ash Blossom], 1x monster, at most 1x [Brick]"
          onChange={(next) => {
            setText(next);
            onText(next);
          }}
        />
        {/*
          The name sits on a second grid row of its own, under the text and in
          its column: a criterion is long — the example's is 70 characters —
          and sharing one row with a name field left it showing about twenty.
          It stays here in the DOM, between the text and the buttons, so that
          tabbing through the row still goes text, name, move, move, remove.
        */}
        <input
          type="text"
          className="criterion-name"
          value={name}
          aria-label={`Name of criterion ${id}`}
          data-testid={`criterion-name-${id}`}
          placeholder="name this criterion (optional)"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
            onName(event.target.value);
          }}
        />
        {/* Which hand judges it (PRD §5.5). A select rather than toggles: it
            sits on the row beside a 70-character criterion, and three buttons
            would not fit; the section it is filed under is the visible half
            of the same fact. */}
        <select
          className="criterion-when"
          value={when}
          aria-label={`Which hand criterion ${id} is judged for`}
          data-testid={`criterion-when-${id}`}
          onChange={(event) => onWhen(event.target.value as CriterionWhen)}
        >
          {CRITERION_WHENS.map((option) => (
            <option key={option} value={option}>
              {WHEN_LABELS[option]}
            </option>
          ))}
        </select>
        <span className="line-buttons">
          {/* `aria-disabled` rather than `disabled`, for the reason `LineRow` gives. */}
          <button
            type="button"
            className={first ? 'quiet icon off' : 'quiet icon'}
            aria-disabled={first}
            aria-label={`Move criterion ${id} up`}
            onClick={() => {
              if (!first) onMove(-1);
            }}
          >
            {'↑'}
          </button>
          <button
            type="button"
            className={last ? 'quiet icon off' : 'quiet icon'}
            aria-disabled={last}
            aria-label={`Move criterion ${id} down`}
            onClick={() => {
              if (!last) onMove(1);
            }}
          >
            {'↓'}
          </button>
          <button
            type="button"
            className="quiet icon"
            aria-label={`Remove criterion ${id}`}
            onClick={onRemove}
          >
            {'×'}
          </button>
        </span>
      </div>

      <div className="line-readout" data-testid={`criterion-readout-${id}`}>
        {uncounted && (
          <p className="line-echo dim" data-testid={`criterion-uncounted-${id}`}>
            This run does not judge it: it is for {WHEN_LABELS[when]}.
          </p>
        )}
        {failure !== null ? (
          <ParseFailure
            text={criterion.text}
            message={failure.message}
            span={failure.span}
            testId={`criterion-parse-error-${id}`}
          />
        ) : (
          canonical !== null && (
            <p className="line-echo">
              <code data-testid={`criterion-canonical-${id}`}>{canonical}</code>
            </p>
          )
        )}
        {preview !== null && (
          <div className="alternatives" data-testid={`criterion-alternatives-${id}`}>
            <p className="line-echo">
              <span className="readout-label">Scored as</span>
              {preview.alternatives.length === 1
                ? ' 1 alternative'
                : ` any of ${preview.alternatives.length} alternatives`}
            </p>
            <ol>
              {preview.alternatives.map((alternative) => (
                <li key={alternative}>
                  <code>{alternative}</code>
                </li>
              ))}
            </ol>
            {preview.dropped !== null && (
              <p className="line-echo" data-testid={`criterion-dropped-${id}`}>
                {preview.dropped}
              </p>
            )}
          </div>
        )}
        <IssueList issues={issues} />
      </div>
    </li>
  );
}
