import type {
  Example,
  ExampleGroup,
  ExampleSection,
  Fact,
  FactSection,
} from '../../../shared/syntax';
import { textRuns } from '../model/syntax-view';

// The in-app reference for every input format, as a disclosure inside the
// panel it is about (Andy, 2026-09-19). Closed by default: it is there for
// the moment someone wonders, and a panel that opens with three tables of
// grammar in it teaches nothing.
//
// Markup only. Every word comes from `src/shared/syntax.ts`, whose rows are
// executed by `tests/shared/syntax.test.ts` against the very parsers the app
// runs — which is the only reason an example here can be trusted. The one
// decision this file makes is where the backticks in a sentence become
// `<code>`, and that lives in `model/syntax-view.ts` with its own tests.

/** A sentence from the reference, with its backticked spans set in code. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {textRuns(text).map((run, at) =>
        run.code ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity but their position
          <code key={at}>{run.text}</code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity but their position
          <span key={at}>{run.text}</span>
        ),
      )}
    </>
  );
}

/**
 * One example: what to type, and what it means. A row that shows an ERROR
 * shows the app's own message under the meaning, because recognizing the
 * message when it appears is most of the value of being warned about it.
 */
function Row({ row }: { row: Example }) {
  const failing = row.fails !== undefined;
  return (
    <div className={failing ? 'syntax-row bad' : 'syntax-row'}>
      <dt>
        <code>{row.syntax}</code>
      </dt>
      <dd>
        <Prose text={row.means} />
        {failing && <span className="syntax-fails">…{row.fails}…</span>}
      </dd>
    </div>
  );
}

function Group({ group }: { group: ExampleGroup }) {
  return (
    <div className="syntax-group">
      <h4>{group.heading}</h4>
      <dl className="syntax-rows">
        {group.rows.map((row) => (
          <Row key={row.syntax} row={row} />
        ))}
      </dl>
      {group.note !== undefined && (
        <p className="syntax-note">
          <Prose text={group.note} />
        </p>
      )}
    </div>
  );
}

/** The disclosure itself: `<details>`, so the open state is the browser's. */
function Disclosure({
  id,
  title,
  blurb,
  notes,
  children,
}: {
  id: string;
  title: string;
  blurb: string;
  notes: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <details className="syntax" data-testid={`syntax-${id}`}>
      <summary data-testid={`syntax-${id}-toggle`}>{title}</summary>
      <div className="syntax-body">
        <p className="syntax-blurb">
          <Prose text={blurb} />
        </p>
        {children}
        {notes.map((note) => (
          <p className="syntax-note" key={note}>
            <Prose text={note} />
          </p>
        ))}
      </div>
    </details>
  );
}

/** A reference whose every row is a piece of syntax you can type. */
export function SyntaxReference({ section }: { section: ExampleSection }) {
  return (
    <Disclosure id={section.id} title={section.title} blurb={section.blurb} notes={section.notes}>
      {section.groups.map((group) => (
        <Group key={group.heading} group={group} />
      ))}
    </Disclosure>
  );
}

/** A reference about the app rather than its grammar: the runs, and the files. */
export function FactReference({ section }: { section: FactSection<Fact & { hand?: string }> }) {
  return (
    <Disclosure id={section.id} title={section.title} blurb={section.blurb} notes={section.notes}>
      <dl className="syntax-rows facts">
        {section.rows.map((row) => (
          <div className="syntax-row" key={row.label}>
            <dt>
              {row.label}
              {row.hand !== undefined && <span className="dim"> · {row.hand}</span>}
            </dt>
            <dd>
              <Prose text={row.means} />
            </dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}
