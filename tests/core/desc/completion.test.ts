import { describe, expect, it } from 'vitest';
import { lexCriterion } from '../../../src/core/criteria/lexer';
import {
  archetypeInsert,
  type CompletionSite,
  cardInsert,
  completionSiteAt,
  groupInsert,
  type NameKind,
} from '../../../src/core/desc/completion';

// The caret oracle (TDD §5.1, §7.1). What counts as "the caret is inside a
// name" is not a judgement this file makes: it is READ OFF THE LEXER, whose
// delimiter rule is "from the opening character to the first closing one, and
// everything between is content". `siteFromLexer` below re-derives a site from
// `lexCriterion` alone, and the property test at the end holds the
// implementation to it over every caret offset of a corpus of traps.

/** `[Ash‸ Blossom]` — the caret marker, removed before the text is used. */
const CARET = '‸';

function marked(text: string): [string, number] {
  const caret = text.indexOf(CARET);
  if (caret < 0) throw new Error(`no ${CARET} in ${JSON.stringify(text)}`);
  return [text.slice(0, caret) + text.slice(caret + CARET.length), caret];
}

function site(
  kind: NameKind,
  prefix: string,
  start: number,
  end: number,
  closed: boolean,
): CompletionSite {
  return { kind, prefix, start, end, closed };
}

/** What `completionSiteAt` is asked, written with the caret in the text. */
function siteAt(text: string): CompletionSite | null {
  return completionSiteAt(...marked(text));
}

// --- the oracle -------------------------------------------------------------

const OPENS: Readonly<Record<string, NameKind>> = {
  '"': 'archetype',
  '“': 'archetype',
  '[': 'card',
  '{': 'group',
};
const DELIMITED = new Set(['cardName', 'quoted', 'group']);

/**
 * The site, derived from the criterion lexer and nothing else. A delimited
 * token holds the caret when the caret is past its opening character and no
 * further than its closing one; an unclosed delimiter — which the lexer
 * reports as a failure at the opening character — holds every caret past it.
 * Deliberately restricted: a text whose lexing fails for any OTHER reason is
 * not something this oracle can speak about (see the golden cases for what the
 * implementation does there, and why it must).
 */
function siteFromLexer(text: string, caret: number): CompletionSite | null {
  const lexed = lexCriterion(text);
  if (lexed.ok) {
    for (const token of lexed.tokens) {
      if (!DELIMITED.has(token.t)) continue;
      const { start, end } = token.span;
      if (start < caret && caret < end)
        return site(OPENS[text[start]!]!, text.slice(start + 1, caret), start, end, true);
    }
    return null;
  }
  if (!/ is never closed:/.test(lexed.message))
    throw new Error(`the oracle cannot read ${JSON.stringify(text)}: ${lexed.message}`);
  const open = lexed.span.start;
  const kind = OPENS[text[open]!];
  if (kind === undefined) throw new Error(`unclosed ${text[open]} is not a name delimiter`);
  if (open < caret) return site(kind, text.slice(open + 1, caret), open, caret, false);
  // Before the unclosed delimiter, everything lexed: ask again about that part.
  return siteFromLexer(text.slice(0, open), caret);
}

/** Texts the oracle can read, each one a trap the caret scan has to get right. */
const CORPUS = [
  '',
  'monster',
  '1x [Ash Blossom & Joyous Spring]',
  '1x [Ash',
  '1x [',
  '1x []',
  '1x [Ash] and 1x [Maxx "C"]',
  '1x [Ash] and 1x [Maxx',
  '"Sky Striker" spell',
  '"Sky Strik',
  '1x "Warrior":0x2066 monster',
  '{starter}',
  '{start',
  '1x {starter} and at most 1x {brick',
  // A `]` inside a quoted archetype is content: the quote closes on a quote.
  '"Foo] bar',
  '"Foo] bar" card',
  // A quote inside a card name is content: 74 real card names hold one.
  '["A" Cell Breeding Device]',
  '["A" Cell',
  '[Maxx "C"] or "Sky',
  // A second opening bracket is content, not nesting.
  '[[Foo]',
  '[[Foo',
  // The curly pair the lexer also accepts.
  '“Sky Striker” spell',
  '“Sky',
  'exactly 2x [Ash] and 1-2x monster',
  'at most 1x [Ash',
  '#89631139 and 1x {g',
  'level 2-4 monster or "Blue-Eyes',
];

describe('completionSiteAt', () => {
  describe('a name still being typed', () => {
    it('reads the card name up to the caret, and replaces from the bracket to the caret', () => {
      expect(siteAt('1x [Ash‸')).toEqual(site('card', 'Ash', 3, 7, false));
      // The replacement stops at the CARET, not at the end of the text: the
      // rest of the line is not part of the name, however unclosed it is.
      expect(siteAt('1x [Ash‸ and 1x monster')).toEqual(site('card', 'Ash', 3, 7, false));
    });

    it('is a site the moment the delimiter is typed, with nothing in it yet', () => {
      expect(siteAt('1x [‸')).toEqual(site('card', '', 3, 4, false));
    });

    it('reads an archetype name', () => {
      expect(siteAt('"Sky Strik‸')).toEqual(site('archetype', 'Sky Strik', 0, 10, false));
    });

    it('reads a group name', () => {
      expect(siteAt('1x {start‸')).toEqual(site('group', 'start', 3, 9, false));
    });

    it('keeps the prefix exactly as typed, spaces included', () => {
      expect(siteAt('[ Ash ‸')).toEqual(site('card', ' Ash ', 0, 6, false));
    });

    it('finds the name after other complete names', () => {
      expect(siteAt('1x [Ash] and 1x [Maxx‸')).toEqual(site('card', 'Maxx', 16, 21, false));
    });

    it('is unaffected by the criterion keywords in front of it', () => {
      expect(siteAt('at most 1x [Ash‸')).toEqual(site('card', 'Ash', 11, 15, false));
      expect(siteAt('exactly 2x {brick‸')).toEqual(site('group', 'brick', 11, 17, false));
    });
  });

  describe('a name already closed', () => {
    it('replaces the whole name, closing delimiter included', () => {
      expect(siteAt('1x [Ash‸]')).toEqual(site('card', 'Ash', 3, 8, true));
    });

    it('takes the prefix up to the caret, not the whole name', () => {
      expect(siteAt('1x [As‸h]')).toEqual(site('card', 'As', 3, 8, true));
    });

    it('holds the caret sitting just inside either delimiter', () => {
      expect(siteAt('1x [‸Ash]')).toEqual(site('card', '', 3, 8, true));
      expect(siteAt('1x [Ash‸]')).toEqual(site('card', 'Ash', 3, 8, true));
    });

    it('does not hold a caret past the closing delimiter', () => {
      expect(siteAt('1x [Ash]‸')).toBeNull();
    });

    it('does not hold a caret at or before the opening delimiter', () => {
      expect(siteAt('1x ‸[Ash]')).toBeNull();
      expect(siteAt('1‸x [Ash]')).toBeNull();
    });

    it('reads an archetype between its quotes, code suffix and all', () => {
      expect(siteAt('1x "War‸rior":0x2066 monster')).toEqual(site('archetype', 'War', 3, 12, true));
    });

    it('reads the curly quotes the lexer also accepts', () => {
      expect(siteAt('“Sk‸y”')).toEqual(site('archetype', 'Sk', 0, 5, true));
    });
  });

  describe('what the delimiters enclose', () => {
    it('treats a ] inside a quoted archetype as part of the name', () => {
      expect(siteAt('"Foo] ba‸r')).toEqual(site('archetype', 'Foo] ba', 0, 8, false));
    });

    it('treats a quote inside a card name as part of the name', () => {
      expect(siteAt('["A" Cell‸')).toEqual(site('card', '"A" Cell', 0, 9, false));
    });

    it('treats a second opening bracket as part of the name, not as nesting', () => {
      expect(siteAt('[[Foo‸')).toEqual(site('card', '[Foo', 0, 5, false));
    });

    it('closes a card name on the FIRST ], leaving the caret after it outside any name', () => {
      expect(siteAt('[[Foo]‸]')).toBeNull();
    });

    it('does not read a passcode as a name', () => {
      expect(siteAt('#8963‸1139')).toBeNull();
    });

    it('has no site in ordinary words', () => {
      expect(siteAt('level 4 mon‸ster')).toBeNull();
    });
  });

  describe('text the parser would reject', () => {
    // Completion has to work in text that does not parse, because text does
    // not parse WHILE IT IS BEING TYPED. An unexpected character is stepped
    // over rather than ending the scan, which is the one deliberate departure
    // from the lexer, whose job is to refuse the text rather than read on.
    it('steps over a character the lexer cannot read and still finds the name after it', () => {
      expect(siteAt('@ [Ash‸')).toEqual(site('card', 'Ash', 2, 6, false));
    });

    it('steps over a # with no digits after it', () => {
      expect(siteAt('# [Ash‸')).toEqual(site('card', 'Ash', 2, 6, false));
    });
  });

  describe('carets outside the text', () => {
    it('has no site at the very start', () => {
      expect(completionSiteAt('[Ash', 0)).toBeNull();
    });

    it('has no site in empty text', () => {
      expect(completionSiteAt('', 0)).toBeNull();
    });

    it('refuses a caret that is not an offset into the text', () => {
      expect(completionSiteAt('[Ash', -1)).toBeNull();
      expect(completionSiteAt('[Ash', 5)).toBeNull();
    });
  });

  it('agrees with the lexer at every caret offset of every trap in the corpus', () => {
    for (const text of CORPUS)
      for (let caret = 0; caret <= text.length; caret++)
        expect({ text, caret, site: completionSiteAt(text, caret) }).toEqual({
          text,
          caret,
          site: siteFromLexer(text, caret),
        });
  });
});

describe('cardInsert', () => {
  it('writes the name in brackets: the name is what reads back later', () => {
    expect(cardInsert('Ash Blossom & Joyous Spring', 14558127, true)).toBe(
      '[Ash Blossom & Joyous Spring]',
    );
  });

  it('writes the passcode when the name is not unique, since [Name] would not resolve', () => {
    expect(cardInsert('Black Luster Soldier', 5405694, false)).toBe('#5405694');
  });

  it('writes the passcode for a name holding the closing bracket, which the grammar cannot carry', () => {
    expect(cardInsert('Odd ] Name', 1234, true)).toBe('#1234');
  });
});

describe('archetypeInsert', () => {
  it('writes the bare name when it resolves to one setcode', () => {
    expect(archetypeInsert('Sky Striker', 0x115, true)).toBe('"Sky Striker"');
  });

  it('writes the code alongside an ambiguous name, which is the whole point of offering both', () => {
    expect(archetypeInsert('Warrior', 0x2066, false)).toBe('"Warrior":0x2066');
    expect(archetypeInsert('Warrior', 0x66, false)).toBe('"Warrior":0x66');
  });

  it('writes "?" for a name holding a quote, as `print` does', () => {
    expect(archetypeInsert('"V "/" V"', 0x155a, true)).toBe('"?":0x155a');
  });
});

describe('groupInsert', () => {
  it('writes the name in braces', () => {
    expect(groupInsert('starter')).toBe('{starter}');
  });

  it('refuses a name holding the closing brace, which the grammar cannot carry', () => {
    expect(groupInsert('odd } name')).toBeNull();
  });
});
