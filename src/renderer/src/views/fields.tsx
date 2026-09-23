import { type KeyboardEvent, useState } from 'react';
import { type CopyRange, commitRange, type RangeEnd, rangeLabel } from '../model/copy-range';
import { editField, fieldOf, syncField } from '../model/field';

// The fields the template editor is typed into. Each keeps a draft of its own
// so that a keystroke never waits on the store, the analysis or anything else
// (TDD §3); `model/field.ts` is the rule for when a value changed from outside
// — Load example, Clear, a reorder — takes the draft over.

/**
 * A text field whose value also changes from outside it. Returns what to show
 * and a setter that reports the keystroke onwards.
 */
export function useField(external: string): [string, (draft: string) => void] {
  const [state, setState] = useState(() => fieldOf(external));
  const synced = syncField(state, external);
  // React's own "adjust state while rendering" pattern: no effect, so the
  // field never renders one frame of the value it is about to replace.
  if (synced !== state) setState(synced);
  return [synced.draft, (draft) => setState(editField(synced, draft))];
}

export interface CopyRangeFieldProps {
  range: CopyRange;
  onChange: (range: CopyRange) => void;
  /** The most copies either end may be set to: the deck cannot hold more. */
  cap: number;
  /** What the two fields are the range OF, for the screen reader: `line level4`. */
  label: string;
  disabled?: boolean;
}

/**
 * The copy range as two small number fields around an en dash, so that the row
 * reads `0–3` (PRD §5.1). `type="number"` is what makes the arrow keys step,
 * and every value typed goes through `commitRange`, which is where the pair is
 * kept in order.
 */
export function CopyRangeField({
  range,
  onChange,
  cap,
  label,
  disabled = false,
}: CopyRangeFieldProps) {
  const [min, setMin] = useField(String(range.min));
  const [max, setMax] = useField(String(range.max));

  const commit = (end: RangeEnd, text: string) => {
    (end === 'min' ? setMin : setMax)(text);
    const next = commitRange(range, end, text, cap);
    if (next.min !== range.min || next.max !== range.max) onChange(next);
  };

  // Enter has nothing to submit here, so it normalizes the field instead:
  // whatever is in it becomes what was committed.
  const settle = (end: RangeEnd) => {
    const value = end === 'min' ? range.min : range.max;
    (end === 'min' ? setMin : setMax)(String(value));
  };
  const onKeyDown = (end: RangeEnd) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') settle(end);
  };

  const field = (end: RangeEnd, draft: string, name: string) => (
    <input
      type="number"
      className="count"
      inputMode="numeric"
      min={0}
      max={cap}
      step={1}
      value={draft}
      disabled={disabled}
      aria-label={`${name} copies of ${label}`}
      data-testid={`${label}-${end}`}
      onChange={(event) => commit(end, event.target.value)}
      onBlur={() => settle(end)}
      onKeyDown={onKeyDown(end)}
    />
  );

  return (
    <span className="range" title={`${rangeLabel(range.min, range.max)} copies`}>
      {field('min', min, 'Fewest')}
      <span aria-hidden="true">{'–'}</span>
      {field('max', max, 'Most')}
    </span>
  );
}
