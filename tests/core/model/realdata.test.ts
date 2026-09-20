import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../../src/core/cards/index';
import { analyze } from '../../../src/core/model/analyze';
import { compileProblem, REMAINDER_ID, resolveTemplate } from '../../../src/core/model/compile';
import { templateFromDeck } from '../../../src/core/model/ydk';
import { createScorer } from '../../../src/core/prob/scorer';
import { loadCardIndex, loadSetnames } from '../../../src/main/edopro/loader';
import { motivatingTemplate } from '../../helpers/motivating';

// Opt-in integration test against a real EDOPro install (TDD §15.1); skipped in CI.
//   EDOPRO_WORKDIR=/path/to/ProjectIgnis npm test
const EDOPRO_WORKDIR = process.env.EDOPRO_WORKDIR;

const cards = EDOPRO_WORKDIR ? loadCardIndex(EDOPRO_WORKDIR, await initSqlJs()) : CardIndex.empty();
const ctx = { cards, setnames: EDOPRO_WORKDIR ? loadSetnames(EDOPRO_WORKDIR) : null };

describe.skipIf(!EDOPRO_WORKDIR)('the motivating example against a real install (A3, C3)', () => {
  const template = motivatingTemplate();

  it('compiles to the five classes of TDD §11.1 and scores 46185/658008 at max', () => {
    const resolved = resolveTemplate(template, ctx);
    if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
    const compiled = compileProblem(resolved.resolved);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    expect(compiled.problem.classes.map((cls) => cls.lineIds)).toEqual([
      ['spell', 'normal-spell', REMAINDER_ID],
      ['A'],
      ['B'],
      ['monster', 'fire-bw'],
      ['level4'],
    ]);
    // The real Stratos is a Level 4 monster and the real Reinforcement of the Army a Normal Spell.
    expect(createScorer(compiled.problem, 5).score([23, 3, 3, 8, 3])).toEqual({
      num: 46185,
      den: 658008,
    });
  });

  it('analyzes as the PRD describes it', () => {
    const a = analyze(template, ctx);
    expect(a.ok).toBe(true);

    const low = a.requirements.find((r) => r.text === 'level 4 or lower monster')!;
    expect(low.filledBy).toEqual(['A', 'level4']);
    expect(low.nearMisses.find((miss) => miss.line === 'monster')).toMatchObject({
      explanation: '`monster`: Level unstated',
      suggestion: 'level 4 or lower monster',
    });

    expect(a.classes!.irrelevant).toEqual(['spell', 'normal-spell', REMAINDER_ID]);
    expect(a.criteria.find((c) => c.id === 'c2')).toMatchObject({
      subsumed: [{ alternative: 0, by: { criterion: 'c1', alternative: 0 } }],
      redundant: true,
    });
    expect(a.criteria.find((c) => c.id === 'c1')!.subsumed).toEqual([]);

    expect(a.totals.kinds.map(({ kind, range }) => [kind, range])).toEqual([
      ['monster', { min: 7, max: 14 }],
      ['spell', { min: 0, max: 13 }],
      ['trap', { min: 0, max: 0 }],
    ]);
    expect(a.totals.remainder).toEqual({ min: 13, max: 33 });
    expect(a.work).toMatchObject({ rawRatios: 4096, classVectors: 128 });

    // Reported by the test run, so the numbers can be read off the log.
    const start = performance.now();
    for (let i = 0; i < 20; i++) analyze(template, ctx);
    const cold = (performance.now() - start) / 20;
    const memo = new Map();
    analyze(template, { ...ctx, memo });
    const warmStart = performance.now();
    for (let i = 0; i < 20; i++) analyze(template, { ...ctx, memo });
    const warm = (performance.now() - warmStart) / 20;
    console.log(
      `analyze(motivating) against ${cards.status.cards} cards: ${cold.toFixed(2)} ms, ${warm.toFixed(2)} ms with the match memo`,
    );
  });
});

describe.skipIf(!EDOPRO_WORKDIR)('importing a real decklist', () => {
  // The hazard TDD §19 parked until `.ydk` import landed, on the real index.
  it('reads the alternate-art Harpie’s Feather Duster a real deck carries', () => {
    expect(cards.get(18144507)).toBeUndefined();
    const imported = templateFromDeck([18144507, ...Array(39).fill(14558127)], cards);
    expect(imported.warnings).toEqual([
      'the deck holds 39 copies of Ash Blossom & Joyous Spring; a deck holds at most 3 copies of one card, so its line is 3',
    ]);
    expect(imported.template.lines[0]).toEqual({
      id: 'card1',
      card: { passcode: 18144506, name: "Harpie's Feather Duster" },
      min: 1,
      max: 1,
    });
  });
});
