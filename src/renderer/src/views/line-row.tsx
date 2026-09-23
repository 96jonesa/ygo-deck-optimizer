import type {
  CardHit,
  CardState,
  Issue,
  LineAnalysis,
  Span,
  TemplateGroup,
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
import type { CopyRange } from '../model/copy-range';
import {
  commitDrawN,
  DRAW_MAX,
  DRAW_MIN,
  DRAW_NEW_N,
  type DrawDraft,
  drawLineText,
} from '../model/draw-view';
import { splitAtSpan } from '../model/span';
import { groupBoxes, isCardLine } from '../model/template-edit';
import { CardPicker } from './card-picker';
import { CompletingInput } from './completing-input';
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

/**
 * The parse error, with the word it is about marked in a copy of the text.
 * Shared with the criterion row, whose text is parsed by a different grammar
 * (TDD §7) but read back exactly the same way.
 */
export function ParseFailure({
  text,
  message,
  span,
  testId = 'line-parse-error',
}: {
  text: string;
  message: string;
  span: Span;
  testId?: string;
}) {
  const { before, at, after } = splitAtSpan(text, span);
  return (
    <p className="line-error" data-testid={testId}>
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

/**
 * The draw marker (PRD §5.7): a tick that makes the line a draw card, and — only
 * once it is one — how many cards a copy draws and whether only the first copy
 * is played. It sits on a second row of the grid, in the text's column, for the
 * reason the criterion's name does: the row above is already id, text, range and
 * three buttons, and a description is long.
 *
 * The number field is live rather than committed on blur: `commitDrawN` clamps
 * every keystroke into the bounds `core` enforces, so there is no intermediate
 * value the template could be left holding.
 */
function DrawMarker({
  line,
  onDraw,
}: {
  line: TemplateLine;
  onDraw: (draw: DrawDraft | null) => void;
}) {
  const { draw } = line;
  const [n, setN] = useField(String(draw?.n ?? DRAW_NEW_N));

  return (
    <span className="line-draw" data-testid={`draw-${line.id}`}>
      <label htmlFor={`draws-${line.id}`}>
        <input
          type="checkbox"
          id={`draws-${line.id}`}
          data-testid={`draws-${line.id}`}
          checked={draw !== undefined}
          onChange={(event) =>
            onDraw(event.target.checked ? { n: commitDrawN(n, DRAW_NEW_N) } : null)
          }
        />{' '}
        draws
      </label>
      {draw !== undefined && (
        <>
          <input
            type="number"
            className="count"
            id={`draw-n-${line.id}`}
            data-testid={`draw-n-${line.id}`}
            inputMode="numeric"
            min={DRAW_MIN}
            max={DRAW_MAX}
            step={1}
            value={n}
            aria-label={`Cards each copy of line ${line.id} draws, ${DRAW_MIN} to ${DRAW_MAX}`}
            onChange={(event) => {
              setN(event.target.value);
              onDraw({ n: commitDrawN(event.target.value, draw.n), oncePerTurn: draw.oncePerTurn });
            }}
            onBlur={() => setN(String(draw.n))}
          />
          <label htmlFor={`draw-once-${line.id}`}>
            <input
              type="checkbox"
              id={`draw-once-${line.id}`}
              data-testid={`draw-once-${line.id}`}
              checked={draw.oncePerTurn === true}
              onChange={(event) => onDraw({ n: draw.n, oncePerTurn: event.target.checked })}
            />{' '}
            once per turn
          </label>
        </>
      )}
    </span>
  );
}

/**
 * One checkbox per group under a line that names a card, ticked iff the group
 * holds it (`groupBoxes`). The group's card list is the only record: ticking
 * adds the card to it and unticking takes it out, and removing the LINE leaves
 * the group alone — so a card added back to the deck shows ticked again.
 */
function GroupBoxes({
  lineId,
  card,
  groups,
  onGroup,
}: {
  lineId: string;
  card: CardHit;
  groups: readonly TemplateGroup[];
  onGroup: (groupId: string, card: CardHit, member: boolean) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <span className="line-groups" data-testid={`groups-${lineId}`}>
      {groupBoxes(groups, card.passcode).map((box) => (
        <label key={box.id} htmlFor={`group-box-${lineId}-${box.id}`}>
          <input
            type="checkbox"
            id={`group-box-${lineId}-${box.id}`}
            data-testid={`group-box-${lineId}-${box.id}`}
            checked={box.checked}
            aria-label={`${card.name} in group ${box.name}`}
            onChange={(event) => onGroup(box.id, card, event.target.checked)}
          />{' '}
          {box.name}
        </label>
      ))}
    </span>
  );
}

export interface LineRowProps {
  line: TemplateLine;
  /** What `analyze` made of it; `null` while the analysis is one edit behind. */
  found: LineAnalysis | null;
  /** The display fields of a named card, as far as they are known. */
  known: CardHit | null;
  cardState: CardState;
  /** The template's groups, for the checkboxes under a line that names a card. */
  groups: readonly TemplateGroup[];
  /** The most copies a line may be set to. */
  deckSize: number;
  first: boolean;
  last: boolean;
  onText: (text: string) => void;
  onRange: (range: CopyRange) => void;
  /** What the line DRAWS, or `null` to stop being a draw card. */
  onDraw: (draw: DrawDraft | null) => void;
  /** Put the line's card in group `groupId`, or take it out. */
  onGroup: (groupId: string, card: CardHit, member: boolean) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}

export function LineRow({
  line,
  found,
  known,
  cardState,
  groups,
  deckSize,
  first,
  last,
  onText,
  onRange,
  onDraw,
  onGroup,
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
          <CompletingInput
            id={`text-${line.id}`}
            value={text}
            label={`Description on line ${line.id}`}
            placeholder="level 4 or lower monster"
            onChange={(next) => {
              setText(next);
              onText(next);
            }}
          />
        )}
        <CopyRangeField
          range={{ min: line.min, max: line.max }}
          onChange={onRange}
          cap={deckSize}
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
        <DrawMarker line={line} onDraw={onDraw} />
        {hit !== null && (
          <GroupBoxes lineId={line.id} card={hit} groups={groups} onGroup={onGroup} />
        )}
      </div>

      <div className="line-readout" data-testid={`readout-${line.id}`}>
        {/* What the marker means, in words, because the arithmetic is not
            obvious from a number and a tick: three copies of a draw-2 read
            eleven cards deep and leave a hand of eight. */}
        {line.draw !== undefined && (
          <p className="line-echo draws" data-testid={`draw-echo-${line.id}`}>
            {drawLineText(line.draw)}
          </p>
        )}
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
