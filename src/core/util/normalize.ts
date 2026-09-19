/**
 * Canonical form for name matching: diacritics stripped, lower-cased. Shared
 * by card search and the description vocabulary so "Evil★Twin" typed without
 * accents, or "beast-warrior" in any case, resolves the same everywhere.
 */
export function normalize(text: string): string {
  return text.normalize('NFD').replaceAll(/[̀-ͯ]/g, '').toLowerCase();
}
