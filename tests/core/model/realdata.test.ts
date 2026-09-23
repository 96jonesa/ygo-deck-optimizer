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
      successNum: 46185,
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
    // Thirty-nine copies of one card is no longer something to warn about (PRD §5.1).
    expect(imported.warnings).toEqual([]);
    expect(imported.template.lines[0]).toEqual({
      id: 'card1',
      card: { passcode: 18144506, name: "Harpie's Feather Duster" },
      min: 1,
      max: 1,
    });
    expect(imported.template.lines[1]).toMatchObject({ min: 39, max: 39 });
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
 *  1. each mode enumerates the class vectors ITS OWN criteria call for — the
 *     average the union of both sets, a single mode only its own — and the
 *     narrowing moves no probability;
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
      version: 2,
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

    /**
     * The three runs, computed on FIRST USE rather than here in the describe
     * body. `describe.skipIf` skips the tests but still executes the body, so
     * building these eagerly turned a skip into a suite failure wherever the
     * real card database is absent — which is every CI run.
     */
    let runs: Record<RunMode, ReturnType<typeof bestOf>> | undefined;
    const modes = (): Record<RunMode, ReturnType<typeof bestOf>> => {
      runs ??= {
        first: bestOf(SPLIT, 'first'),
        second: bestOf(SPLIT, 'second'),
        average: bestOf(SPLIT, 'average'),
      };
      return runs;
    };

    it('narrows a single mode to the classes its OWN criteria tell apart', () => {
      // The average judges all three criteria and walks 1,399 vectors; going
      // first judges two of them and walks 305 — exactly what it would have
      // walked had the going-second criterion never been written.
      expect(modes().average.result.total).toBe(1399);
      expect(modes().first.result.total).toBe(305);
      expect(modes().second.result.total).toBe(440);
      expect(modes().average.compiled.problem.classes).toHaveLength(5);
      expect(modes().first.compiled.problem.classes).toHaveLength(4);
      expect(modes().second.compiled.problem.classes).toHaveLength(4);
    });

    /**
     * What narrowing costs: nothing in the answer, something in its
     * specificity. Coarsening to the criteria actually judged cannot move a
     * probability — the lines it merges are ones no surviving criterion can
     * tell apart — but a class vector then stands for more decks, and the
     * report says so rather than naming one of them.
     *
     * Going first, no criterion mentions `spell`, so `breaker` merges with the
     * unspecified cards: eleven cards that are 6–11 spells and the rest
     * anything, all scoring the same. That is the honest answer, and under the
     * union partition it was hidden behind an arbitrary `breaker 11`.
     */
    it('picks a DIFFERENT best deck in each mode', () => {
      const decks = Object.values(modes()).map((run) => JSON.stringify(run.counts));
      expect(new Set(decks).size).toBe(3);
      // ONE deck behind each best vector (`exampleRatio`). Going second the
      // starter is just another low-Level monster, so the 17 between them
      // split any way; this is the representative, not the only answer.
      expect(modes().first.counts).toEqual({
        starter: 3,
        engine: 18,
        breaker: 11,
        trap: 8,
        remainder: 0,
      });
      expect(modes().second.counts).toEqual({
        starter: 3,
        engine: 14,
        breaker: 15,
        trap: 8,
        remainder: 0,
      });
      expect(modes().average.counts).toEqual({
        starter: 3,
        engine: 16,
        breaker: 13,
        trap: 8,
        remainder: 0,
      });
    });

    it('answers a single mode with the ratio RANGE its criteria cannot tell apart', () => {
      expect(modes().first.best.rawRatios).toBe(6);
      expect(modes().second.best.rawRatios).toBe(4);
      // The average tells everything apart, so its best is one deck exactly.
      expect(modes().average.best.rawRatios).toBe(1);
    });

    it('reports each mode’s best as the exact fraction of its own hand', () => {
      // `successNum` is the same number as `num` throughout: nothing is weighted.
      const part = (H: number, num: number, den: number) => ({
        H,
        weight: 1,
        num,
        den,
        successNum: num,
      });
      expect(modes().first.best.score.parts).toEqual([part(5, 527_097, 658_008)]);
      expect(modes().second.best.score.parts).toEqual([part(6, 3_632_237, 3_838_380)]);
      expect(modes().average.best.score.parts).toEqual([
        part(5, 518_046, 658_008),
        part(6, 3_605_820, 3_838_380),
      ]);
      expect(modes().average.best.blend).toEqual({ num: 39_766_530, den: 46_060_560 });
    });

    /**
     * The check the whole design turns on. The average's own best deck, scored
     * by each single mode ON THAT DECK: the two numbers must be the parts the
     * average reported, and their mean must be the average's `blend` — exactly,
     * in BigInt, with no float anywhere.
     */
    it('is the mean of the two single modes ON THE SAME DECK, exactly', () => {
      const deck = pinned(modes().average.counts);
      const first = bestOf(deck, 'first').best;
      const second = bestOf(deck, 'second').best;
      expect(first.score.parts[0]).toEqual(modes().average.best.score.parts[0]);
      expect(second.score.parts[0]).toEqual(modes().average.best.score.parts[1]);

      const a = first.score.parts[0]!;
      const b = second.score.parts[0]!;
      const { num, den } = modes().average.best.blend;
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

/**
 * The headline of the narrowing (PRD §5.5). Fifteen going-first criteria and
 * fifteen going-second ones, each naming a card of its own: each half tells 16
 * classes apart, and the two together tell 31 — one past `MAX_CLASSES`.
 *
 * Going first and going second must therefore SUCCEED, over the 16 classes
 * their own criteria need. Only the average is refused, and rightly: it really
 * does have to tell all 31 apart to score both hands over one deck.
 *
 * This is the case that made the union unconditional untenable: a feature for
 * splitting criteria in two must not refuse a run for criteria it never
 * evaluates.
 */
// Real cards, so it is opt-in like its three siblings above: it draws 30
// distinct passcodes out of the install to build 30 named-card criteria.
describe.skipIf(!EDOPRO_WORKDIR)(
  'a template too wide for the average but not for either hand',
  () => {
    /** Distinct cards this install really has; collected once, on first use. */
    let pool: number[] | null = null;
    function codesOf(n: number): number[] {
      if (pool === null) {
        const found: number[] = [];
        cards.count((card) => {
          if (found.length < 40) found.push(card.code);
          return false;
        });
        pool = found;
      }
      if (pool.length < n) throw new Error(`this install has ${pool.length} cards, not ${n}`);
      return pool.slice(0, n);
    }

    /** `first` going-first criteria and `second` going-second ones, a card each. */
    function split(first: number, second: number): Template {
      const codes = codesOf(first + second);
      return {
        version: 2,
        deckSize: 40,
        hand: { size: 6 },
        mode: 'average',
        groups: [],
        lines: codes.map((passcode, at) => ({
          id: `l${at}`,
          card: { passcode, name: `card${at}` },
          min: 0,
          max: 1,
        })),
        remainder: { min: 0, max: 40 },
        criteria: codes.map((passcode, at) => ({
          id: `c${at}`,
          text: `1x #${passcode}`,
          when: at < first ? ('first' as const) : ('second' as const),
        })),
      };
    }

    function compileIn(template: Template, mode: RunMode): CompileResult {
      const inMode: Template = { ...template, mode, hand: { size: handSizeForMode(mode) } };
      const resolved = resolveTemplate(inMode, ctx);
      if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
      return compileProblem(resolved.resolved, {
        handSizes: handSizesForMode(resolved.resolved, mode),
      });
    }

    it('compiles each single mode over its own 16 classes', () => {
      const wide = split(15, 15);
      for (const mode of ['first', 'second'] as const) {
        const result = compileIn(wide, mode);
        if (!result.ok) throw new Error(`${mode} was refused: ${result.errors.join('\n')}`);
        expect(result.problem.classes).toHaveLength(16);
        expect(result.problem.criteria).toHaveLength(15);
        // The other hand's fifteen lines cannot be told apart here, so they are
        // all in the blank class together.
        expect(result.problem.classes[0]!.lineIds).toHaveLength(16);
      }
    });

    it('refuses only the average, which really does need all 31', () => {
      const result = compileIn(split(15, 15), 'average');
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.errors[0]).toMatch(/31 classes.*at most 30/);
    });

    it('would refuse every mode if the classes came from the union', () => {
      // The state of affairs this change replaced, reproduced by handing every
      // hand every alternative: the going-first run is refused for criteria it
      // never evaluates.
      const inMode: Template = { ...split(15, 15), mode: 'first', hand: { size: 5 } };
      const resolved = resolveTemplate(inMode, ctx);
      if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
      const asUnion = compileProblem(resolved.resolved, { handSizes: [{ H: 5, weight: 1 }] });
      expect(asUnion.ok).toBe(false);
      expect(asUnion.ok ? '' : asUnion.errors[0]).toMatch(/31 classes/);
    });

    it('is not a contrivance: 14 + 14 fits the average too, and 15 + 15 is the edge', () => {
      expect(compileIn(split(14, 14), 'average').ok).toBe(true);
      expect(compileIn(split(15, 15), 'average').ok).toBe(false);
    });
  },
);
