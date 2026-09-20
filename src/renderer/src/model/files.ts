import type {
  DeckImportResult,
  ResultsExportResult,
  TemplateOpenResult,
  TemplateSaveResult,
} from '../../../shared/types';

// What the file actions say afterwards (M2g). Every sentence here is about
// something that HAPPENED — a file read, a file written, a deck turned into
// lines — and every semantic word in it came from main: the renderer arranges
// the lines and decides none of them (TDD §3).

/** A line or lines under the file buttons; `bad` is the only thing coloured. */
export interface FileStatus {
  tone: 'ok' | 'bad';
  lines: string[];
}

/**
 * A dialog the user cancelled says NOTHING. It is the one outcome with no
 * news in it, and a "cancelled" line under the buttons would be the app
 * reporting the user's own decision back to them.
 */
function failureOf(
  result: Exclude<DeckImportResult | TemplateOpenResult | TemplateSaveResult, { ok: true }>,
): FileStatus | null {
  if (result.reason === 'cancelled') return null;
  return {
    tone: 'bad',
    lines: result.reason === 'invalid' ? [result.message, ...result.errors] : [result.message],
  };
}

/**
 * What an imported deck became (PRD §9). It says the criteria and groups are
 * untouched because that is the one thing a user could reasonably fear when a
 * button replaces their lines — and it says to widen the copies, because a
 * deck imports at `min = max` and a search over one ratio answers nothing.
 */
export function importStatus(result: DeckImportResult): FileStatus | null {
  if (!result.ok) return failureOf(result);
  const { name, mainSize, distinct } = result.deck;
  return {
    tone: 'ok',
    lines: [
      `${name}: ${mainSize} cards, ${distinct} lines. The criteria and groups are unchanged — widen the copies you are unsure of, then run.`,
      ...result.warnings,
    ],
  };
}

/** Where the template came from, and what this install says about its cards (TDD §14). */
export function openStatus(result: TemplateOpenResult): FileStatus | null {
  if (!result.ok) return failureOf(result);
  return { tone: 'ok', lines: [`Opened ${result.path}.`, ...result.notices] };
}

/** Where the template went, and anything the file could not carry whole. */
export function saveStatus(result: TemplateSaveResult): FileStatus | null {
  if (!result.ok) return failureOf(result);
  return { tone: 'ok', lines: [`Saved to ${result.path}.`, ...result.warnings] };
}

export function exportStatus(result: ResultsExportResult): FileStatus | null {
  if (!result.ok) {
    if (result.reason === 'cancelled') return null;
    return {
      tone: 'bad',
      lines: result.reason === 'invalid' ? [result.message, ...result.errors] : [result.message],
    };
  }
  return { tone: 'ok', lines: [`Exported to ${result.path}.`] };
}
