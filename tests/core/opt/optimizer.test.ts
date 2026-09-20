import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { expand } from '../../../src/core/criteria/expand';
import {
  type CompileInput,
  type CompileResult,
  compileProblem,
  REMAINDER_ID,
  resolveTemplate,
} from '../../../src/core/model/compile';
import type { HandSize } from '../../../src/core/model/problem';
import { walkVectors } from '../../../src/core/opt/enumerate';
import {
  breakdown,
  exampleRatio,
  type OptimizeOptions,
  type OptimizeProgress,
  type OptimizeResult,
  optimize,
  type Rational,
  type ScoredVector,
  sweepFixed,
} from '../../../src/core/opt/optimizer';
import { createScorer } from '../../../src/core/prob/scorer';
import { same } from '../../helpers/assert';
import { columnOf } from '../../helpers/gen-problem';
import { genRangedProblem, lineIdOf, type RangedProblem } from '../../helpers/gen-ranged-problem';
import { motivatingContext, motivatingExact, motivatingTemplate } from '../../helpers/motivating';
import {
  type Big,
  blendBig,
  compareBig,
  compareVectors,
  type NaiveRatio,
  naiveRanking,
  naiveRatios,
  ratiosBehind,
  subtractBig,
} from '../../helpers/opt-oracle';
import { seededRng } from '../../helpers/prng';
import { problemFromMatrix } from '../../helpers/problem-from-matrix';

type Compiled = Extract<CompileResult, { ok: true }>;
type Finished = Extract<OptimizeResult, { status: 'done' | 'cancelled' }>;

/** A fixed cost, so that no test depends on how fast the machine is. */
const COST = { perVectorUs: 0.05, perTermNs: 6 };

function compiled(input: CompileInput, handSizes?: HandSize[]): Compiled {
  const result = compileProblem(input, handSizes === undefined ? {} : { handSizes });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result;
}

function finished(result: OptimizeResult): Finished {
  if (result.status !== 'done' && result.status !== 'cancelled')
    throw new Error(`the run did not finish: ${JSON.stringify(result)}`);
  return result;
}

const run = (c: Compiled, opts: OptimizeOptions = {}): Finished =>
  finished(optimize(c, { cost: COST, ...opts }));

// ---------------------------------------------------------------------------
// Generated templates (oracle O1): gen-ranged-problem's, in the variants the
// optimizer must survive.
// ---------------------------------------------------------------------------

const TEMPLATES = 420;

interface Case {
  ranged: Pick<RangedProblem, 'generated' | 'ranges' | 'remainder'>;
  input: CompileInput;
  handSizes: HandSize[];
  kind: 'plain' | 'single-vector' | 'infeasible';
}

function withRanges(
  ranged: RangedProblem,
  ranges: RangedProblem['ranges'],
  remainder: RangedProblem['remainder'],
): Pick<Case, 'ranged' | 'input'> {
  const lines = [
    ...ranges.map(({ min, max }, line) => ({ id: lineIdOf(line), isRemainder: false, min, max })),
    { id: REMAINDER_ID, isRemainder: true, ...remainder },
  ];
  return {
    ranged: { generated: ranged.generated, ranges, remainder },
    input: { ...ranged.input, lines },
  };
}

function genCase(index: number): Case {
  const rng = seededRng(71_000 + index);
  const ranged = genRangedProblem(rng);
  const H = ranged.generated.handSize;
  // A first/second blend: the criteria were expanded for the LARGER hand (TDD §8).
  const handSizes: HandSize[] =
    index % 3 === 0
      ? [
          { H: H - 1, weight: rng.pick([1, 3, 2, 1]) },
          { H, weight: rng.pick([1, 2, 3, 4]) },
        ]
      : [{ H, weight: 1 }];
  if (index % 12 === 5) {
    // Every line pinned, the remainder open: one raw ratio, one vector.
    const pinned = ranged.ranges.map(({ min }) => ({ min, max: min }));
    return {
      ...withRanges(ranged, pinned, { min: 0, max: null }),
      handSizes,
      kind: 'single-vector',
    };
  }
  if (index % 12 === 9)
    return {
      ...withRanges(ranged, ranged.ranges, { min: ranged.input.deckSize + 1, max: null }),
      handSizes,
      kind: 'infeasible',
    };
  return { ranged, input: ranged.input, handSizes, kind: 'plain' };
}

const bigOf = ({ score }: Pick<ScoredVector, 'score'>): Big => blendBig(score.parts);

/** `best − score <= delta`, in BigInt rationals. */
const within = (best: Big, score: Big, delta: Rational): boolean =>
  compareBig(subtractBig(best, score), { num: BigInt(delta.num), den: BigInt(delta.den) }) <= 0;

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** A delta that lands EXACTLY on the gap between the best and some other score — the `<=` boundary. */
function boundaryDelta(ratios: readonly NaiveRatio[], pick: number): Rational | null {
  const ranking = naiveRanking(ratios);
  const others = ranking.filter((group) => compareBig(group.score, ranking[0]!.score) !== 0);
  if (others.length === 0) return null;
  const gap = subtractBig(ranking[0]!.score, others[pick % others.length]!.score);
  const shared = gcd(gap.num, gap.den);
  return { num: Number(gap.num / shared), den: Number(gap.den / shared) };
}

interface Compared {
  vectors: number;
  ratios: number;
  cells: number;
  plateauBoundary: number;
  /** Irrelevant lines that are not flat — and those among them that are not the remainder. */
  crowded: number;
  crowdedLines: number;
}

/**
 * Everything a finished or cancelled run reports, against the naive ratios
 * BEHIND THE VECTORS IT SCORED: for a whole run, all of them.
 */
function expectMatchesNaive(
  result: Finished,
  c: Compiled,
  input: CompileInput,
  ratios: readonly NaiveRatio[],
  opts: { topK: number; delta: Rational; plateauCap: number; whole: boolean },
  tally: Compared,
): void {
  const context = () => ({ input, opts });
  const ranking = naiveRanking(ratios);
  same(result.done, ranking.length, context);
  tally.vectors += ranking.length;
  tally.ratios += ratios.length;

  // --- the best, and the raw ratios that achieve it --------------------------------------
  const best = ranking[0]!;
  same(compareBig(bigOf(result.best), best.score), 0, context);
  expect(result.best).toEqual(result.ranked[0]);
  // The blend as one fraction is the same exact number as its parts.
  for (const entry of result.ranked) {
    const blend = { num: BigInt(entry.blend.num), den: BigInt(entry.blend.den) };
    same(compareBig(blend, bigOf(entry)), 0, context);
    const display = entry.score.parts.reduce((sum, p) => sum + (p.weight * p.num) / p.den, 0);
    const weight = entry.score.parts.reduce((sum, p) => sum + p.weight, 0);
    expect(entry.score.pDisplay).toBeCloseTo(display / weight, 12);
  }
  if (opts.topK >= ranking.length) {
    const winners = result.ranked.filter((entry) => compareBig(bigOf(entry), best.score) === 0);
    const expanded = new Set(winners.flatMap((entry) => [...ratiosBehind(c, entry.classTotals)]));
    const naiveWinners = ratios
      .filter((ratio) => compareBig(ratio.score, best.score) === 0)
      .map((ratio) => ratio.counts.join(','));
    expect([...expanded].sort()).toEqual([...naiveWinners].sort());
  }

  // --- the ranked table: the naive ranking grouped by class vector, scores and ties ------
  const top = ranking.slice(0, opts.topK);
  expect(result.ranked.map((entry) => entry.classTotals)).toEqual(top.map((g) => g.classTotals));
  result.ranked.forEach((entry, at) => {
    expect(entry.score.parts).toEqual(top[at]!.parts);
    same(entry.rawRatios, top[at]!.ratios.length, context);
  });
  if (opts.topK >= ranking.length) {
    const sum = result.ranked.reduce((total, entry) => total + (entry.rawRatios as number), 0);
    same(sum, ratios.length, context);
  }

  // --- the plateau ----------------------------------------------------------------------
  const plateau = ranking.filter((group) => within(best.score, group.score, opts.delta));
  if (
    plateau.some(
      (group) =>
        compareBig(subtractBig(best.score, group.score), {
          num: BigInt(opts.delta.num),
          den: BigInt(opts.delta.den),
        }) === 0 && opts.delta.num > 0,
    )
  )
    tally.plateauBoundary++;
  const keptPlateau = plateau.slice(0, opts.plateauCap);
  expect(result.plateau.delta).toEqual(opts.delta);
  same(result.plateau.size, plateau.length, context);
  same(result.plateau.sizeExact, true, context);
  same(result.plateau.truncated, plateau.length > opts.plateauCap, context);
  expect(result.plateau.vectors.map((entry) => entry.classTotals)).toEqual(
    keptPlateau.map((group) => group.classTotals),
  );
  result.plateau.vectors.forEach((entry, at) => {
    expect(entry.score.parts).toEqual(keptPlateau[at]!.parts);
    same(entry.rawRatios, keptPlateau[at]!.ratios.length, context);
  });
  same(
    result.plateau.rawRatios,
    keptPlateau.reduce((sum, group) => sum + group.ratios.length, 0),
    context,
  );
  // The counts each line takes across the (kept) plateau.
  expect(result.plateau.lines).toEqual(
    input.lines.map(({ id }, line) => ({
      lineId: id,
      counts: [
        ...new Set(keptPlateau.flatMap((group) => group.ratios.map((r) => r.counts[line]!))),
      ].sort((a, b) => a - b),
    })),
  );

  // --- the sweeps: best[line][count], every line at once ----------------------------------
  const cellsOf = new Map<string, Map<number, { count: number; best: ScoredVector }>>();
  for (const sweep of result.sweeps)
    cellsOf.set(sweep.lineId, new Map(sweep.cells.map((cell) => [cell.count, cell])));
  const irrelevant = new Map(result.irrelevant.map((line) => [line.lineId, line]));
  same(cellsOf.size + irrelevant.size, input.lines.length, context);
  input.lines.forEach(({ id }, line) => {
    const naiveCells = new Map<number, Big>();
    for (const ratio of ratios) {
      const count = ratio.counts[line]!;
      const seen = naiveCells.get(count);
      if (seen === undefined || compareBig(ratio.score, seen) > 0)
        naiveCells.set(count, ratio.score);
    }
    const counts = [...naiveCells.keys()].sort((a, b) => a - b);
    tally.cells += counts.length;
    const blank = c.classOfLine[line] === 0;
    same(irrelevant.has(id), blank, () => ({ ...context(), id }));
    same(cellsOf.has(id), !blank, () => ({ ...context(), id }));

    let cells = cellsOf.get(id);
    const idle = irrelevant.get(id);
    if (idle !== undefined) {
      const flat = counts.every((count) => compareBig(naiveCells.get(count)!, best.score) === 0);
      same(idle.flat, flat, () => ({ ...context(), id }));
      expect([idle.min, idle.max]).toEqual([counts[0], counts.at(-1)]);
      // Over a whole run the counts a line takes have no gaps; over a prefix of one they may.
      if (opts.whole) same(counts.length, idle.max - idle.min + 1, context);
      same(compareBig(bigOf(idle.best), best.score), 0, context);
      // Flat — every count ties for the best — is said in one line, never as a table.
      same(idle.cells === undefined, flat, () => ({ ...context(), id }));
      if (!flat) tally.crowded++;
      if (!flat && id !== REMAINDER_ID) tally.crowdedLines++;
      cells = new Map((idle.cells ?? []).map((cell) => [cell.count, cell]));
      if (flat) return;
    }
    // Cells for impossible counts are absent; the others hold the naive maximum.
    expect([...cells!.keys()]).toEqual(counts);
    for (const count of counts) {
      const cell = cells!.get(count)!;
      same(compareBig(bigOf(cell.best), naiveCells.get(count)!), 0, () => ({
        ...context(),
        id,
        count,
      }));
      // The witness is a deck that does it: a scored vector, with a raw ratio holding the line at this count.
      const behind = [...ratiosBehind(c, cell.best.classTotals)].map((key) => key.split(','));
      if (!behind.some((counted) => Number(counted[line]) === count))
        throw new Error(`the witness of ${id} = ${count} cannot hold it: ${JSON.stringify(cell)}`);
      const group = ranking.find((g) => compareVectors(g.classTotals, cell.best.classTotals) === 0);
      if (group === undefined) throw new Error(`the witness of ${id} = ${count} was never scored`);
      expect(cell.best.score.parts).toEqual(group.parts);
    }
    if (idle === undefined) {
      const sweep = result.sweeps.find((s) => s.lineId === id)!;
      same(sweep.cls, c.classOfLine[line], context);
      expect(sweep.argmax).toEqual(
        counts.filter((count) => compareBig(naiveCells.get(count)!, best.score) === 0),
      );
    }
  });
}

const newTally = (): Compared => ({
  vectors: 0,
  ratios: 0,
  cells: 0,
  plateauBoundary: 0,
  crowded: 0,
  crowdedLines: 0,
});

const DELTAS: Rational[] = [
  { num: 0, den: 1 },
  { num: 1, den: 200 },
  { num: 1, den: 20 },
  { num: 1, den: 3 },
  { num: 1, den: 1 },
];

// ---------------------------------------------------------------------------
// A compiled problem small enough to read: three named classes and a blank.
// ---------------------------------------------------------------------------

/** Lines a 0–3, b 0–3, junk 0–2 (blank, with the remainder); success is `1x a, 1x b`. 16 vectors. */
function smallInput(overrides: Partial<CompileInput> = {}): CompileInput {
  return {
    deckSize: 40,
    handSize: 5,
    lines: [
      { id: 'a', isRemainder: false, min: 0, max: 3 },
      { id: 'b', isRemainder: false, min: 0, max: 3 },
      { id: 'junk', isRemainder: false, min: 0, max: 2 },
      { id: REMAINDER_ID, isRemainder: true, min: 0, max: null },
    ],
    matrix: [
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ],
    flat: [
      {
        reqs: [
          { n: 1, desc: 0 },
          { n: 1, desc: 1 },
        ],
        limits: [],
      },
    ],
    ...overrides,
  };
}

/** A clock that moves `stepMs` each time it is read. */
function steppingClock(stepMs: number) {
  let at = 1_000;
  return () => {
    at += stepMs;
    return at;
  };
}

describe('optimize', () => {
  describe('the result', () => {
    it('ranks the 16 vectors of a small problem, best first, by exact fraction', () => {
      const result = run(compiled(smallInput()));
      expect(result.status).toBe('done');
      expect(result.partial).toBe(false);
      expect([result.done, result.total]).toEqual([16, 16]);
      expect(result.rawRatios).toBe(48);
      expect(result.best.classTotals).toEqual([34, 3, 3]);
      // P(an a and a b in 5 of 40) at 3 and 3: 1 − 2·C(37,5)/C(40,5) + C(34,5)/C(40,5).
      expect(result.best.score.parts).toEqual([
        { H: 5, weight: 1, num: 658008 - 2 * 435897 + 278256, den: 658008 },
      ]);
      expect(result.best.blend).toEqual({ num: 64470, den: 658008 });
      expect(result.best.rawRatios).toBe(3);
      expect(result.ranked).toHaveLength(16);
      // The seven vectors without an `a` or without a `b` score 0 and tie: lexicographic, blank first.
      expect(result.ranked.slice(-7).map((entry) => entry.classTotals)).toEqual([
        [37, 0, 3],
        [37, 3, 0],
        [38, 0, 2],
        [38, 2, 0],
        [39, 0, 1],
        [39, 1, 0],
        [40, 0, 0],
      ]);
    });

    it('keeps only the top K of the ranked table', () => {
      const all = run(compiled(smallInput()));
      const top = run(compiled(smallInput()), { topK: 5 });
      expect(top.ranked).toEqual(all.ranked.slice(0, 5));
      expect(top.done).toBe(16);
    });

    it('reports a line of the blank class as irrelevant, in one line and without a table', () => {
      const result = run(compiled(smallInput()));
      expect(result.sweeps.map((sweep) => sweep.lineId)).toEqual(['a', 'b']);
      const { classTotals, score, blend } = result.best;
      const best = { classTotals, score, blend };
      const [junk, remainder] = result.irrelevant;
      expect(junk).toEqual({ lineId: 'junk', flat: true, min: 0, max: 2, best });
      // The remainder matches nothing either, but it is what every other card trades WITH: past
      // the 34 that the best deck leaves, each one is an `a` or a `b` fewer.
      expect(remainder).toMatchObject({
        lineId: REMAINDER_ID,
        flat: false,
        min: 32,
        max: 40,
        best,
      });
      const p = remainder!.cells!.map((cell) => cell.best.blend.num);
      expect(remainder!.cells!.map((cell) => cell.count)).toEqual([
        32, 33, 34, 35, 36, 37, 38, 39, 40,
      ]);
      expect(p.slice(0, 3)).toEqual([64470, 64470, 64470]);
      for (let at = 3; at < p.length - 1; at++) expect(p[at]).toBeLessThan(p[at - 1]!);
      // 39 or 40 unspecified cards leave no room for an `a` AND a `b`.
      expect(p.slice(-2)).toEqual([0, 0]);
    });

    it('gives an irrelevant line a table after all when its copies crowd out cards that matter', () => {
      // No remainder to trade with: every `junk` is one card fewer of the 40 that could matter.
      const input = smallInput({
        lines: [
          { id: 'a', isRemainder: false, min: 0, max: 30 },
          { id: 'b', isRemainder: false, min: 0, max: 30 },
          { id: 'junk', isRemainder: false, min: 0, max: 2 },
          { id: REMAINDER_ID, isRemainder: true, min: 0, max: 0 },
        ],
      });
      const result = run(compiled(input));
      const junk = result.irrelevant.find((line) => line.lineId === 'junk')!;
      expect(junk.flat).toBe(false);
      expect(junk.cells!.map((cell) => cell.count)).toEqual([0, 1, 2]);
      const p = junk.cells!.map((cell) => cell.best.score.pDisplay);
      expect(p[0]).toBeGreaterThan(p[1]!);
      expect(p[1]).toBeGreaterThan(p[2]!);
    });
  });

  describe('statuses', () => {
    it('is `infeasible`, scoring nothing, when no vector fills the deck', () => {
      const input = smallInput({
        lines: smallInput().lines.map((line) =>
          line.isRemainder ? { ...line, min: 41, max: null } : line,
        ),
      });
      const result = optimize(compiled(input), { cost: COST });
      expect(result).toMatchObject({ status: 'infeasible', total: 0 });
    });

    it('is `error`, never a throw, for options that make no sense', () => {
      const c = compiled(smallInput());
      for (const opts of [
        { topK: 0 },
        { topK: 2.5 },
        { plateauCap: 0 },
        { plateauDelta: { num: -1, den: 200 } },
        { plateauDelta: { num: 1, den: 0 } },
        { plateauDelta: { num: 0.5, den: 100 } },
        { progressIntervalMs: -1 },
        { checkEvery: 0 },
      ] satisfies OptimizeOptions[]) {
        const result = optimize(c, { cost: COST, ...opts });
        expect(result.status).toBe('error');
        if (result.status === 'error') expect(result.message).not.toBe('');
      }
    });

    it('is `error` when the weights are too large to rank in exact integers', () => {
      const c = compiled(smallInput({ handSize: 6 }), [
        { H: 5, weight: 2 ** 40 },
        { H: 6, weight: 1 },
      ]);
      const result = optimize(c, { cost: COST });
      expect(result).toMatchObject({ status: 'error' });
    });
  });

  describe('the wall (TDD §11.3)', () => {
    // 1 ms a vector and nothing per term: the estimate for 16 vectors is exactly 16 ms.
    const slow = { perVectorUs: 1000, perTermNs: 0 };

    it('asks for confirmation, scoring nothing, when the estimate is over the threshold', () => {
      const result = optimize(compiled(smallInput()), { cost: slow, confirmThresholdMs: 15 });
      expect(result).toMatchObject({
        status: 'needs-confirmation',
        reason: 'estimate',
        total: 16,
        estimatedMs: 16,
        thresholdMs: 15,
      });
    });

    it('runs when the estimate is AT the threshold, not over it', () => {
      const result = optimize(compiled(smallInput()), { cost: slow, confirmThresholdMs: 16 });
      expect(result.status).toBe('done');
    });

    it('defaults to a threshold of 60 s', () => {
      const c = compiled(smallInput());
      const over = optimize(c, { cost: { perVectorUs: 3_750_001, perTermNs: 0 } });
      expect(over).toMatchObject({ status: 'needs-confirmation', thresholdMs: 60_000 });
      expect(optimize(c, { cost: { perVectorUs: 3_750_000, perTermNs: 0 } }).status).toBe('done');
    });

    it('counts the terms of every hand size in the estimate', () => {
      const c = compiled(smallInput({ handSize: 6 }), [
        { H: 5, weight: 1 },
        { H: 6, weight: 1 },
      ]);
      const terms = c.problem.handSizes.map(({ H }) => createScorer(c.problem, H).terms);
      const result = optimize(c, {
        cost: { perVectorUs: 0, perTermNs: 1e6 },
        confirmThresholdMs: 1,
      });
      // 1 ms a term: 16 vectors × the terms of both hands.
      expect(result).toMatchObject({
        status: 'needs-confirmation',
        estimatedMs: 16 * (terms[0]! + terms[1]!),
      });
    });

    it('`force` runs it anyway', () => {
      const result = optimize(compiled(smallInput()), {
        cost: slow,
        confirmThresholdMs: 15,
        force: true,
      });
      expect(result).toMatchObject({ status: 'done', done: 16, estimatedMs: 16 });
    });

    it('calibrates the cost itself when none is injected', () => {
      const result = finished(optimize(compiled(smallInput())));
      expect(result.cost.perTermNs).toBeGreaterThan(0);
    });

    describe('a vector count past 2^53', () => {
      // 29 lines of 0–3 copies that the criteria tell apart: about 4^29 class vectors.
      const lines = Array.from({ length: 29 }, (_, line) => ({
        id: `l${line}`,
        isRemainder: false,
        min: 0,
        max: 3,
      }));
      const wide: CompileInput = {
        deckSize: 60,
        handSize: 1,
        lines: [...lines, { id: REMAINDER_ID, isRemainder: true, min: 0, max: null }],
        matrix: [
          ...lines.map((_, line) => lines.map((__, desc) => desc === line)),
          lines.map(() => false),
        ],
        flat: [{ reqs: [{ n: 1, desc: 0 }], limits: [] }],
      };
      // A cost of nothing: the ESTIMATE is 0 ms, so only the count can stop this run.
      const free = { perVectorUs: 0, perTermNs: 0 };

      it('is refused without `force`, with a message that says why', () => {
        // Should it start after all, it stops at once: a failure here is a status, not a hang.
        const result = optimize(compiled(wide), {
          cost: free,
          checkEvery: 1,
          progressIntervalMs: 0,
          shouldCancel: () => true,
        });
        expect(result).toMatchObject({ status: 'needs-confirmation', reason: 'unsafe-count' });
        if (result.status !== 'needs-confirmation') return;
        expect(typeof result.total).toBe('string');
        expect(BigInt(result.total)).toBeGreaterThan(2n ** 53n);
        expect(result.message).toMatch(/2\^53/);
        expect(result.message).toMatch(/force/);
      });

      it('starts with `force`, carrying the total as exact digits', () => {
        const seen: OptimizeProgress[] = [];
        const result = run(compiled(wide), {
          cost: free,
          force: true,
          checkEvery: 1,
          progressIntervalMs: 0,
          onProgress: (progress) => {
            // Should the cancellation be ignored, the run ends in an error, not in 4^29 vectors.
            if (seen.push(progress) > 3) throw new Error('the run was not cancelled');
          },
          shouldCancel: () => true,
        });
        expect(result).toMatchObject({ status: 'cancelled', partial: true, done: 1 });
        expect(typeof result.total).toBe('string');
        expect(seen[0]).toMatchObject({ done: 1, total: result.total });
        expect(Number.isFinite(seen[0]!.etaMs)).toBe(true);
      });
    });
  });

  describe('progress (TDD §11.3)', () => {
    it('reports monotone `done` of an exact `total`, throttled, and ends at done === total', () => {
      const seen: OptimizeProgress[] = [];
      const result = run(compiled(smallInput()), {
        now: steppingClock(25),
        checkEvery: 1,
        progressIntervalMs: 100,
        onProgress: (progress) => seen.push(progress),
      });
      expect(result.done).toBe(16);
      // The clock is read once at the start and once per vector, 25 ms apart: a report every
      // fourth vector — exactly the 100 ms interval since the last — and the closing one.
      expect(seen.map((progress) => progress.done)).toEqual([4, 8, 12, 16, 16]);
      expect(seen.every((progress) => progress.total === 16)).toBe(true);
      expect(seen[0]).toEqual({ done: 4, total: 16, elapsedMs: 100, etaMs: 300 });
      expect(seen.at(-1)).toMatchObject({ done: 16, total: 16, etaMs: 0 });
      for (let at = 1; at < seen.length; at++) {
        expect(seen[at]!.done).toBeGreaterThanOrEqual(seen[at - 1]!.done);
        expect(seen[at]!.elapsedMs).toBeGreaterThan(seen[at - 1]!.elapsedMs);
      }
    });

    it('reads the clock only every `checkEvery` vectors', () => {
      let reads = 0;
      run(compiled(smallInput()), {
        now: () => reads++,
        checkEvery: 5,
        progressIntervalMs: 0,
      });
      // The start, vectors 5, 10 and 15, and the end.
      expect(reads).toBe(5);
    });

    it('reports nothing between the start and the end when the run is faster than the interval', () => {
      const seen: OptimizeProgress[] = [];
      run(compiled(smallInput()), {
        now: steppingClock(1),
        checkEvery: 1,
        onProgress: (progress) => seen.push(progress),
      });
      expect(seen.map((progress) => progress.done)).toEqual([16]);
    });
  });

  describe('cancellation', () => {
    it('is asked at the cadence of progress, not once per vector', () => {
      let asked = 0;
      run(compiled(smallInput()), {
        now: steppingClock(30),
        checkEvery: 1,
        progressIntervalMs: 100,
        shouldCancel: () => {
          asked++;
          return false;
        },
      });
      expect(asked).toBe(4);
    });

    it('returns what it has, marked partial, and never reports done === total', () => {
      const seen: OptimizeProgress[] = [];
      let asked = 0;
      const result = run(compiled(smallInput()), {
        checkEvery: 1,
        progressIntervalMs: 0,
        onProgress: (progress) => seen.push(progress),
        shouldCancel: () => ++asked === 6,
      });
      expect(result).toMatchObject({ status: 'cancelled', partial: true, done: 6, total: 16 });
      expect(seen.map((progress) => progress.done)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
});

describe('sweepFixed', () => {
  it('scores each count of one line, the remainder absorbing the difference', () => {
    const c = compiled(smallInput());
    const cells = sweepFixed(c, [3, 1, 2], 'b');
    expect(cells.map((cell) => [cell.count, cell.remainder, cell.feasible])).toEqual([
      [0, 35, true],
      [1, 34, true],
      [2, 33, true],
      [3, 32, true],
    ]);
    const scorer = createScorer(c.problem, 5);
    cells.forEach((cell) => {
      if (!cell.feasible) throw new Error('feasible');
      expect(cell.best.classTotals).toEqual([cell.remainder + 2, 3, cell.count]);
      expect(cell.best.score.parts[0]).toMatchObject(scorer.score(cell.best.classTotals));
    });
  });

  it('marks a count infeasible when the remainder would leave its range', () => {
    const input = smallInput({
      lines: smallInput().lines.map((line) =>
        line.isRemainder ? { ...line, min: 33, max: 34 } : line,
      ),
    });
    const cells = sweepFixed(compiled(input), [3, 1, 2], 'b');
    expect(cells.map((cell) => [cell.count, cell.remainder, cell.feasible])).toEqual([
      [0, 35, false],
      [1, 34, true],
      [2, 33, true],
      [3, 32, false],
    ]);
  });

  it('rejects a base ratio that is not one, a line it does not have, and the remainder', () => {
    const c = compiled(smallInput());
    expect(() => sweepFixed(c, [3, 1], 'b')).toThrow(/3 lines/);
    expect(() => sweepFixed(c, [3, 4, 2], 'a')).toThrow(/"b"/);
    expect(() => sweepFixed(c, [3, 1, 2], 'nope')).toThrow(/no line "nope"/);
    expect(() => sweepFixed(c, [3, 1, 2], REMAINDER_ID)).toThrow(/remainder/);
  });
});

describe('exampleRatio', () => {
  it('fills each class from its first line on, every line within its range', () => {
    const input = smallInput({
      lines: [
        { id: 'a', isRemainder: false, min: 1, max: 3 },
        { id: 'a2', isRemainder: false, min: 0, max: 3 },
        { id: 'junk', isRemainder: false, min: 2, max: 9 },
        { id: REMAINDER_ID, isRemainder: true, min: 0, max: null },
      ],
      matrix: [[true], [true], [false], [false]],
      flat: [{ reqs: [{ n: 1, desc: 0 }], limits: [] }],
    });
    // Blank 36 = junk + remainder; a + a2 = 4.
    expect(exampleRatio(compiled(input), [36, 4])).toEqual([3, 1, 9, 27]);
  });

  it('is one of the raw ratios behind the vector, for every vector of the generated templates', () => {
    for (let index = 0; index < 60; index++) {
      const { input, handSizes, kind } = genCase(index);
      if (kind === 'infeasible') continue;
      const c = compiled(input, handSizes);
      for (const { classTotals } of run(c).ranked)
        if (!ratiosBehind(c, classTotals).has(exampleRatio(c, classTotals).join(',')))
          throw new Error(`not behind ${classTotals}: ${JSON.stringify(input)}`);
    }
  });

  it('rejects totals no split of the lines can reach', () => {
    expect(() => exampleRatio(compiled(smallInput()), [36, 4, 0])).toThrow(RangeError);
  });
});

describe('breakdown', () => {
  it('scores each TEMPLATE criterion by itself — several flat alternatives included', () => {
    let alternatives = 0;
    let criteria = 0;
    for (let index = 0; index < 120; index++) {
      const { ranged, input, handSizes, kind } = genCase(index);
      if (kind === 'infeasible') continue;
      const { generated } = ranged;
      const c = compiled(input, handSizes);
      const H = input.handSize;
      // Each criterion as written, expanded by itself — as `resolveTemplate` keeps it.
      const template = generated.exprs.map((expr, at) => {
        const expanded = expand(expr, { maxHandSize: H });
        if (!expanded.ok) throw new Error(expanded.message);
        // A ceiling is carried through: dropping one here would judge the
        // criterion alone by something other than what it says.
        const index = (side: (typeof expanded.flat)[0]['reqs']) =>
          side.map(({ n, max, desc }) => {
            const at = columnOf(desc);
            return max === undefined ? { n, desc: at } : { n, max, desc: at };
          });
        return {
          id: `c${at}`,
          alternatives: expanded.flat.map((f) => ({
            reqs: index(f.reqs),
            limits: index(f.limits),
          })),
        };
      });
      const { classTotals } = run(c).best;
      const counts = exampleRatio(c, classTotals).slice(0, -1);
      const rows = breakdown(c, template, classTotals);
      expect(rows.map((row) => row.id)).toEqual(template.map((criterion) => criterion.id));
      template.forEach((criterion, at) => {
        // The oracle: the UNMERGED problem whose only criteria are this one's alternatives.
        const alone = problemFromMatrix(
          { ...generated.problem, flat: criterion.alternatives },
          handSizes.map((hand) => hand.H),
        );
        const parts = handSizes.map(({ H: hand, weight }) => ({
          H: hand,
          weight,
          ...createScorer(alone.problem, hand).score(alone.totals(counts)),
        }));
        expect(rows[at]!.score.parts).toEqual(parts);
        same(compareBig(bigOf(rows[at]!), blendBig(parts)), 0, () => ({ input, at }));
        alternatives += criterion.alternatives.length;
        criteria++;
      });
    }
    // Criteria with several alternatives are what a flat index would get wrong.
    expect(alternatives).toBeGreaterThan(criteria * 1.3);
  });

  it('scores a criterion that lost every alternative to the hand size as 0', () => {
    const c = compiled(smallInput());
    const [row] = breakdown(c, [{ id: 'never', alternatives: [] }], [34, 3, 3]);
    expect(row!.score.parts).toEqual([{ H: 5, weight: 1, num: 0, den: 658008 }]);
  });
});

describe('the optimizer against scoring every raw ratio (oracle O1)', () => {
  it('finds the same best, ranking, plateau and sweep tables as the naive search', () => {
    const tally = newTally();
    const kinds = { plain: 0, 'single-vector': 0, infeasible: 0 };
    let blends = 0;
    let merged = 0;
    let remainderClass = 0;
    let emptyBlank = 0;
    for (let index = 0; index < TEMPLATES; index++) {
      const { ranged, input, handSizes, kind } = genCase(index);
      kinds[kind]++;
      const c = compiled(input, handSizes);
      if (kind === 'infeasible') {
        expect(optimize(c, { cost: COST })).toMatchObject({ status: 'infeasible', total: 0 });
        continue;
      }
      if (handSizes.length > 1) blends++;
      if (c.classes.slice(1).some((cls) => cls.lines.length > 1)) merged++;
      if (c.classOfLine.at(-1) !== 0) remainderClass++;
      if (c.classes[0]!.lines.length === 0) emptyBlank++;

      const ratios = naiveRatios(ranged, input, c, handSizes);
      const delta =
        (index % 2 === 1 ? boundaryDelta(ratios, index) : null) ?? DELTAS[index % DELTAS.length]!;
      const opts = { topK: 1000, delta, plateauCap: 1000, whole: true };
      const result = run(c, { topK: opts.topK, plateauDelta: delta, plateauCap: opts.plateauCap });
      same(result.status, 'done', () => input);
      same(result.total, result.done, () => input);
      same(result.rawRatios, ratios.length, () => input);
      if (kind === 'single-vector') same(result.done, 1, () => input);
      expectMatchesNaive(result, c, input, ratios, opts, tally);
    }
    console.info(
      `O1: ${TEMPLATES} templates (${kinds.infeasible} infeasible, ${kinds['single-vector']} single-vector, ` +
        `${blends} blends, ${merged} with merged classes, ${remainderClass} with the remainder a class, ` +
        `${emptyBlank} with an empty blank), ${tally.vectors} vectors, ${tally.ratios} raw ratios, ` +
        `${tally.cells} sweep cells, ${tally.plateauBoundary} plateaus with a vector exactly at delta, ` +
        `${tally.crowded} irrelevant lines that are not flat (${tally.crowdedLines} of them not the remainder)`,
    );
    expect(kinds.infeasible).toBeGreaterThanOrEqual(15);
    expect(kinds['single-vector']).toBeGreaterThanOrEqual(15);
    expect(blends).toBeGreaterThanOrEqual(60);
    expect(merged).toBeGreaterThanOrEqual(60);
    expect(remainderClass).toBeGreaterThanOrEqual(30);
    expect(emptyBlank).toBeGreaterThanOrEqual(20);
    expect(tally.ratios).toBeGreaterThanOrEqual(5_000);
    expect(tally.cells).toBeGreaterThanOrEqual(2_000);
    expect(tally.plateauBoundary).toBeGreaterThanOrEqual(30);
    expect(tally.crowded).toBeGreaterThanOrEqual(10);
    expect(tally.crowdedLines).toBeGreaterThanOrEqual(5);
  });

  it('bounds the table and the plateau exactly as the naive ranking is cut', () => {
    const tally = newTally();
    let truncated = 0;
    for (let index = 0; index < TEMPLATES; index += 2) {
      const { ranged, input, handSizes, kind } = genCase(index);
      if (kind === 'infeasible') continue;
      const c = compiled(input, handSizes);
      const ratios = naiveRatios(ranged, input, c, handSizes);
      const opts = {
        topK: 1 + (index % 7),
        delta: { num: 1, den: 4 },
        plateauCap: 1 + (index % 5),
        whole: true,
      };
      const result = run(c, {
        topK: opts.topK,
        plateauDelta: opts.delta,
        plateauCap: opts.plateauCap,
      });
      if (result.plateau.truncated) truncated++;
      expectMatchesNaive(result, c, input, ratios, opts, tally);
    }
    expect(truncated).toBeGreaterThanOrEqual(40);
  });

  it('a cancelled run reports exactly the naive search over the vectors it scored (oracle O5)', () => {
    const tally = newTally();
    let cancelled = 0;
    for (let index = 0; index < TEMPLATES; index += 3) {
      const { ranged, input, handSizes, kind } = genCase(index);
      if (kind !== 'plain') continue;
      const c = compiled(input, handSizes);
      const walk: string[] = [];
      walkVectors(c.problem.classes, input.deckSize, (totals) => {
        walk.push(totals.join(','));
        return true;
      });
      if (walk.length < 2) continue;
      const stopAfter = 1 + (index % (walk.length - 1));
      let asked = 0;
      const delta = DELTAS[index % DELTAS.length]!;
      const result = run(c, {
        topK: 1000,
        plateauDelta: delta,
        plateauCap: 1000,
        checkEvery: 1,
        progressIntervalMs: 0,
        shouldCancel: () => ++asked === stopAfter,
      });
      expect(result).toMatchObject({ status: 'cancelled', partial: true, done: stopAfter });
      same(result.total, walk.length, () => input);
      const prefix = new Set(walk.slice(0, stopAfter));
      const scored = naiveRatios(ranged, input, c, handSizes).filter((ratio) =>
        prefix.has(ratio.classTotals.join(',')),
      );
      expectMatchesNaive(
        result,
        c,
        input,
        scored,
        { topK: 1000, delta, plateauCap: 1000, whole: false },
        tally,
      );
      cancelled++;
    }
    expect(cancelled).toBeGreaterThanOrEqual(50);
  });
});

describe('the motivating example (oracle O4, TDD §11.1)', async () => {
  const ctx = motivatingContext(await initSqlJs());

  function compiledAt(hand: number, handSizes?: HandSize[]): Compiled {
    const resolved = resolveTemplate({ ...motivatingTemplate(), hand: { size: hand } }, ctx);
    if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
    return compiled(resolved.resolved, handSizes);
  }

  /**
   * The optimum by a route that shares nothing with `src/`: the criteria tell
   * five kinds of card apart — A, B, `level 4 monster`, the other known
   * monsters (`monster` + `fire-bw`), and everything else — so every
   * choice of the four that matter is scored by `motivatingExact`'s
   * hypergeometric sums over hand compositions.
   */
  function bruteForce(hands: readonly { H: number; weight: number }[]) {
    const rows: { a: number; b: number; level4: number; others: number; score: Big }[] = [];
    for (let a = 0; a <= 3; a++)
      for (let b = 0; b <= 3; b++)
        for (let level4 = 2; level4 <= 3; level4++)
          for (let others = 5; others <= 8; others++) {
            const parts = hands.map(({ H, weight }) => {
              const exact = motivatingExact([a, b, 5, level4, others - 5, 0, 0], 40, H);
              return { weight, num: exact.successes, den: exact.hands };
            });
            rows.push({ a, b, level4, others, score: blendBig(parts) });
          }
    return rows;
  }

  const maxOf = (scores: readonly Big[]): Big =>
    scores.reduce((best, score) => (compareBig(score, best) > 0 ? score : best));

  it('scores 128 vectors and finds A 3, B 3, level4 3 and eight other monsters: 46,185 / 658,008', () => {
    const c = compiledAt(5);
    const result = run(c);
    expect([result.status, result.done, result.total]).toEqual(['done', 128, 128]);
    expect(result.rawRatios).toBe(4096);

    const rows = bruteForce([{ H: 5, weight: 1 }]);
    expect(rows).toHaveLength(128);
    const best = maxOf(rows.map((row) => row.score));
    const winners = rows.filter((row) => compareBig(row.score, best) === 0);
    expect(winners.map(({ a, b, level4, others }) => [a, b, level4, others])).toEqual([
      [3, 3, 3, 8],
    ]);
    expect(best).toEqual({ num: 46185n, den: 658008n });

    // Classes: blank, A, B, {monster, fire-bw}, level4.
    expect(result.best.classTotals).toEqual([23, 3, 3, 8, 3]);
    expect(result.best.blend).toEqual({ num: 46185, den: 658008 });
    expect(result.best.score.pDisplay).toBeCloseTo(0.070189, 6);
    // `monster` is pinned at 5, so `fire-bw` is at 3; the 23 blank cards split any way.
    expect(exampleRatio(c, result.best.classTotals).slice(0, 5)).toEqual([3, 3, 5, 3, 3]);
    // Every vector's score, not only the best.
    for (const entry of result.ranked) {
      const [, a, b, others, level4] = entry.classTotals as [
        number,
        number,
        number,
        number,
        number,
      ];
      const row = rows.find(
        (r) => r.a === a && r.b === b && r.level4 === level4 && r.others === others,
      )!;
      expect(compareBig(bigOf(entry), row.score)).toBe(0);
    }
    expect(result.ranked).toHaveLength(128);
  });

  it('sweeps line A and line B: the best over everything else, per count', () => {
    const result = run(compiledAt(5));
    const rows = bruteForce([{ H: 5, weight: 1 }]);
    for (const [lineId, of] of [
      ['A', (row: (typeof rows)[0]) => row.a],
      ['B', (row: (typeof rows)[0]) => row.b],
    ] as const) {
      const sweep = result.sweeps.find((s) => s.lineId === lineId)!;
      expect(sweep.cells.map((cell) => cell.count)).toEqual([0, 1, 2, 3]);
      for (const cell of sweep.cells) {
        const expected = maxOf(rows.filter((row) => of(row) === cell.count).map((r) => r.score));
        expect(compareBig(bigOf(cell.best), expected)).toBe(0);
      }
      expect(sweep.argmax).toEqual([3]);
      // No A, or no B: no hand succeeds.
      expect(sweep.cells[0]!.best.blend.num).toBe(0);
    }
    expect(result.sweeps.map((sweep) => sweep.lineId)).toEqual([
      'A',
      'B',
      'monster',
      'level4',
      'fire-bw',
    ]);
  });

  it('reports `spell` and `normal-spell` as irrelevant and flat; the remainder only up to 23 cards', () => {
    const result = run(compiledAt(5));
    expect(result.irrelevant.map(({ lineId, flat, min, max }) => [lineId, flat, min, max])).toEqual(
      [
        ['spell', true, 0, 7],
        ['normal-spell', true, 0, 3],
        [REMAINDER_ID, false, 13, 33],
      ],
    );
    // 17 cards matter at most, so 23 are blank at best: 13 to 23 unspecified cards lose nothing
    // — `spell` and `normal-spell` make up the rest — and every one past 23 is a card that mattered.
    const cells = result.irrelevant[2]!.cells!;
    const rows = bruteForce([{ H: 5, weight: 1 }]);
    for (const { count, best } of cells) {
      // A remainder of `count` leaves 40 − count for the lines, of which at most 10 are spells.
      const expected = maxOf(
        rows
          .filter(({ a, b, level4, others }) => {
            const blank = 40 - a - b - level4 - others;
            return blank >= count && blank - count <= 10;
          })
          .map((row) => row.score),
      );
      expect(compareBig(bigOf(best), expected)).toBe(0);
    }
    expect(cells.filter(({ best }) => best.blend.num === 46185).map((c) => c.count)).toEqual([
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
  });

  it('ranks a 3 : 2 first/second blend by both hands, against the same brute force', () => {
    const hands = [
      { H: 5, weight: 3 },
      { H: 6, weight: 2 },
    ];
    const result = run(compiledAt(6, hands));
    const rows = bruteForce(hands);
    const best = maxOf(rows.map((row) => row.score));
    expect(compareBig(bigOf(result.best), best)).toBe(0);
    expect(result.best.score.parts.map(({ H, weight, den }) => [H, weight, den])).toEqual([
      [5, 3, 658008],
      [6, 2, 3838380],
    ]);
    for (const entry of result.ranked) {
      const [, a, b, others, level4] = entry.classTotals as [
        number,
        number,
        number,
        number,
        number,
      ];
      const row = rows.find(
        (r) => r.a === a && r.b === b && r.level4 === level4 && r.others === others,
      )!;
      expect(compareBig(bigOf(entry), row.score)).toBe(0);
    }
  });

  it('breaks the best ratio down by criterion: c2 is the low-Level part of c1', () => {
    const resolved = resolveTemplate(motivatingTemplate(), ctx);
    if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
    const c = compiled(resolved.resolved);
    const rows = breakdown(c, resolved.resolved.criteria, [23, 3, 3, 8, 3]);
    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ['c1', 'A, B and any monster'],
      ['c2', 'A, B and a low-Level monster'],
    ]);
    expect(rows[0]!.blend).toEqual({ num: 46185, den: 658008 });
    // c2 alone, by hand: an A, a B, and another A or a `level 4 monster` — 3 + 3 + 3 cards that matter.
    let successes = 0;
    const choose = (n: number, k: number): number =>
      k < 0 || k > n ? 0 : k === 0 ? 1 : (choose(n, k - 1) * (n - k + 1)) / k;
    for (let a = 1; a <= 3; a++)
      for (let b = 1; b <= 3; b++)
        for (let low = 0; a + b + low <= 5; low++)
          if (a - 1 + low >= 1)
            successes += choose(3, a) * choose(3, b) * choose(3, low) * choose(31, 5 - a - b - low);
    expect(rows[1]!.blend).toEqual({ num: successes, den: 658008 });
    expect(rows[1]!.blend.num).toBeLessThan(46185);
  });
});
