import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../src/core/cards/index';
import { SetnameTable } from '../../src/core/cards/setnames';
import type { DescContext } from '../../src/core/desc/context';
import { matcher } from '../../src/core/desc/evaluate';
import { parse } from '../../src/core/desc/parser';
import { loadCardIndex, loadSetnames } from '../../src/main/edopro/loader';
import { FakeGroups } from '../helpers/desc-context';
import { checkExampleRow, syntaxRows } from '../helpers/syntax-rows';

// Opt-in integration test against a real EDOPro install (TDD §15.1); skipped in CI.
//   EDOPRO_WORKDIR=/path/to/ProjectIgnis npm test
//
// The fixture-context test (`syntax.test.ts`) proves the reference's examples
// are grammatical. This one proves they are TRUE of a real install: that the
// card names it prints resolve, that the passcode it prints is that card, and
// that `"Warrior"` really is the ambiguity it is shown to be. Between them
// they are why an example in the app can be trusted.
const EDOPRO_WORKDIR = process.env.EDOPRO_WORKDIR;

// Loaded once; empty when the variable is unset and every suite below skips.
const index = EDOPRO_WORKDIR ? loadCardIndex(EDOPRO_WORKDIR, await initSqlJs()) : CardIndex.empty();

/**
 * Groups are the user's own invention and never come from the database, so
 * the only double this context needs is the two names the reference uses.
 */
const ctx: DescContext = {
  cards: index,
  setnames: (EDOPRO_WORKDIR ? loadSetnames(EDOPRO_WORKDIR) : null) ?? SetnameTable.fromLayers([]),
  groups: new FakeGroups([
    ['g-starter', 'starter'],
    ['g-extender', 'extender'],
  ]),
};

const ASH = 14558127;

describe.skipIf(!EDOPRO_WORKDIR)('the syntax reference against a real EDOPro install', () => {
  /** The cards of the real pool a description matches. */
  function matched(text: string) {
    const result = parse(text, ctx);
    if (!result.ok) throw new Error(`${text}: ${result.message}`);
    return [...index.all()].filter(matcher(result.desc, new Map()));
  }

  it('loads a card pool and a setname table', () => {
    expect(index.status.cards).toBeGreaterThan(10000);
    expect(ctx.setnames!.lookup('Sky Striker')).toHaveLength(1);
  });

  // The same rule as the fixture test, against the real names and setcodes:
  // an invented card name or a setcode that is not ambiguous after all fails
  // here and nowhere else.
  it('parses every example, and fails the error examples, against real data', () => {
    for (const row of syntaxRows()) checkExampleRow(row, ctx);
  });

  it('names the same card by name and by passcode', () => {
    expect(index.get(ASH)?.name).toBe('Ash Blossom & Joyous Spring');
    expect(parse(`#${ASH}`, ctx)).toEqual(parse('[Ash Blossom & Joyous Spring]', ctx));
  });

  // Read off the reference rather than listed here, so a row that starts
  // naming a new card is covered without anyone remembering to add it.
  it('resolves every card the reference names to exactly one real card', () => {
    const named = syntaxRows().flatMap(({ row }) =>
      [...row.syntax.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]!),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(index.findByName(name), name).toHaveLength(1);
  });

  // The row says every Sky Striker Ace is a Sky Striker too; the pool is what
  // makes that worth saying, since the Ace cards are most of the archetype.
  it('includes the Ace cards in "Sky Striker"', () => {
    const strikers = matched('"Sky Striker"').map((card) => card.name);
    const aces = matched('"Sky Striker Ace"').map((card) => card.name);
    expect(aces.length).toBeGreaterThan(0);
    expect(aces.filter((name) => !strikers.includes(name))).toEqual([]);
    expect(strikers).toContain('Sky Striker Ace - Raye');
  });

  it('makes `card` the widest description there is', () => {
    expect(matched('card')).toHaveLength(index.status.cards);
  });

  it('reads `DIVINE Beast` as the Divine-Beast Type', () => {
    const beasts = matched('DIVINE Beast');
    expect(beasts.length).toBeGreaterThan(0);
    // RACE_DIVINE is 0x200000 (Appendix A); nothing here is a DIVINE Beast.
    expect(beasts.filter((card) => (card.race & 0x200000) === 0)).toEqual([]);
  });
});
