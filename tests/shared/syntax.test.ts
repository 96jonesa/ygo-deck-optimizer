import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TYPE_EFFECT, TYPE_MONSTER, TYPE_SPELL, TYPE_TRAP } from '../../src/core/cards/constants';
import type { CardRecord } from '../../src/core/cards/record';
import { canonicalizeExpr } from '../../src/core/criteria/ast';
import { expand } from '../../src/core/criteria/expand';
import { parseCriterion } from '../../src/core/criteria/parser';
import { canonicalize } from '../../src/core/desc/ast';
import { matcher } from '../../src/core/desc/evaluate';
import { type ImpliesContext, implies } from '../../src/core/desc/implies';
import { type DescContext, parse } from '../../src/core/desc/parser';
import { print } from '../../src/core/desc/print';
import { CRITERION_WEIGHT_MAX, RUN_MODES } from '../../src/core/model/template';
import {
  CRITERION_SYNTAX,
  DESCRIPTION_SYNTAX,
  EXAMPLE_SECTIONS,
  EXPORT_REFERENCE,
  FACT_SECTIONS,
  FILE_REFERENCE,
  RUN_MODE_REFERENCE,
  WEIGHTING_REFERENCE,
} from '../../src/shared/syntax';
import { cardRecord, contextOf, FakeCards, FakeGroups } from '../helpers/desc-context';
import { checkExampleRow, syntaxRows } from '../helpers/syntax-rows';

// The in-app syntax reference (PRD §8.2, §8.3). Its whole claim to being
// worth reading is that every example in it is EXECUTABLE: each row of an
// `ExampleSection` goes through the very parser the app runs, and the rows
// that claim a meaning have that meaning checked. A reference that drifts is
// worse than none.

/** Every `[Card Name]` the reference writes, in the order it writes them. */
const NAMED = [
  ...new Set(
    syntaxRows().flatMap(({ row }) =>
      [...row.syntax.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]!),
    ),
  ),
];

/**
 * The pool the reference is read against. The named cards are taken FROM the
 * reference rather than listed here on purpose: a fixture that spelled the
 * names itself would happily bless a card that does not exist, and whether a
 * name is real is exactly what `tests/shared/realdata.test.ts` is for. What
 * this fixture does pin is the passcode: `#14558127` has to be the same card
 * as the first name, or the row claiming so fails here.
 */
const ASH = 14558127;
const STRATOS = 40044918;
const REINFORCEMENT = 32807846;

const CARDS = new FakeCards([
  ...NAMED.map((name, at) => cardRecord({ code: at === 0 ? ASH : ASH + at, name })),
  cardRecord({ code: STRATOS, name: 'a card in the starter group' }),
  cardRecord({ code: REINFORCEMENT, name: 'a card in the extender group', type: TYPE_SPELL }),
]);

const GROUPS = new FakeGroups([
  ['g-starter', 'starter'],
  ['g-extender', 'extender'],
]);

const CTX: DescContext = contextOf(CARDS, { groups: GROUPS });
const IMPLY_CTX: ImpliesContext = {
  cards: CARDS,
  groups: new Map([
    ['g-starter', new Set([STRATOS])],
    ['g-extender', new Set([REINFORCEMENT])],
  ]),
};

/** The description a row of `DESCRIPTION_SYNTAX` parses to; fails the test if it does not. */
function desc(text: string) {
  const result = parse(text, CTX);
  if (!result.ok) throw new Error(`\`${text}\` does not parse: ${result.message}`);
  return canonicalize(result.desc);
}

/** The expression a row of `CRITERION_SYNTAX` parses to; fails the test if it does not. */
function criterion(text: string) {
  const result = parseCriterion(text, CTX);
  if (!result.ok) throw new Error(`\`${text}\` does not parse: ${result.message}`);
  return canonicalizeExpr(result.expr);
}

describe('EXAMPLE_SECTIONS', () => {
  it('holds the description and criterion references, in that order', () => {
    expect(EXAMPLE_SECTIONS).toEqual([DESCRIPTION_SYNTAX, CRITERION_SYNTAX]);
  });

  // The rule the whole file exists for. Every row, both sections, one test:
  // a new row is covered the moment it is written, with nothing to remember.
  it('parses every example with the parser its section names', () => {
    const rows = syntaxRows();
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) checkExampleRow(row, CTX);
  });

  it('shows at least one real error message per section', () => {
    for (const section of EXAMPLE_SECTIONS) {
      const failing = section.groups.flatMap((group) =>
        group.rows.filter((row) => row.fails !== undefined),
      );
      expect(failing.length, section.id).toBeGreaterThan(0);
    }
  });

  // Per section, not across both: `monster` is deliberately in each, as the
  // plainest description there is and as the criterion that forgot its count.
  // Within one table a repeat is drift, and this is what catches it.
  it('writes every example once within its own section', () => {
    for (const section of EXAMPLE_SECTIONS) {
      const written = section.groups.flatMap((group) => group.rows.map((row) => row.syntax));
      expect(new Set(written).size, section.id).toBe(written.length);
    }
  });

  it('gives every section, group and row something to say', () => {
    for (const section of EXAMPLE_SECTIONS) {
      expect(section.id).toMatch(/^[a-z-]+$/);
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.blurb.length).toBeGreaterThan(0);
      expect(section.groups.length).toBeGreaterThan(0);
      for (const group of section.groups) {
        expect(group.heading.length, section.id).toBeGreaterThan(0);
        expect(group.rows.length, group.heading).toBeGreaterThan(0);
        for (const row of group.rows) expect(row.means.length, row.syntax).toBeGreaterThan(0);
      }
    }
  });

  it('gives the two sections different ids', () => {
    expect(new Set(EXAMPLE_SECTIONS.map((section) => section.id)).size).toBe(
      EXAMPLE_SECTIONS.length,
    );
  });
});

describe('DESCRIPTION_SYNTAX', () => {
  it('is parsed as a description', () => {
    expect(DESCRIPTION_SYNTAX.parses).toBe('description');
  });

  // The claims the rows make, each checked against the engine that decides it.
  describe('the meanings its rows claim', () => {
    it('makes `card` the widest description there is', () => {
      expect(implies(desc('level 4 monster'), desc('card'), IMPLY_CTX)).toBe(true);
      expect(implies(desc('spell'), desc('card'), IMPLY_CTX)).toBe(true);
      expect(implies(desc('card'), desc('monster'), IMPLY_CTX)).toBe(false);
    });

    it('lets `/` inside one dimension mean either value', () => {
      const monster = (over: Partial<CardRecord>) => cardRecord({ type: TYPE_MONSTER, ...over });
      const match = matcher(desc('FIRE/WATER monster'), new Map());
      expect(match(monster({ attribute: 0x04 }))).toBe(true);
      expect(match(monster({ attribute: 0x02 }))).toBe(true);
      expect(match(monster({ attribute: 0x10 }))).toBe(false);
    });

    it('lets `spell/trap` mean either kind and no monster', () => {
      const match = matcher(desc('spell/trap'), new Map());
      expect(match(cardRecord({ type: TYPE_SPELL }))).toBe(true);
      expect(match(cardRecord({ type: TYPE_TRAP }))).toBe(true);
      expect(match(cardRecord({ type: TYPE_MONSTER | TYPE_EFFECT }))).toBe(false);
    });

    // TDD §5.1: `or` separates whole descriptions, so neither alternative
    // says anything about the other's dimension. This is the row's claim.
    it('leaves each side of an `or` silent about the other', () => {
      const either = desc('FIRE monster or level 4 monster');
      expect(implies(either, desc('monster'), IMPLY_CTX)).toBe(true);
      expect(implies(either, desc('FIRE monster'), IMPLY_CTX)).toBe(false);
      expect(implies(either, desc('level 4 monster'), IMPLY_CTX)).toBe(false);
    });

    it('makes every Sky Striker Ace a Sky Striker', () => {
      expect(implies(desc('"Sky Striker Ace"'), desc('"Sky Striker"'), IMPLY_CTX)).toBe(true);
      expect(implies(desc('"Sky Striker"'), desc('"Sky Striker Ace"'), IMPLY_CTX)).toBe(false);
    });

    it('writes an ambiguous archetype with its setcode, and prints it back', () => {
      const ast = desc('"Warrior":0x2066 monster');
      expect(print(ast, CTX)).toBe('"Warrior":0x2066 monster');
    });

    // Read off the rows, not written out again here: the row says the two
    // forms are the same card, so it is the row's own text that is compared.
    it('names one card two ways, and means the same card both times', () => {
      const written = DESCRIPTION_SYNTAX.groups.flatMap((group) =>
        group.rows.map((row) => row.syntax),
      );
      const byName = written.find((syntax) => syntax.startsWith('['));
      const byPasscode = written.find((syntax) => syntax.startsWith('#'));
      expect([byName, byPasscode].filter((row) => row === undefined)).toEqual([]);
      expect(desc(byPasscode!)).toEqual(desc(byName!));
    });

    it('ignores case and hyphens', () => {
      expect(desc('LEVEL 4 MONSTERS')).toEqual(desc('level 4 monster'));
      expect(desc('beast warrior')).toEqual(desc('Beast-Warrior'));
    });

    // The lexer hazard of TDD §5.1, and the reason that row is in the table.
    it('reads `DIVINE Beast` as the Divine-Beast Type, not a DIVINE Beast', () => {
      expect(desc('DIVINE Beast')).toEqual(desc('Divine-Beast'));
      expect(desc('DIVINE Beast')).not.toEqual(desc('DIVINE Beast monster or Beast monster'));
      expect(implies(desc('DIVINE Beast'), desc('DIVINE monster'), IMPLY_CTX)).toBe(false);
    });

    it('keeps `?` out of every numeric range', () => {
      const unknown = cardRecord({ type: TYPE_MONSTER | TYPE_EFFECT, atk: -2 });
      expect(matcher(desc('ATK ? monster'), new Map())(unknown)).toBe(true);
      expect(matcher(desc('ATK 2000 or more monster'), new Map())(unknown)).toBe(false);
      expect(matcher(desc('2000 ATK monster'), new Map())(unknown)).toBe(false);
    });

    it('reads `normal` beside a kind word as that kind of normal', () => {
      const normalSpell = matcher(desc('normal spell'), new Map());
      expect(normalSpell(cardRecord({ type: TYPE_SPELL }))).toBe(true);
      expect(normalSpell(cardRecord({ type: TYPE_MONSTER }))).toBe(false);
      expect(matcher(desc('normal monster'), new Map())(cardRecord({ type: TYPE_SPELL }))).toBe(
        false,
      );
    });

    it('resolves a group to the cards in it', () => {
      const match = matcher(desc('{starter}'), IMPLY_CTX.groups);
      expect(match(cardRecord({ code: STRATOS }))).toBe(true);
      expect(match(cardRecord({ code: ASH }))).toBe(false);
    });
  });
});

describe('CRITERION_SYNTAX', () => {
  it('is parsed as a criterion', () => {
    expect(CRITERION_SYNTAX.parses).toBe('criterion');
  });

  /**
   * The criteria disclosure must not teach the description language a second
   * time (that is the Template panel's job), so it points at it in words and
   * its own rows keep their descriptions to the plainest forms there are.
   */
  it('points at the description reference rather than repeating it', () => {
    const prose = [CRITERION_SYNTAX.blurb, ...CRITERION_SYNTAX.notes].join(' ');
    expect(prose).toContain(DESCRIPTION_SYNTAX.title);
  });

  describe('the meanings its rows claim', () => {
    it('makes the `x` optional', () => {
      expect(criterion('2 level 4 monster')).toEqual(criterion('2x level 4 monster'));
    });

    it('makes `exactly nx` the range whose ends agree', () => {
      expect(criterion('exactly 1x monster')).toEqual(criterion('1-1x monster'));
    });

    it('gives a range requirement a ceiling as well as a floor', () => {
      expect(criterion('1-2x monster')).toMatchObject({ op: 'req', n: 1, max: 2 });
      expect(criterion('2x monster')).toMatchObject({ op: 'req', n: 2 });
      expect(criterion('2x monster')).not.toHaveProperty('max');
    });

    it('makes `no` a limit of zero', () => {
      expect(criterion('no trap')).toEqual(criterion('at most 0x trap'));
      expect(criterion('at most 1x trap')).toMatchObject({ op: 'atMost', n: 1 });
    });

    it('reads `,` as `and`', () => {
      expect(criterion('1x {starter}, 1x {extender}')).toEqual(
        criterion('1x {starter} and 1x {extender}'),
      );
    });

    // TDD §7.1: one token of lookahead separates the two `or`s. A count after
    // `or` starts a new TERM; anything else continues the DESCRIPTION.
    it('separates the two `or`s by what follows them', () => {
      const terms = criterion('1x {starter} or 2x {extender}');
      expect(terms).toMatchObject({ op: 'or' });
      if (terms.op === 'or') expect(terms.args).toHaveLength(2);

      const slot = criterion('1x {starter} or {extender}');
      expect(slot).toMatchObject({ op: 'req', n: 1 });
      expect(slot).toEqual(criterion('1x ({starter} or {extender})'));
    });

    it('splits the hand at `then`, and binds it looser than `and` and `or`', () => {
      const expr = criterion(
        '1x {starter} and 1x {extender} then 1x [Ash Blossom & Joyous Spring]',
      );
      expect(expr).toMatchObject({ op: 'split' });
      if (expr.op !== 'split') throw new Error('not a split');
      // The whole `and` is the five-card part; only the last term is the card drawn.
      expect(expr.five).toEqual(criterion('1x {starter} and 1x {extender}'));
      expect(expr.sixth).toEqual(criterion('1x [Ash Blossom & Joyous Spring]'));
    });

    it('leaves the five unasked about when `then` leads', () => {
      const expr = criterion('then 1x [Ash Blossom & Joyous Spring]');
      expect(expr).toMatchObject({ op: 'split' });
      expect(expr).not.toHaveProperty('five');
    });

    /**
     * The claim the row's `means` makes, and the reason the feature exists: the
     * split is NOT the same question as asking the same of all six cards. Two
     * requirements over six cards, against one over five and one over the card
     * drawn.
     */
    it('is a different criterion from asking the same of all six cards', () => {
      const split = expand(criterion('1x {starter} then no trap'), { maxHandSize: 6 });
      const whole = expand(criterion('1x {starter} and no trap'), { maxHandSize: 6 });
      expect(split.ok && whole.ok).toBe(true);
      if (!split.ok || !whole.ok) throw new Error('expansion failed');
      expect(split.flat[0]!.sixth).toBeDefined();
      expect(whole.flat[0]).not.toHaveProperty('sixth');
      expect(split.flat).not.toEqual(whole.flat);
    });

    it('expands a nested `or` into one alternative per branch', () => {
      const expr = criterion('(1x {starter} or 1x {extender}) and 1x monster');
      const result = expand(expr, { maxHandSize: 6 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.flat).toHaveLength(2);
        for (const flat of result.flat) expect(flat.reqs).toHaveLength(2);
      }
    });
  });
});

describe('FACT_SECTIONS', () => {
  it('holds the run modes, weighting, the files and the exports, in that order', () => {
    expect(FACT_SECTIONS).toEqual([
      RUN_MODE_REFERENCE,
      WEIGHTING_REFERENCE,
      FILE_REFERENCE,
      EXPORT_REFERENCE,
    ]);
  });

  it('gives every section, group and row something to say', () => {
    for (const section of FACT_SECTIONS) {
      expect(section.id).toMatch(/^[a-z-]+$/);
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.blurb.length).toBeGreaterThan(0);
      expect(section.rows.length).toBeGreaterThan(0);
      for (const row of section.rows) {
        expect(row.label.length, section.id).toBeGreaterThan(0);
        expect(row.means.length, row.label).toBeGreaterThan(0);
      }
    }
  });

  it('gives every section a distinct id, shared with no example section', () => {
    const ids = [...FACT_SECTIONS, ...EXAMPLE_SECTIONS].map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Weighting adds no grammar, so there is nothing here for the executable
 * reference to parse — what there IS to hold is that the numbers the prose
 * quotes are the numbers the code enforces.
 */
describe('WEIGHTING_REFERENCE', () => {
  it('quotes the bound the editor actually enforces', () => {
    expect(CRITERION_WEIGHT_MAX).toBe(1000);
    const bounds = WEIGHTING_REFERENCE.rows.filter((row) =>
      row.means.includes(`1 to ${CRITERION_WEIGHT_MAX}`),
    );
    expect(bounds).toHaveLength(1);
  });

  it('says the two things a reader most needs: highest, not sum; and reversible', () => {
    const text = WEIGHTING_REFERENCE.rows.map((row) => row.means).join(' ');
    expect(text).toContain('HIGHEST');
    expect(text).toContain('never their sum');
    expect(text).toContain('exactly the answer the template had before');
  });
});

describe('RUN_MODE_REFERENCE', () => {
  it('describes exactly the three run modes core knows', () => {
    expect(RUN_MODE_REFERENCE.rows.map((row) => row.mode)).toEqual([...RUN_MODES]);
  });

  it('says which hand each mode is judged at', () => {
    expect(RUN_MODE_REFERENCE.rows.map((row) => row.hand)).toEqual(['5 cards', '6 cards', 'both']);
  });
});

// TDD §3: the renderer bundles `src/shared`, so this file may not drag the
// engine into it. Type imports vanish at compile time; a value import would
// not, and no lint rule guards `src/shared` — this test is the guard.
describe('src/shared/syntax.ts', () => {
  const source = readFileSync(new URL('../../src/shared/syntax.ts', import.meta.url), 'utf8');
  // The comments say the word `import` about the file itself; the code is
  // what is under test, so they come out before anything is looked for.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('imports nothing at runtime', () => {
    // The `from` must be followed by a QUOTED module specifier, which every
    // real import has and no prose does: the reference is full of sentences
    // like "a whole number from 1 to 1000", and a bare `\sfrom\s` called one
    // of them an import.
    const imports = code.match(/^\s*(import|export)\s[^;]*?\sfrom\s+['"][^'"]*['"]/gm) ?? [];
    expect(imports.filter((line) => !/^\s*(import|export)\s+type\s/.test(line))).toEqual([]);
  });

  it('would still catch a real runtime import, on one line or several', () => {
    const guard = /^\s*(import|export)\s[^;]*?\sfrom\s+['"][^'"]*['"]/gm;
    expect("import { parse } from '../core/desc/parser';").toMatch(guard);
    expect("export { RUN_MODES } from '../core/model/template';").toMatch(guard);
    expect("import {\n  parse,\n  print,\n} from '../core/desc/parser';").toMatch(guard);
    expect('a whole number from 1 to 1000').not.toMatch(guard);
  });

  it('requires nothing at runtime either', () => {
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });
});
