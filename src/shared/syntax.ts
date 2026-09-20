// The in-app syntax reference: what every input format accepts, as DATA.
//
// Two reasons it lives here rather than in the components that show it.
// First, `src/shared` is what the renderer may import (TDD §3), and this file
// imports NOTHING at runtime, so putting the reference in it costs the
// renderer bundle nothing but the strings. Second, and the point of the whole
// exercise: `tests/shared/syntax.test.ts` feeds every row of every
// `ExampleSection` to `core`'s real parsers, so an example that stops being
// true stops the build. A syntax reference that drifts is worse than none.
//
// The material is split by LEVEL, not by panel, and nothing is written twice:
//
//   `DESCRIPTION_SYNTAX`  everything that says what a CARD is — kinds,
//                         qualifiers, `/`, the description-level `or`, card,
//                         group and archetype names, parentheses around
//                         alternatives. Shown in the Template panel, and the
//                         only place any of it is explained.
//   `CRITERION_SYNTAX`    everything that WRAPS a description — counts,
//                         ranges, `exactly`, `at most`, `no`, `and` / `,`,
//                         the criterion-level `or` and the one token that
//                         tells the two `or`s apart, nesting. Shown in the
//                         Criteria panel, which points at the other section
//                         rather than repeating half of it.
//
// A criterion CONTAINS a description, so the boundary is exactly "after the
// count": `2x` belongs here, `level 4 monster` belongs there, and the rows of
// the criteria section deliberately use the plainest descriptions there are
// so that they never teach the description language by accident.

/** A row of an example table: what to type, and what it means. */
export interface Example {
  /** Typed exactly as written; the test parses this string. */
  readonly syntax: string;
  readonly means: string;
  /**
   * Set on a row that shows an ERROR: the text does not parse, and the app's
   * message contains this. Knowing the message is half of recognizing it.
   */
  readonly fails?: string;
}

export interface ExampleGroup {
  readonly heading: string;
  readonly rows: readonly Example[];
  /** One sentence under the table, for what a row of two columns cannot hold. */
  readonly note?: string;
}

/** A disclosure whose every row is executable, parsed by the named parser. */
export interface ExampleSection {
  readonly id: string;
  readonly title: string;
  /** Which of `core`'s two parsers reads every row in it. */
  readonly parses: 'description' | 'criterion';
  readonly blurb: string;
  readonly groups: readonly ExampleGroup[];
  readonly notes: readonly string[];
}

/** A row of a reference that is about the app rather than about its grammar. */
export interface Fact {
  readonly label: string;
  readonly means: string;
}

/** A run mode, which is a fact with two more columns worth having. */
export interface ModeFact extends Fact {
  /** Agrees with `RUN_MODES` in `src/core/model/template.ts`; a test holds them equal. */
  readonly mode: 'first' | 'second' | 'average';
  readonly hand: string;
}

export interface FactSection<R extends Fact = Fact> {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly rows: readonly R[];
  readonly notes: readonly string[];
}

/**
 * The description language (TDD §5.1). Shown in the Template panel, beside
 * the lines, and referred to from the Criteria panel — a criterion's
 * requirements are written in exactly this language and nothing about it is
 * repeated over there.
 */
export const DESCRIPTION_SYNTAX: ExampleSection = {
  id: 'descriptions',
  title: 'Syntax: describing cards',
  parses: 'description',
  blurb:
    'A line says what its cards are known to be. The same language writes the descriptions inside criteria.',
  groups: [
    {
      heading: 'Kinds',
      rows: [
        { syntax: 'monster', means: 'any Main Deck monster' },
        { syntax: 'spell', means: 'any Spell Card; `trap` reads the same way' },
        { syntax: 'card', means: 'anything at all — the widest description there is' },
        { syntax: 'spell/trap', means: 'one dimension, two values: a Spell or a Trap' },
        { syntax: 'monsters', means: 'plurals are accepted and mean the same' },
      ],
      note: 'The kind word is optional: any qualifier below that only a monster can have already means `monster`.',
    },
    {
      heading: 'What a monster is',
      rows: [
        {
          syntax: 'FIRE monster',
          means: 'an Attribute: EARTH, WATER, FIRE, WIND, LIGHT, DARK, DIVINE',
        },
        {
          syntax: 'FIRE/WATER monster',
          means: 'either Attribute — `/` joins values inside one dimension',
        },
        { syntax: 'Beast-Warrior', means: 'a Type, which on its own already says monster' },
        { syntax: 'Warrior/Dragon monster', means: 'either Type' },
        { syntax: 'tuner monster', means: 'a monster flag' },
        { syntax: 'non-tuner monster', means: '`non-` negates the one word it is attached to' },
        { syntax: 'non-Warrior/Dragon monster', means: 'neither Type' },
        {
          syntax: 'normal monster',
          means: 'the Normal flag — beside `spell` the same word is a sub-kind',
        },
      ],
      note: 'The flags are normal, effect, tuner, ritual, pendulum, flip, gemini, union, spirit and toon.',
    },
    {
      heading: 'Level, ATK and DEF',
      rows: [
        { syntax: 'level 4 monster', means: 'exactly that Level' },
        { syntax: 'level 4 or lower monster', means: '`or higher` too' },
        { syntax: 'level 1-3 monster', means: 'a range, both ends included' },
        { syntax: 'level 4/6 monster', means: 'either Level, and nothing between them' },
        { syntax: '2000 ATK monster', means: 'exactly that much' },
        {
          syntax: 'ATK 2000 or more monster',
          means: '`or less` too, and `DEF` reads the same way',
        },
        { syntax: 'DEF 0-1000 monster', means: 'a range of DEF' },
        { syntax: 'ATK ? monster', means: 'an unknown ATK, which no numeric range ever matches' },
      ],
    },
    {
      heading: 'Spells and Traps',
      rows: [
        { syntax: 'quick-play spell', means: 'a sub-kind only Spells have' },
        { syntax: 'normal spell', means: 'a Spell with no sub-kind of its own' },
        { syntax: 'normal/field spell', means: 'either sub-kind' },
        { syntax: 'continuous spell/trap', means: 'a sub-kind both kinds have' },
        { syntax: 'counter trap', means: 'a sub-kind only Traps have' },
        { syntax: 'ritual spell', means: 'the sub-kind; `ritual monster` is the flag' },
        {
          syntax: 'counter spell',
          means: 'an error — a sub-kind is checked against the kind beside it',
          fails: 'there is no Counter Spell',
        },
      ],
      note: 'A sub-kind written alone implies the kinds it exists for: `quick-play` is a Spell, `counter` a Trap.',
    },
    {
      heading: 'Naming a card, a group, an archetype',
      rows: [
        { syntax: '[Ash Blossom & Joyous Spring]', means: 'one card, by its exact full name' },
        {
          syntax: '#14558127',
          means:
            'the same card by passcode — two cards can share a name, so this is what the app writes',
        },
        { syntax: '{starter}', means: 'every card in a group you named' },
        { syntax: '"Sky Striker"', means: 'an archetype, by name' },
        {
          syntax: '"Sky Striker Ace"',
          means: 'a sub-archetype: every Ace card is a Sky Striker too',
        },
        { syntax: '"Warrior":0x2066', means: 'the setcode, for a name two archetypes share' },
        {
          syntax: '"Warrior"',
          means: 'an error — the message names both codes to pick from',
          fails: 'names 2 archetypes',
        },
      ],
      note: 'Names are always delimited, because real ones hold `or`, `and` and commas. Typing `[`, `{` or `"` opens the completion list at the caret.',
    },
    {
      heading: 'Several descriptions at once',
      rows: [
        {
          syntax: 'FIRE monster or level 4 monster',
          means:
            'two whole descriptions — the first says nothing about Level, the second nothing about Attribute',
        },
        {
          syntax: '([Ash Blossom & Joyous Spring] or {starter})',
          means: 'parentheses group alternatives',
        },
        {
          syntax: 'FIRE WATER monster',
          means: 'an error — two Attributes are one dimension, not two clauses',
          fails: 'write `FIRE/WATER`',
        },
      ],
      note: '`or` joins whole descriptions; `/` joins values inside one dimension. That is the whole difference, and it is why there is no precedence to learn.',
    },
    {
      heading: 'Spelling',
      rows: [
        { syntax: 'LEVEL 4 MONSTERS', means: 'case never matters' },
        { syntax: 'beast warrior', means: 'nor do hyphens — the same as `Beast-Warrior`' },
        {
          syntax: 'DIVINE Beast',
          means:
            'one word, therefore the Divine-Beast Type — not a DIVINE Beast. The echo says which was understood',
        },
      ],
    },
  ],
  notes: [
    'Nothing here can say Pendulum Scale, Fusion, Synchro, Xyz or Link (the Extra Deck is out of scope), or anything from a card’s effect text. A group is how you say those: put the cards in it by hand and write {name}.',
    'Under every line the app echoes what it understood and how many cards in your database match it.',
  ],
};

/**
 * The criterion language (TDD §7.1). Counts, limits and the joins between
 * terms — and nothing about descriptions, which the Template panel's
 * reference owns; the blurb below points at it by name.
 */
export const CRITERION_SYNTAX: ExampleSection = {
  id: 'criteria',
  title: 'Syntax: writing criteria',
  parses: 'criterion',
  blurb:
    'A criterion asks something of one hand. Everything after a count is a description — “Syntax: describing cards”, in the Template panel, covers that half.',
  groups: [
    {
      heading: 'Asking for cards',
      rows: [
        { syntax: '2x level 4 monster', means: 'two distinct cards, each matching' },
        { syntax: '2 level 4 monster', means: 'the `x` is optional; the app writes it back in' },
        { syntax: '1-2x monster', means: 'a range: at least one, at most two' },
        { syntax: 'exactly 1x monster', means: 'both ends the same — identical to `1-1x monster`' },
      ],
      note: 'A range’s ceiling binds over the whole hand: a third matching card fails the criterion unless another requirement takes it.',
    },
    {
      heading: 'Ruling cards out',
      rows: [
        { syntax: 'at most 1x trap', means: 'a limit, counted over the whole hand' },
        { syntax: 'no trap', means: 'at most zero' },
        {
          syntax: 'at most 1-2x monster',
          means: 'an error — a limit names one ceiling; the message carries the rewrite',
          fails: 'a limit has one ceiling',
        },
      ],
      note: 'A limit counts only cards a line is specific enough to be KNOWN to match. The readout below lists the ones it cannot see.',
    },
    {
      heading: 'Joining terms',
      rows: [
        { syntax: '1x {starter} and 1x {extender}', means: 'both, and the two cards are distinct' },
        { syntax: '1x {starter}, 1x {extender}', means: 'a comma reads as `and`' },
        { syntax: '1x monster and no trap', means: 'requirements and limits mix freely' },
      ],
    },
    {
      heading: 'Choices',
      rows: [
        {
          syntax: '1x {starter} or 2x {extender}',
          means: 'a choice between TERMS: `or` followed by a count starts a new one',
        },
        {
          syntax: '1x {starter} or {extender}',
          means:
            'one slot either card fills: `or` followed by anything else stays inside the description',
        },
        {
          syntax: '1x ({starter} or {extender})',
          means: 'the same thing said plainly — and how the app writes it back',
        },
        {
          syntax: '(1x {starter} or 1x {extender}) and 1x monster',
          means: 'nesting expands: each branch becomes a whole criterion of its own',
        },
      ],
      note: 'One token decides which `or` you wrote: a count, `exactly`, `at most`, `no`, or a `(` before one of those starts a new term. Anything else continues the description.',
    },
    {
      heading: 'Two errors worth recognizing',
      rows: [
        {
          syntax: 'monster',
          means: 'a description on its own is not a criterion — it needs a count',
          fails: 'expected a count before the description',
        },
        {
          syntax: '0x2066 monster',
          means: 'a hex code where a count belongs; a count’s `x` has to end the word',
          fails: 'reads as a hex code',
        },
      ],
    },
  ],
  notes: [
    'A hand succeeds if it meets ANY ONE criterion: between criteria it is always `or`.',
    'Which hand a criterion is judged for — going first, going second, either hand — is the control on the row, not something written in its text.',
  ],
};

/** Both executable references, in the order they appear down the left column. */
export const EXAMPLE_SECTIONS: readonly ExampleSection[] = [DESCRIPTION_SYNTAX, CRITERION_SYNTAX];

/** The three runs (PRD §5.5), beside the control that picks one. */
export const RUN_MODE_REFERENCE: FactSection<ModeFact> = {
  id: 'run-modes',
  title: 'What the three runs mean',
  blurb: 'A run is one of three, and the choice sets both the hand and the criteria that judge it.',
  rows: [
    {
      mode: 'first',
      label: 'Going first',
      hand: '5 cards',
      means: 'Judges the criteria tagged going first and those tagged either hand.',
    },
    {
      mode: 'second',
      label: 'Going second',
      hand: '6 cards',
      means: 'Judges the criteria tagged going second and those tagged either hand.',
    },
    {
      mode: 'average',
      label: 'Average',
      hand: 'both',
      means:
        'Scores each hand against its own criteria and ranks by the mean of the two, taken per deck. The best average deck is often neither of the other two answers.',
    },
  ],
  notes: [
    'Average reports the two probabilities as well as the mean: the denominators genuinely differ, so one figure cannot stand for both.',
    'A criterion the run does not judge is dimmed rather than hidden, and the lines only it needed stop splitting the search.',
  ],
};

/**
 * What the template buttons read and write (PRD §9, TDD §14). The two
 * EXPORTS are a section of their own rather than two more rows here: they sit
 * in the results panel, a column away, and a reader at those buttons would
 * never find an answer filed under Open.
 */
export const FILE_REFERENCE: FactSection = {
  id: 'files',
  title: 'What these buttons read and write',
  blurb: 'Two formats, and only the first is the app’s own.',
  rows: [
    {
      label: 'Open… / Save… — .json',
      means:
        'The whole template: deck size, run, every line and criterion with what it means as well as its text, your groups, and the fields of each named card as this database had them.',
    },
    {
      label: 'Import a deck… — .ydk',
      means:
        'EDOPro’s decklist. The Main Deck only, one line per distinct card at the copies it holds, each line pinned to that exact count for you to widen. Extra and Side are ignored, and your criteria and groups are left alone.',
    },
  ],
  notes: [
    'A saved template keeps what each line MEANS beside its text, so a file opened after the vocabulary has changed still means what it meant.',
    'Nothing is ever written to your EDOPro install.',
  ],
};

/** What the two export buttons write (TDD §12), beside the buttons themselves. */
export const EXPORT_REFERENCE: FactSection = {
  id: 'exports',
  title: 'What these files hold',
  blurb: 'Both are of the run that produced the table, not of the template on screen.',
  rows: [
    {
      label: 'Ranked table — .csv',
      means:
        'One row per ranked ratio: its rank, the probability as an exact numerator and denominator, how many concrete ratios the row stands for, and a column per line.',
    },
    {
      label: 'Everything — .json',
      means:
        'The whole result as the worker produced it: every ranked vector, the per-line sweeps and the plateau.',
    },
  ],
  notes: [
    'Exact fractions, never percentages: divide the numerator by the denominator and a spreadsheet gets the number on screen; sort on the numerator and it gets the order the app ranked by.',
  ],
};

export const FACT_SECTIONS: readonly FactSection[] = [
  RUN_MODE_REFERENCE,
  FILE_REFERENCE,
  EXPORT_REFERENCE,
];
