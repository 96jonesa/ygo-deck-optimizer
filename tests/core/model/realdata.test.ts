import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../../src/core/cards/index';
import { analyze } from '../../../src/core/model/analyze';
import {
  type CompileResult,
  compileProblem,
  handSizesForMode,
  REMAINDER_ID,
  resolveTemplate,
} from '../../../src/core/model/compile';
import { handSizeForMode, type RunMode, type Template } from '../../../src/core/model/template';
import { templateFromDeck } from '../../../src/core/model/ydk';
import { exampleRatio, optimize } from '../../../src/core/opt/optimizer';
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

/**
 * The three modes against a real install (PRD §5.5), on a template built to
 * make them disagree: going first wants the starter it combos off, going
 * second wants the second breaker a sixth card makes reachable, and the
 * average wants neither ratio but a third one.
 *
 * Three claims, and the third is the one worth having:
 *
 *  1. every mode enumerates the SAME class vectors, because the classes come
 *     from the union of both criteria sets whichever mode is run;
 *  2. the three modes pick three DIFFERENT decks, so this is a real witness
 *     and not a template where the question does not arise;
 *  3. on ONE deck — the average's own best — the average is exactly the mean
 *     of what the two single modes score there. Not of what they score at
 *     their own optima, which is a different and much weaker claim.
 */
describe.skipIf(!EDOPRO_WORKDIR)(
  'the three run modes disagree, and the average is their mean',
  () => {
    /** Two criteria pulling opposite ways, and one that counts either way. */
    const SPLIT: Template = {
      version: 1,
      deckSize: 40,
      hand: { size: 6 },
      mode: 'average',
      groups: [],
      lines: [
        { id: 'starter', text: '[Sage with Eyes of Blue]', min: 0, max: 3 },
        { id: 'engine', text: 'level 4 or lower monster', min: 6, max: 18 },
        { id: 'breaker', text: 'spell', min: 6, max: 18 },
        { id: 'trap', text: 'trap', min: 0, max: 8 },
      ],
      remainder: { min: 0, max: 6 },
      criteria: [
        {
          id: 'c1',
          when: 'first',
          text: '1x [Sage with Eyes of Blue] and 1x level 4 or lower monster',
        },
        { id: 'c2', when: 'second', text: '2x spell and 1x level 4 or lower monster' },
        { id: 'c3', when: 'both', text: '1x level 4 or lower monster and 1x trap' },
      ],
    };

    /** `SPLIT` with every line pinned to one count: one deck, and only one. */
    function pinned(counts: Record<string, number>): Template {
      return {
        ...SPLIT,
        lines: SPLIT.lines.map((line) => ({
          ...line,
          min: counts[line.id]!,
          max: counts[line.id]!,
        })),
        remainder: { min: 0, max: 0 },
      };
    }

    function bestOf(template: Template, mode: RunMode) {
      const inMode: Template = { ...template, mode, hand: { size: handSizeForMode(mode) } };
      const resolved = resolveTemplate(inMode, ctx);
      if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
      const compiled = compileProblem(resolved.resolved, {
        handSizes: handSizesForMode(resolved.resolved, mode),
      });
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      const result = optimize(compiled, { force: true });
      if (result.status !== 'done') throw new Error(`the search did not finish: ${result.status}`);
      const counts = Object.fromEntries(
        exampleRatio(compiled, result.best.classTotals).map((count, at) => [
          lineIdAt(compiled, at),
          count,
        ]),
      );
      return { compiled, result, counts, best: result.best };
    }

    /** The line id at position `at` of a compiled template, the remainder last. */
    function lineIdAt(compiled: Extract<CompileResult, { ok: true }>, at: number): string {
      for (const cls of compiled.classes)
        for (const line of cls.lines) if (line.line === at) return line.id;
      throw new Error(`no line at ${at}`);
    }

    const modes = {
      first: bestOf(SPLIT, 'first'),
      second: bestOf(SPLIT, 'second'),
      average: bestOf(SPLIT, 'average'),
    };

    it('scores the same class vectors in every mode: the classes are the union’s', () => {
      const totals = Object.values(modes).map((run) => run.result.total);
      expect(new Set(totals)).toEqual(new Set([1399]));
      const classes = Object.values(modes).map((run) =>
        JSON.stringify(run.compiled.problem.classes),
      );
      expect(new Set(classes).size).toBe(1);
    });

    it('picks a DIFFERENT best deck in each mode', () => {
      const decks = Object.values(modes).map((run) => run.best.classTotals.join(','));
      expect(new Set(decks).size).toBe(3);
      // The ratios the three modes want, for the record.
      expect(modes.first.counts).toEqual({
        starter: 3,
        engine: 18,
        breaker: 11,
        trap: 8,
        remainder: 0,
      });
      expect(modes.second.counts).toEqual({
        starter: 0,
        engine: 17,
        breaker: 15,
        trap: 8,
        remainder: 0,
      });
      expect(modes.average.counts).toEqual({
        starter: 3,
        engine: 16,
        breaker: 13,
        trap: 8,
        remainder: 0,
      });
    });

    it('reports each mode’s best as the exact fraction of its own hand', () => {
      expect(modes.first.best.score.parts).toEqual([
        { H: 5, weight: 1, num: 527_097, den: 658_008 },
      ]);
      expect(modes.second.best.score.parts).toEqual([
        { H: 6, weight: 1, num: 3_632_237, den: 3_838_380 },
      ]);
      expect(modes.average.best.score.parts).toEqual([
        { H: 5, weight: 1, num: 518_046, den: 658_008 },
        { H: 6, weight: 1, num: 3_605_820, den: 3_838_380 },
      ]);
      expect(modes.average.best.blend).toEqual({ num: 39_766_530, den: 46_060_560 });
    });

    /**
     * The check the whole design turns on. The average's own best deck, scored
     * by each single mode ON THAT DECK: the two numbers must be the parts the
     * average reported, and their mean must be the average's `blend` — exactly,
     * in BigInt, with no float anywhere.
     */
    it('is the mean of the two single modes ON THE SAME DECK, exactly', () => {
      const deck = pinned(modes.average.counts);
      const first = bestOf(deck, 'first').best;
      const second = bestOf(deck, 'second').best;
      expect(first.score.parts[0]).toEqual(modes.average.best.score.parts[0]);
      expect(second.score.parts[0]).toEqual(modes.average.best.score.parts[1]);

      const a = first.score.parts[0]!;
      const b = second.score.parts[0]!;
      const { num, den } = modes.average.best.blend;
      // (a/den_a + b/den_b) / 2 == num / den.
      expect((BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den)) * BigInt(den)).toBe(
        2n * BigInt(a.den) * BigInt(b.den) * BigInt(num),
      );
    });

    it('is NOT the mean of the two modes at their own optima, which would be higher', () => {
      // The trap the claim above avoids: each mode's own best is at least as
      // good as its share of the average's deck, so averaging the OPTIMA
      // overstates what any one deck reaches.
      const optima = 527_097 / 658_008 / 2 + 3_632_237 / 3_838_380 / 2;
      const real = 39_766_530 / 46_060_560;
      expect(optima).toBeGreaterThan(real);
    });
  },
);
