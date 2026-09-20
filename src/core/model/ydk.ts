import type { CardRecord } from '../cards/record';
import {
  DECK_SIZE_MAX,
  DECK_SIZE_MIN,
  NAMED_CARD_MAX,
  TEMPLATE_VERSION,
  type Template,
  type TemplateLine,
} from './template';

// Reading a `.ydk` decklist (PRD §9). Pure: the file is main's to read, and
// the card database reaches here as a lookup, so the whole of "what does this
// decklist mean" is decided in `core` and tested headlessly.

/** A `.ydk` file's three sections, in file order and with every repeat kept. */
export interface YdkDeck {
  /** The only section a template is built from: Extra and Side are out of scope (PRD §2). */
  main: number[];
  extra: number[];
  side: number[];
}

type Section = keyof YdkDeck;

/** `#main`, `#extra`, `!side`. Any other directive line is a comment. */
const SECTIONS: Record<string, Section> = { main: 'main', extra: 'extra', side: 'side' };

/**
 * A `.ydk` decklist as its sections. The format is a line per passcode under a
 * directive line naming the section, and the reader is deliberately tolerant,
 * as EDOPro's is: a line that is not a whole number is skipped rather than
 * failing the file, an unknown directive (`#created by …`) is a comment that
 * leaves the section where it was, and text before any directive is the main
 * deck. Nothing here throws, and nothing is de-duplicated — a card appearing
 * three times IS three copies.
 */
export function parseYdk(text: string): YdkDeck {
  const deck: YdkDeck = { main: [], extra: [], side: [] };
  let section: Section = 'main';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#') || line.startsWith('!')) {
      section = SECTIONS[line.slice(1).trim().toLowerCase()] ?? section;
      continue;
    }
    if (!/^\d+$/.test(line)) continue;
    const passcode = Number(line);
    if (Number.isSafeInteger(passcode)) deck[section].push(passcode);
  }
  return deck;
}

/** The slice of `CardIndex` an import needs: `resolve`, not `get` (TDD §4.3, §19). */
export interface DeckCardLookup {
  resolve(code: number): CardRecord | undefined;
}

export interface ImportedDeck {
  template: Template;
  /** Everything the import had to decide for itself, each naming the card it is about. */
  warnings: string[];
  /** Entries in `#main`, before any clamping: what the file said. */
  mainSize: number;
  /** Lines the deck became. */
  distinct: number;
}

/** One card's line, while the counts are still being accumulated. */
interface Tally {
  passcode: number;
  name: string;
  count: number;
  /** No record: the line is kept and warned about, never dropped. */
  known: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A `#main` section as a template (PRD §9): **one line per distinct card, at
 * the count the deck holds**, with `min = max` so the ratio starts at exactly
 * what was imported. The user then widens the ranges they are unsure about.
 * Criteria and groups are not invented — a decklist says nothing about what a
 * good hand looks like — and the remainder is left open.
 *
 * Which card a passcode is, is `resolve`'s answer and not `get`'s: the index
 * collapses alternate artwork, and a real decklist carries whichever printing
 * the player owns (TDD §19). Two printings of one card therefore merge into a
 * single line of their combined count, which is why the counting happens after
 * resolution and not before.
 *
 * Four things a deck can say that a template cannot, each kept usable and
 * warned about rather than refused — none occurs in a legal deck:
 * a passcode no database holds (the line stays, named after the passcode, and
 * `analyze` repeats the warning), more than three copies of one card (held at
 * three), a main deck outside 40–60 (the deck size is clamped and the rest
 * becomes unspecified cards), and the passcode 0, which names no card.
 */
export function templateFromDeck(main: readonly number[], cards: DeckCardLookup): ImportedDeck {
  const warnings: string[] = [];
  const tallies = new Map<number, Tally>();
  let zeroes = 0;

  for (const code of main) {
    if (code === 0) {
      zeroes++;
      continue;
    }
    const card = cards.resolve(code);
    const passcode = card?.code ?? code;
    const tally = tallies.get(passcode);
    if (tally !== undefined) {
      tally.count++;
      continue;
    }
    tallies.set(passcode, {
      passcode,
      name: card?.name ?? `#${passcode}`,
      count: 1,
      known: card !== undefined,
    });
  }

  if (zeroes > 0)
    warnings.push(
      `${zeroes} ${zeroes === 1 ? 'entry' : 'entries'} of the deck ${zeroes === 1 ? 'has' : 'have'} the passcode 0, which names no card`,
    );

  const lines: TemplateLine[] = [];
  for (const { passcode, name, count, known } of tallies.values()) {
    if (!known)
      warnings.push(
        `#${passcode} is not in the card database; its line is named after the passcode and fills only a requirement that names it`,
      );
    if (count > NAMED_CARD_MAX)
      warnings.push(
        `the deck holds ${count} copies of ${name}; a deck holds at most ${NAMED_CARD_MAX} copies of one card, so its line is ${NAMED_CARD_MAX}`,
      );
    const copies = Math.min(count, NAMED_CARD_MAX);
    lines.push({
      id: `card${lines.length + 1}`,
      card: { passcode, name },
      min: copies,
      max: copies,
    });
  }

  const deckSize = clamp(main.length, DECK_SIZE_MIN, DECK_SIZE_MAX);
  if (deckSize !== main.length)
    warnings.push(
      `the main deck holds ${main.length} cards; a template's deck is ${DECK_SIZE_MIN} to ${DECK_SIZE_MAX} cards, so the deck size is ${deckSize} and the rest is unspecified`,
    );

  return {
    template: {
      version: TEMPLATE_VERSION,
      deckSize,
      hand: { size: 5 },
      groups: [],
      lines,
      remainder: { min: 0, max: null },
      criteria: [],
    },
    warnings,
    mainSize: main.length,
    distinct: lines.length,
  };
}
