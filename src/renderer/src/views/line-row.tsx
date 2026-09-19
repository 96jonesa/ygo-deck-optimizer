import type {
  CardHit,
  CardState,
  Issue,
  LineAnalysis,
  Span,
  TemplateLine,
} from '../../../shared/types';
import {
  echoText,
  issuesToList,
  issueTone,
  matchText,
  parseFailureOf,
  worstSeverity,
} from '../model/analysis-view';
import { type CopyRange, NAMED_CARD_MAX } from '../model/copy-range';
import { splitAtSpan } from '../model/span';
import { isCardLine } from '../model/template-edit';
import { CardPicker } from './card-picker';
import { CopyRangeField, useField } from './fields';

// One line of the template: what it says, what the tool understood of it, and
// what is wrong with it. A dense row — this list holds 10 to 30 of them and
// has to stay scannable — with everything the analysis says folded under the
// input as secondary text, quiet unless it is an error.

export function IssueList({ issues }: { issues: readonly Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="issues">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.message}`} className={issueTone(issue.severity)}>
          <span className="tag">{issue.severity}</span> {issue.message}
        </li>
      ))}
    </ul>
  );
}

/** The parse error, with the word it is about marked in a copy of the text. */
function ParseFailure({ text, message, span }: { text: string; message: string; span: Span }) {
  const { before, at, after } = splitAtSpan(text, span);
  return (
    <p className="line-error" data-testid="line-parse-error">
      {message}
      {text.trim() !== '' && (
        <>
          {' '}
          <code>
            {before}
            <mark>{at === '' ? '⟨here⟩' : at}</mark>
            {after}
          </code>
        </>
      )}
    </p>
  );
}

export interface LineRowProps {
  line: TemplateLine;
  /** What `analyze` made of it; `null` while the analysis is one edit behind. */
  found: LineAnalysis | null;
  /** The display fields of a named card, as far as they are known. */
  known: CardHit | null;
  cardState: CardState;
  /** The most copies a line may be set to. */
  deckSize: number;
  first: boolean;
  last: boolean;
  onText: (text: string) => void;
  onRange: (range: CopyRange) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}

export function LineRow({
  line,
  found,
  known,
  cardState,
  deckSize,
  first,
  last,
  onText,
  onRange,
  onMove,
  onRemove,
}: LineRowProps) {
  const named = isCardLine(line);
  const [text, setText] = useField(named ? '' : line.text);
  const echo = echoText(found);
  const matches = matchText(found);
  const failure = parseFailureOf(found);
  const issues = issuesToList(found);
  const severity = worstSeverity(found?.issues ?? []);

  const hit: CardHit | null = named
    ? (known ?? {
        passcode: line.card.passcode,
        name: line.card.name,
        typeline: `#${line.card.passcode}`,
      })
    : null;

  return (
    <li className={severity === 'error' ? 'line bad' : 'line'} data-testid={`line-${line.id}`}>
      <div className="line-main">
        <span className="line-id" title={named ? 'a named card' : 'a description'}>
          {line.id}
        </span>
        {hit !== null ? (
          <CardPicker
            id={`pick-${line.id}`}
            label={`Card on line ${line.id}`}
            value={hit}
            cardState={cardState}
            onPick={(card) => {
              if (card === null) onRemove();
            }}
          />
        ) : (
          <input
            type="text"
            className="desc"
            value={text}
            aria-label={`Description on line ${line.id}`}
            data-testid={`text-${line.id}`}
            placeholder="level 4 or lower monster"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setText(event.target.value);
              onText(event.target.value);
            }}
          />
        )}
        <CopyRangeField
          range={{ min: line.min, max: line.max }}
          onChange={onRange}
          cap={deckSize}
          soft={named ? NAMED_CARD_MAX : deckSize}
          label={`line ${line.id}`}
        />
        <span className="line-buttons">
          {/*
            `aria-disabled`, not `disabled`: a line is moved by pressing the
            same button over and over, and a button that goes truly disabled
            under the finger drops focus to <body> at the last press — found
            by driving the app from the keyboard. This keeps the stop in the
            tab order, says it is unavailable, and does nothing when pressed.
          */}
          <button
            type="button"
            className={first ? 'quiet icon off' : 'quiet icon'}
            aria-disabled={first}
            aria-label={`Move line ${line.id} up`}
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
            aria-label={`Move line ${line.id} down`}
            onClick={() => {
              if (!last) onMove(1);
            }}
          >
            {'↓'}
          </button>
          <button
            type="button"
            className="quiet icon"
            aria-label={`Remove line ${line.id}`}
            onClick={onRemove}
          >
            {'×'}
          </button>
        </span>
      </div>

      <div className="line-readout" data-testid={`readout-${line.id}`}>
        {failure !== null ? (
          <ParseFailure
            text={named ? '' : line.text}
            message={failure.message}
            span={failure.span}
          />
        ) : (
          echo !== null && (
            <p className="line-echo">
              <strong>{echo}</strong>
              {matches !== null && <span className="dim"> · {matches}</span>}
            </p>
          )
        )}
        <IssueList issues={issues} />
      </div>
    </li>
  );
}
