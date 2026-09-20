import { lexOne, skipSpace } from './lexer';
import { formatArchetype } from './print';

// Inline name completion (PRD §5.2): where the caret is, what has been typed
// there, and what to write in its place. The three delimited forms of the
// grammar — `[card name]`, `{group name}`, `"archetype"` — are the only
// places a name is typed, and the only places this offers anything.
//
// The scan is the LEXER'S, not an approximation of it: `lexOne` decides where
// every token ends, so the rule "a delimiter runs to the first closing
// character and everything between is content" is obeyed by construction. A
// `]` inside a quoted archetype, a quote inside a card name and a second `[`
// inside a card name are all content, and a scanner that looked backwards
// from the caret would get each of them wrong.

/** Which of the grammar's three delimited names the caret is in. */
export type NameKind = 'card' | 'group' | 'archetype';

export interface CompletionSite {
  kind: NameKind;
  /**
   * What has been typed between the opening delimiter and the caret, exactly
   * as typed: the searches trim, the site does not, so that the replacement
   * span and the prefix are about the same characters.
   */
  prefix: string;
  /** Where a replacement starts: the offset of the opening delimiter. */
  start: number;
  /**
   * Where a replacement ends: past the closing delimiter when there is one,
   * and the caret when there is not — a replacement then writes the closing
   * delimiter itself rather than eating the rest of the line.
   */
  end: number;
  /** Whether the name's closing delimiter is already in the text. */
  closed: boolean;
}

/** Opening character → what it opens. The lexer's own table (`DELIMITED`). */
const OPENS: Readonly<Record<string, NameKind>> = {
  '"': 'archetype',
  '“': 'archetype',
  '[': 'card',
  '{': 'group',
};

/**
 * The name the caret is inside, or `null` — the trigger for the completion
 * popup and the span it would replace.
 *
 * Tokens are walked forward from the start of the text with `lexOne`, so
 * "inside a name" means what the lexer means by it. One departure, and it is
 * deliberate: a character the lexer cannot read at all is STEPPED OVER rather
 * than ending the scan, because text is unparseable while it is being typed
 * and that is exactly when completion is wanted.
 */
export function completionSiteAt(text: string, caret: number): CompletionSite | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  for (let pos = skipSpace(text, 0); pos < text.length; ) {
    // Every token from here on starts at or after the caret, so none holds it.
    if (pos >= caret) return null;
    const kind = OPENS[text[pos]!];
    const result = lexOne(text, pos);
    if (kind !== undefined) {
      // The only way a delimiter fails to lex is never being closed.
      if (!result.ok)
        return { kind, prefix: text.slice(pos + 1, caret), start: pos, end: caret, closed: false };
      const { end } = result.token.span;
      if (caret < end)
        return { kind, prefix: text.slice(pos + 1, caret), start: pos, end, closed: true };
      pos = skipSpace(text, end);
      continue;
    }
    pos = skipSpace(text, result.ok ? result.token.span.end : Math.max(result.span.end, pos + 1));
  }
  return null;
}

/**
 * `[Ash Blossom & Joyous Spring]` — the name, because the name is what reads
 * back later (the engine stores the passcode either way). Two things make the
 * name unusable: sharing it with another card, which `[Name]` refuses as
 * ambiguous, and holding the closing bracket. Both fall back to `#passcode`,
 * so that every option inserts text resolving to the card that was picked.
 */
export function cardInsert(name: string, passcode: number, unique: boolean): string {
  return unique && !name.includes(']') ? `[${name}]` : `#${passcode}`;
}

/**
 * `"Sky Striker"` while the name names one setcode, and `"Warrior":0x2066`
 * when it names several (TDD §4.5) — turning the dead end that a bare
 * ambiguous name is into the two rows that resolve it. A name holding a quote
 * cannot be written at all, and goes out as `"?":0xCODE`, which is how `print`
 * writes it and what `parse` reads back.
 */
export function archetypeInsert(name: string, code: number, unique: boolean): string {
  if (name.includes('"')) return formatArchetype(undefined, code);
  return unique ? `"${name}"` : formatArchetype(name, code);
}

/** `{starter}`, or `null` for a name holding the closing brace, which the grammar cannot carry. */
export function groupInsert(name: string): string | null {
  return name.includes('}') ? null : `{${name}}`;
}
