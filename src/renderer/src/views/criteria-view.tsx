import { useEffect, useRef, useState } from 'react';
import type { DescParseResult } from '../../../shared/types';
import { LatestOnly } from '../model/latest';
import { splitAtSpan } from '../model/span';
import { selectCardState, useApp } from '../store';

// The criteria region (PRD §8.3). M2c has the description box — the same
// input a criterion row and a description line are built on — so that the
// grammar is reachable from the app; the rows, the nested OR groups and the
// filled-by / near-miss readouts are M2e's, and land in this panel.

function ParseReadout({ text, result }: { text: string; result: DescParseResult }) {
  if (result.ok)
    return (
      <div className="readout" data-testid="parse-readout">
        <p>
          <strong>{result.echo}</strong>
        </p>
        <p>
          <code>{result.canonical}</code>
        </p>
        <p>
          {result.count.toLocaleString('en-US')} matching card{result.count === 1 ? '' : 's'}
          {result.samples.length > 0 && `: ${result.samples.join(', ')}`}
          {result.count > result.samples.length && result.samples.length > 0 && ', …'}
        </p>
      </div>
    );
  if (result.reason !== 'parse')
    return (
      <p className="readout bad" data-testid="parse-readout">
        {result.message}
      </p>
    );
  const { before, at, after } = splitAtSpan(text, result.span);
  return (
    <div className="readout bad" data-testid="parse-readout">
      <p>{result.message}</p>
      <p>
        <code>
          {before}
          <mark>{at === '' ? '⟨here⟩' : at}</mark>
          {after}
        </code>
      </p>
    </div>
  );
}

export function CriteriaView() {
  const cardState = useApp(selectCardState);
  const criteria = useApp((state) => state.template.criteria);
  const [text, setText] = useState('');
  const [result, setResult] = useState<DescParseResult | null>(null);
  const latest = useRef(new LatestOnly());

  // Re-asked on every edit, and whenever the card data changes under the text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cardState is the trigger, not an input
  useEffect(() => {
    const seq = latest.current.next();
    void window.api.parseDescription({ seq, payload: { text, groups: [] } }).then((response) => {
      // An answer a newer keystroke has overtaken is dropped (TDD §12).
      if (latest.current.isCurrent(response.seq)) setResult(response.payload);
    });
  }, [text, cardState]);

  return (
    <section className="panel" data-region="criteria">
      <h2>Criteria</h2>
      <p className="hint">
        A criterion says what an opening hand has to hold —{' '}
        <code>1x [Ash Blossom], 1x monster</code>. Descriptions are checked against the card
        database as they are typed.
      </p>

      <label htmlFor="desc">Try a description</label>
      <input
        type="text"
        className="desc"
        id="desc"
        data-testid="desc"
        value={text}
        placeholder="level 4 or lower monster"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
      />
      {text !== '' && result !== null && <ParseReadout text={text} result={result} />}

      <p className="seam">
        {criteria.length === 0
          ? 'Criterion rows, nested OR groups, and the filled-by / near-miss / limit readouts arrive in M2e.'
          : `The template carries ${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'}. Showing and editing them, the nested OR groups and the filled-by / near-miss / limit readouts, arrives in M2e.`}
      </p>
    </section>
  );
}
