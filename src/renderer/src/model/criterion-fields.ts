import type { CriterionAnalysis, Span, TemplateCriterion } from '../../../shared/types';
import type { CriterionWhen } from './deck-form';

// A criterion's fields (PRD §5.5), as the editor lays them out. Going second a
// criterion has three — the opening five, the cards drawn, the whole hand, in
// the order the cards arrive — and going first or for either hand it has one,
// the whole hand. What each field MEANS, and whether it parses, is `analyze`'s
// (TDD §9); this file decides which fields are on screen, what they are called,
// and which of the analysis's answers belongs under which.

/** Written out rather than imported (the renderer takes no code from `core`); a test holds the copies equal. */
export const CRITERION_FIELDS = ['opening', 'drawn', 'text'] as const;

export type CriterionField = (typeof CRITERION_FIELDS)[number];

/** What an empty field shows: an empty field asks nothing of its window. */
export const FIELD_PLACEHOLDER = '(anything)';

/**
 * A field's label, the same whatever the template holds (Andy, 2026-09-23). The
 * drawn-cards field does NOT adapt to whether a line draws: a label that changes
 * when a box is ticked elsewhere changes under the user, and one that said "card
 * drawn for turn" before any draw card was marked would teach that the field is
 * one card for good. Its hint says what it holds in both cases instead.
 */
export const FIELD_LABELS: Record<CriterionField, string> = {
  opening: 'Opening 5',
  drawn: 'Drawn cards',
  text: 'Whole hand',
};

/** The line under a label, where one is needed to say what the field holds. */
export const FIELD_HINTS: Partial<Record<CriterionField, string>> = {
  drawn: 'the card drawn for turn, plus anything draw cards fetch',
};

/** The field's text as the template holds it; an absent going-second field is empty. */
export function fieldText(criterion: TemplateCriterion, field: CriterionField): string {
  return criterion[field] ?? '';
}

/**
 * The fields a row shows, in window order.
 *
 * Going second: all three, always, an empty one showing its placeholder
 * (Andy's decision: the layout does not jump as they are filled). Going first
 * or for either hand: the whole hand alone — PLUS any going-second field that
 * still holds text. Switching a row away from going second never deletes what
 * was typed; the text stays on screen, where it can be moved or emptied, and
 * `analyze` marks the row with the error that says why it cannot run.
 */
export function shownFields(criterion: TemplateCriterion, when: CriterionWhen): CriterionField[] {
  if (when === 'second') return [...CRITERION_FIELDS];
  return CRITERION_FIELDS.filter(
    (field) => field === 'text' || fieldText(criterion, field).trim() !== '',
  );
}

/** The parse failure that belongs under `field`, with its span inside that field's text. */
export function fieldFailureOf(
  found: CriterionAnalysis | null,
  field: CriterionField,
): { message: string; span: Span } | null {
  if (found === null || found.parsed.ok) return null;
  if ((found.parsed.field ?? 'text') !== field) return null;
  return { message: found.parsed.message, span: found.parsed.span };
}

/**
 * The canonical text of one field, when it is not what the user typed there —
 * `1x [Elemental HERO Stratos]` reads back as `1x #40044918` — and `null` where
 * the two agree, or the field is empty, or the criterion did not parse.
 */
export function fieldCanonical(
  found: CriterionAnalysis | null,
  criterion: TemplateCriterion,
  field: CriterionField,
): string | null {
  if (found === null || !found.parsed.ok) return null;
  const canonical = found.parsed.fields?.[field];
  if (canonical === undefined) return null;
  return canonical === fieldText(criterion, field) ? null : canonical;
}
