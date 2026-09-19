import type { Span } from '../../../shared/types';

/**
 * `text` cut at a parse error's span, to mark what the message is about. The
 * text may have been edited since the span was computed, so the span is
 * clamped to it: the three parts always make up the whole text.
 */
export function splitAtSpan(
  text: string,
  span: Span,
): { before: string; at: string; after: string } {
  const start = Math.min(Math.max(span.start, 0), text.length);
  const end = Math.min(Math.max(span.end, start), text.length);
  return { before: text.slice(0, start), at: text.slice(start, end), after: text.slice(end) };
}
