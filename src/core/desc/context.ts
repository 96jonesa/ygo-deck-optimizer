import type { CardRecord } from '../cards/record';

/** The slice of `CardIndex` that descriptions use; `search` only feeds "did you mean". */
export interface CardLookup {
  findByName(name: string): CardRecord[];
  get(code: number): CardRecord | undefined;
  search?(query: string, limit?: number): CardRecord[];
}

/** The slice of `SetnameTable` that descriptions use. */
export interface SetnameLookup {
  lookup(name: string): number[];
  nameOf(code: number): string | undefined;
  alternatesOf(code: number): string[];
}

/** The template's card groups, by display name and by id; `names` only feeds error messages. */
export interface GroupLookup {
  idOf(name: string): string | undefined;
  nameOf(id: string): string | undefined;
  names?(): string[];
}

/**
 * What `parse`, `print` and `echo` resolve names through. Narrow structural
 * interfaces (TDD §15.2): the real `CardIndex` and `SetnameTable` satisfy
 * them, and so do hand-written doubles.
 */
export interface DescContext {
  cards: CardLookup;
  /** `null` when no `strings.conf` was found: archetypes are then written by code only. */
  setnames: SetnameLookup | null;
  groups: GroupLookup;
}
