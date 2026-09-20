// Rendering the syntax reference's prose (`src/shared/syntax.ts`). The
// reference is data, and its sentences say things like "the `x` is optional":
// the backticks mark the bits that are syntax rather than English, and this
// is the whole of turning them into markup. It lives here rather than in the
// component because it is a decision about text, and components in this app
// hold only markup (TDD §3).

/** A stretch of a sentence, either prose or a piece of syntax. */
export interface TextRun {
  readonly code: boolean;
  readonly text: string;
}

/**
 * A sentence split at its backticks: odd pieces are code, even ones prose.
 *
 * An UNCLOSED span is deliberately not an error — its tail is kept as prose
 * rather than dropped, since a typo in the reference should cost a pair of
 * `<code>` tags and not a sentence. A test on the reference itself keeps the
 * backticks paired, so this path is a net and not a feature.
 */
export function textRuns(text: string): TextRun[] {
  const pieces = text.split('`');
  const closed = pieces.length % 2 === 1;
  return pieces
    .map((piece, at) => ({ code: closed && at % 2 === 1, text: piece }))
    .filter((run) => run.text !== '');
}
