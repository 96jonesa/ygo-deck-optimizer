import type { CostModel } from '../model/analyze';
import {
  type CompiledClassInfo,
  type CompileResult,
  compileCriterion,
  type FlatAlternative,
  lineInterval,
  REMAINDER_ID,
} from '../model/compile';
import type { HandSize, Problem } from '../model/problem';
import { countSums } from '../model/ranges';
import {
  type BlendScore,
  type BlendScorer,
  createBlendScorer,
  type Fraction,
} from '../prob/scorer';
import { type Count, countToNumber, toCount } from '../util/count';
import { calibrateCost, estimateMs } from './calibrate';
import { countVectors, walkVectors } from './enumerate';
import { TopK } from './heap';
import { Plateau } from './plateau';

/**
 * The optimizer (TDD §11): ONE exhaustive pass over the class-total vectors
 * of a compiled template, scoring each exactly, that yields the ranked table,
 * the plateau, and the sweep of every line at once. Everything is ranked by
 * EXACT INTEGERS — the scorer's numerators, put on one common denominator for
 * a first/second blend — so there are no floats and no epsilons anywhere in
 * the search, and a tie is a true tie. TIE ORDER, in the table and wherever
 * the plateau is cut: the lexicographically smaller class vector first,
 * comparing from the blank class (index 0) — see `compareRanked`.
 *
 * The pass allocates nothing per vector: the walk writes into one array, the
 * scorer reads it, and the table, the plateau and the sweep witnesses copy it
 * into storage sized up front.
 */

/** What `compileProblem` returns for a template that compiles. */
export type Compiled = Extract<CompileResult, { ok: true }>;

/** An exact non-negative fraction of whole numbers, e.g. the plateau's width: 1/200 is half a percentage point. */
export interface Rational {
  num: number;
  den: number;
}

export const DEFAULT_TOP_K = 200;
export const DEFAULT_PLATEAU_DELTA: Rational = { num: 1, den: 200 };
export const DEFAULT_PLATEAU_CAP = 10_000;
export const DEFAULT_CONFIRM_THRESHOLD_MS = 60_000;
export const DEFAULT_PROGRESS_INTERVAL_MS = 100;

/** As `Progress` (util/progress), except that the total can pass 2^53 and is then exact digits. */
export interface OptimizeProgress {
  done: number;
  total: Count;
  elapsedMs: number;
  /** Time left at the rate so far; 0 when nothing is left. */
  etaMs: number;
}

export interface OptimizeOptions {
  /** Rows of the ranked table. Default 200. */
  topK?: number;
  /** The plateau's width as an exact fraction of 1. Default 1/200: half a percentage point. */
  plateauDelta?: Rational;
  /** The most plateau vectors kept. Default 10,000. */
  plateauCap?: number;
  /** Run even though the estimate is over the threshold, or the vector count is past 2^53. */
  force?: boolean;
  /** Default 60,000 ms. */
  confirmThresholdMs?: number;
  /** What a score costs here. Default: `calibrateCost()`, some 40 ms — a host that runs often calibrates once and passes it. */
  cost?: CostModel;
  onProgress?: (progress: OptimizeProgress) => void;
  /** The least time between two progress reports, and between two cancellation checks. Default 100 ms. */
  progressIntervalMs?: number;
  /** Asked right after each progress report is due; `true` stops the run, which returns what it has. */
  shouldCancel?: () => boolean;
  /** The clock, in milliseconds; injected by tests. Default `Date.now`. */
  now?: () => number;
  /** Vectors between two readings of the clock. Default: from the cost, about eight readings per interval. */
  checkEvery?: number;
}

/** A class vector with its exact score. */
export interface ScoredVector {
  /** Class totals, blank first, summing to the deck size; `expandClassVector` turns them into lines. */
  classTotals: number[];
  /** One exact fraction per hand size, and `pDisplay` for showing. */
  score: BlendScore;
  /**
   * The whole score as ONE exact fraction, every vector of a run over the
   * same denominator — so two vectors tie iff their `blend.num` are equal.
   * For one hand size it is that hand's fraction. What the run RANKS by: the
   * expected weight per hand when the criteria are weighted (PRD §5.6), and
   * the probability when they are not.
   */
  blend: Fraction;
  /**
   * P(at least one criterion), over the same denominator — the number the tool
   * reported before weights existed, kept beside the weighted one because both
   * are wanted and the second costs one more walk of the same success set.
   * Identical to `blend` when nothing is weighted.
   */
  success: Fraction;
}

export interface RankedVector extends ScoredVector {
  /** The raw line ratios behind this vector: all of them tie exactly. */
  rawRatios: Count;
}

export interface SweepCell {
  /** Copies of the line. */
  count: number;
  /** The best deck that holds exactly `count` copies of the line: the witness, and its score. */
  best: ScoredVector;
}

/** `best[line][count]` for one line (TDD §11.2): the others re-optimized around each count. */
export interface LineSweep {
  lineId: string;
  cls: number;
  /** By count; a count no scored deck can hold has no cell. */
  cells: SweepCell[];
  /** The counts at which the overall best is reached. */
  argmax: number[];
}

/**
 * A line of the blank class: no requirement or limit can see its cards (PRD
 * §5.6). Usually it only trades copies with the remainder and EVERY count
 * ties for the best — `flat`, said in one line instead of a table. It is not
 * flat when the blank class cannot absorb its copies, so that more of them
 * leave fewer cards that matter; then `cells` is its sweep after all.
 */
export interface IrrelevantLine {
  lineId: string;
  flat: boolean;
  /** The counts it takes across the scored decks. */
  min: number;
  max: number;
  /** The overall best: what every count reaches, when flat. */
  best: ScoredVector;
  cells?: SweepCell[];
}

export interface PlateauResult {
  delta: Rational;
  /** Every vector with `best − score <= delta` exactly, best first; the best-scoring `plateauCap` when truncated. */
  vectors: RankedVector[];
  /** How many vectors are within `delta` of the best — all of them, kept or not; a lower bound if not `sizeExact`. */
  size: number;
  sizeExact: boolean;
  truncated: boolean;
  /** The raw ratios behind `vectors`: a lower bound for the plateau's when truncated. */
  rawRatios: Count;
  /** For every line, in template order, the counts it takes across `vectors`. */
  lines: { lineId: string; counts: number[] }[];
}

export interface OptimizeOutputs {
  handSizes: HandSize[];
  /**
   * Whether the score is a WEIGHTED score — the expected weight per hand —
   * rather than a probability (PRD §5.6). It travels with the result because a
   * finished run's readout is a pure function of its result (TDD §3): what the
   * headline number IS cannot be looked up from a template that has moved on.
   */
  weighted: boolean;
  /** The largest weight any criterion of the run carries; 1 when none is weighted. */
  maxWeight: number;
  /** Vectors scored, of the exact number there are. */
  done: number;
  total: Count;
  /** Every valid raw line ratio of the template: what the class vectors stand for. */
  rawRatios: Count;
  elapsedMs: number;
  /** What the wall compared with the threshold, and the cost it came from. */
  estimatedMs: number;
  cost: CostModel;
  best: RankedVector;
  ranked: RankedVector[];
  plateau: PlateauResult;
  /** The lines that matter, in template order (the remainder, if it is one, last). */
  sweeps: LineSweep[];
  irrelevant: IrrelevantLine[];
}

export type OptimizeResult =
  | ({ status: 'done'; partial: false } & OptimizeOutputs)
  /** Everything holds for the first `done` vectors of the walk, and for those only. */
  | ({ status: 'cancelled'; partial: true } & OptimizeOutputs)
  | {
      status: 'needs-confirmation';
      /** `unsafe-count`: the vectors cannot even be counted in a safe integer. */
      reason: 'estimate' | 'unsafe-count';
      total: Count;
      estimatedMs: number;
      thresholdMs: number;
      cost: CostModel;
      message: string;
    }
  | { status: 'infeasible'; total: 0; message: string }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// Exact scores on one denominator
// ---------------------------------------------------------------------------

interface Ranker {
  blend: BlendScorer;
  /** `rankKey / rankDen` is the blended score, exactly. */
  rankDen: number;
  scored(classTotals: ArrayLike<number>): ScoredVector;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function createRanker(problem: Problem): Ranker {
  const blend = createBlendScorer(problem);
  // The denominator `rankKey` is over: the total weight times the least common
  // denominator. Checked here in BigInt rather than in float64, and with the
  // largest CRITERION weight in it — a part's numerator is up to `max(w) · den`
  // rather than `den`, so that is what a key is bounded by.
  const common = blend.scorers.reduce((lcm, { den }) => {
    const next = BigInt(den);
    return (lcm / gcd(lcm, next)) * next;
  }, 1n);
  const weight = problem.handSizes.reduce((sum, hand) => sum + BigInt(hand.weight), 0n);
  if (BigInt(blend.maxWeight) * weight * common > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(
      'these weights cannot be ranked in exact integers: a score would pass 2^53 — use smaller criterion weights, or a smaller hand-size blend such as 3 : 2',
    );
  const rankDen = Number(weight * common);
  return {
    blend,
    rankDen,
    scored: (classTotals) => {
      const score = blend.score(classTotals);
      const keys = blend.keysOf(score);
      return {
        classTotals: Array.from(classTotals),
        score,
        blend: { num: keys.blend, den: rankDen },
        success: { num: keys.success, den: rankDen },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

interface LineInfo {
  id: string;
  cls: number;
  min: number;
  max: number;
}

/** The lines of a compiled template by line index: template order, the remainder last. */
function linesOf({ classes, classOfLine }: Compiled): LineInfo[] {
  const lines = new Array<LineInfo>(classOfLine.length);
  classes.forEach((info, cls) => {
    for (const { id, line, min, max } of info.lines) lines[line] = { id, cls, min, max };
  });
  return lines;
}

function checkTotals(compiled: Compiled, classTotals: ArrayLike<number>): void {
  if (classTotals.length !== compiled.classes.length)
    throw new RangeError(
      `expected a total for each of the ${compiled.classes.length} classes, got ${classTotals.length}`,
    );
}

/**
 * ONE raw ratio behind a class vector — a count per line, the remainder's
 * last — for when a concrete deck is wanted: every line at its minimum, then
 * what is left of each class total handed to its lines in template order.
 */
export function exampleRatio(compiled: Compiled, classTotals: ArrayLike<number>): number[] {
  checkTotals(compiled, classTotals);
  const counts = new Array<number>(compiled.classOfLine.length).fill(0);
  compiled.classes.forEach(({ lines, min, max }, cls) => {
    const total = classTotals[cls]!;
    if (!Number.isInteger(total) || total < min || total > max)
      throw new RangeError(
        `class ${cls} cannot hold ${total} cards: its lines hold ${min} to ${max}`,
      );
    let left = total - min;
    for (const line of lines) {
      const extra = Math.min(left, line.max - line.min);
      counts[line.line] = line.min + extra;
      left -= extra;
    }
  });
  return counts;
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

function checkOptions(opts: OptimizeOptions): void {
  const positive = (name: string, value: number | undefined) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1))
      throw new RangeError(`${name} is a positive whole number, not ${value}`);
  };
  positive('topK', opts.topK);
  positive('plateauCap', opts.plateauCap);
  positive('checkEvery', opts.checkEvery);
  const delta = opts.plateauDelta;
  if (
    delta !== undefined &&
    (!Number.isSafeInteger(delta.num) ||
      !Number.isSafeInteger(delta.den) ||
      delta.num < 0 ||
      delta.den < 1)
  )
    throw new RangeError(
      `plateauDelta is a fraction of whole numbers, num >= 0 and den >= 1, not ${delta.num} / ${delta.den}`,
    );
  for (const name of ['progressIntervalMs', 'confirmThresholdMs'] as const) {
    const value = opts[name];
    if (value !== undefined && !(value >= 0))
      throw new RangeError(`${name} is a time in milliseconds, not ${value}`);
  }
}

/** Raw ratios behind a vector: the product of the ways to split each class total among its lines. */
function rawRatioCounter(classes: readonly CompiledClassInfo[]) {
  const memo = classes.map(() => new Map<number, bigint>());
  return (classTotals: readonly number[]): Count => {
    let product = 1n;
    classes.forEach(({ lines }, cls) => {
      const total = classTotals[cls]!;
      let ways = memo[cls]!.get(total);
      if (ways === undefined) {
        ways = countSums(lines, total);
        memo[cls]!.set(total, ways);
      }
      product *= ways;
    });
    return toCount(product);
  };
}

/**
 * Score every class vector of `compiled` once, and report the ranked table,
 * the plateau and every line's sweep (TDD §11.2). Never throws: what goes
 * wrong comes back as `status: 'error'`.
 *
 * THE WALL (TDD §11.3): nothing is scored when the estimate — vectors × the
 * calibrated cost of a score — is over `confirmThresholdMs`, or when the
 * vectors are too many to count in a safe integer; the result is then
 * `needs-confirmation`, and `force` is the confirmation.
 */
export function optimize(compiled: Compiled, opts: OptimizeOptions = {}): OptimizeResult {
  try {
    return search(compiled, opts);
  } catch (failure) {
    return {
      status: 'error',
      message: failure instanceof Error ? failure.message : String(failure),
    };
  }
}

function search(compiled: Compiled, opts: OptimizeOptions): OptimizeResult {
  checkOptions(opts);
  const { problem, classes } = compiled;
  const { deckSize } = problem;
  const k = classes.length;
  const now = opts.now ?? Date.now;
  const delta = opts.plateauDelta ?? DEFAULT_PLATEAU_DELTA;
  const thresholdMs = opts.confirmThresholdMs ?? DEFAULT_CONFIRM_THRESHOLD_MS;
  const intervalMs = opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const { onProgress, shouldCancel } = opts;

  const ranker = createRanker(problem);
  const { blend, rankDen } = ranker;
  const total = countVectors(problem.classes, deckSize);
  if (total === 0)
    return {
      status: 'infeasible',
      total: 0,
      message: `no deck fits: the ranges cannot sum to the deck size of ${deckSize}`,
    };

  // --- the wall ---------------------------------------------------------------------------
  const cost = opts.cost ?? calibrateCost().cost;
  const terms = blend.scorers.map((scorer) => scorer.terms);
  const estimatedMs = estimateMs(total, terms, cost);
  if (opts.force !== true) {
    const refusal = {
      status: 'needs-confirmation',
      total,
      estimatedMs,
      thresholdMs,
      cost,
    } as const;
    if (typeof total === 'string')
      return {
        ...refusal,
        reason: 'unsafe-count',
        message: `there are ${total} class vectors to score — past 2^53, more than can be counted off, let alone scored; narrow the ranges, or pass force to start anyway`,
      };
    if (estimatedMs > thresholdMs)
      return {
        ...refusal,
        reason: 'estimate',
        message: `scoring ${total} class vectors would take about ${Math.round(estimatedMs / 1000)} s, over the ${Math.round(thresholdMs / 1000)} s that run unasked; narrow the ranges, or pass force to run it anyway`,
      };
  }

  // --- storage, all of it up front --------------------------------------------------------
  const room = (wanted: number) => (typeof total === 'number' ? Math.min(wanted, total) : wanted);
  const ranked = new TopK(room(opts.topK ?? DEFAULT_TOP_K), k);
  // `best − score <= delta` on the common denominator: `bestKey − key <= delta · rankDen`, and
  // the keys being whole numbers, `<= floor(delta · rankDen)` — one exact integer, found once.
  // A delta of 1 or more takes in every vector; BigInt, because `delta.num · rankDen` may pass 2^53.
  const reach = (BigInt(delta.num) * BigInt(rankDen)) / BigInt(delta.den);
  const tolerance = reach > BigInt(rankDen) ? rankDen : Number(reach);
  const plateau = new Plateau({
    width: k,
    cap: room(opts.plateauCap ?? DEFAULT_PLATEAU_CAP),
    tolerance,
  });
  // Sweeps (TDD §11.2). A line's count is compatible with a vector through its CLASS total
  // alone, so the pass keeps the best key — and a witness — per (class, total), k updates a
  // vector, and every line's `best[line][count]` is read off these afterwards.
  const stride = deckSize + 1;
  const bestKeyAt = new Float64Array(k * stride).fill(-1);
  const witnessAt = new Uint8Array(k * stride * k);

  const perVectorNs = estimateMs(1, terms, cost) * 1e6;
  const checkEvery =
    opts.checkEvery ??
    Math.max(1, Math.min(65_536, Math.floor((intervalMs * 1e6) / 8 / Math.max(perVectorNs, 1))));
  const totalAsNumber = countToNumber(total);
  const start = now();
  let lastReport = start;
  let done = 0;
  let untilCheck = checkEvery;

  const finished = walkVectors(problem.classes, deckSize, (totals) => {
    const key = blend.rankKey(totals);
    ranked.offer(key, totals);
    plateau.offer(key, totals);
    for (let cls = 0; cls < k; cls++) {
      const at = cls * stride + totals[cls]!;
      if (key > bestKeyAt[at]!) {
        bestKeyAt[at] = key;
        witnessAt.set(totals, at * k);
      }
    }
    done++;
    if (--untilCheck > 0) return true;
    untilCheck = checkEvery;
    const at = now();
    if (at - lastReport < intervalMs) return true;
    lastReport = at;
    const elapsedMs = at - start;
    onProgress?.({ done, total, elapsedMs, etaMs: (elapsedMs * (totalAsNumber - done)) / done });
    return shouldCancel?.() !== true;
  });
  const elapsedMs = now() - start;
  const complete = finished || done === total;
  if (complete) onProgress?.({ done, total, elapsedMs, etaMs: 0 });

  // --- the outputs ------------------------------------------------------------------------
  const rawRatiosOf = rawRatioCounter(classes);
  const rankedVector = (vector: readonly number[]): RankedVector => ({
    ...ranker.scored(vector),
    rawRatios: rawRatiosOf(vector),
  });
  const table = ranked.sorted().map(({ vector }) => rankedVector(vector));
  const best = table[0]!;
  const bestKey = best.blend.num;
  const lines = linesOf(compiled);

  const kept = plateau.result();
  const plateauVectors = kept.entries.map(({ vector }) => rankedVector(vector));
  const plateauTotals = classes.map(
    (_, cls) => new Set(plateauVectors.map((v) => v.classTotals[cls]!)),
  );

  const sweeps: LineSweep[] = [];
  const irrelevant: IrrelevantLine[] = [];
  for (const line of lines) {
    const cls = classes[line.cls]!;
    // best[line][count]: the best class total that a line at `count` is compatible with.
    const cellKey = new Map<number, number>();
    const cellTotal = new Map<number, number>();
    for (let t = 0; t <= deckSize; t++) {
      const key = bestKeyAt[line.cls * stride + t]!;
      if (key < 0) continue;
      const { min, max } = lineInterval(cls, line, t);
      for (let count = min; count <= max; count++)
        if (key > (cellKey.get(count) ?? -1)) {
          cellKey.set(count, key);
          cellTotal.set(count, t);
        }
    }
    const counts = [...cellKey.keys()].sort((a, b) => a - b);
    const cells = counts.map((count): SweepCell => {
      const at = (line.cls * stride + cellTotal.get(count)!) * k;
      return { count, best: ranker.scored(witnessAt.subarray(at, at + k)) };
    });
    if (line.cls !== 0) {
      const argmax = counts.filter((count) => cellKey.get(count) === bestKey);
      sweeps.push({ lineId: line.id, cls: line.cls, cells, argmax });
      continue;
    }
    const flat = counts.every((count) => cellKey.get(count) === bestKey);
    const { classTotals, score, blend: fraction, success } = best;
    irrelevant.push({
      lineId: line.id,
      flat,
      min: counts[0]!,
      max: counts.at(-1)!,
      best: { classTotals, score, blend: fraction, success },
      ...(flat ? {} : { cells }),
    });
  }

  const outputs: OptimizeOutputs = {
    handSizes: problem.handSizes,
    weighted: compiled.weighted,
    maxWeight: ranker.blend.maxWeight,
    done,
    total,
    rawRatios: toCount(
      countSums(
        classes.flatMap((cls) => cls.lines),
        deckSize,
      ),
    ),
    elapsedMs,
    estimatedMs,
    cost,
    best,
    ranked: table,
    plateau: {
      delta,
      vectors: plateauVectors,
      size: kept.size,
      sizeExact: kept.sizeExact,
      truncated: kept.truncated,
      rawRatios: toCount(
        plateauVectors.reduce((sum, vector) => sum + BigInt(vector.rawRatios), 0n),
      ),
      lines: lines.map((line) => {
        const counts = new Set<number>();
        for (const t of plateauTotals[line.cls]!) {
          const { min, max } = lineInterval(classes[line.cls]!, line, t);
          for (let count = min; count <= max; count++) counts.add(count);
        }
        return { lineId: line.id, counts: [...counts].sort((a, b) => a - b) };
      }),
    },
    sweeps,
    irrelevant,
  };
  return complete
    ? { status: 'done', partial: false, ...outputs }
    : { status: 'cancelled', partial: true, ...outputs };
}

// ---------------------------------------------------------------------------
// On demand: one line swept with the others held fixed; one vector by criterion
// ---------------------------------------------------------------------------

export type FixedSweepCell =
  | { count: number; remainder: number; feasible: true; best: ScoredVector }
  /** The remainder would leave its range: this is not a deck of the template. */
  | { count: number; remainder: number; feasible: false };

/**
 * The sweep with the others HELD FIXED (TDD §11.2): `baseRatio` — a count per
 * line in template order, without the remainder — scored at every count of
 * the line `lineId`, the remainder absorbing the difference. No search: at
 * most a handful of decks. A count that pushes the remainder out of its range
 * comes back `feasible: false`; a base ratio that is not a deck of the
 * template, or a line that is not one of its lines, throws a `RangeError`.
 */
export function sweepFixed(
  compiled: Compiled,
  baseRatio: readonly number[],
  lineId: string,
): FixedSweepCell[] {
  const lines = linesOf(compiled);
  const remainder = lines.at(-1)!;
  const own = lines.slice(0, -1);
  if (baseRatio.length !== own.length)
    throw new RangeError(
      `the base ratio has ${baseRatio.length} counts, but the template has ${own.length} lines (${own.map((l) => l.id).join(', ')})`,
    );
  own.forEach((line, at) => {
    const count = baseRatio[at]!;
    if (!Number.isInteger(count) || count < line.min || count > line.max)
      throw new RangeError(
        `the base ratio gives line ${JSON.stringify(line.id)} ${count} copies, outside its range ${line.min}–${line.max}`,
      );
  });
  if (lineId === REMAINDER_ID)
    throw new RangeError(
      'the remainder cannot be swept with the others held fixed: it IS what absorbs the difference',
    );
  const swept = own.findIndex((line) => line.id === lineId);
  if (swept < 0) throw new RangeError(`the template has no line ${JSON.stringify(lineId)}`);

  const { deckSize } = compiled.problem;
  const inRange = (left: number) => left >= remainder.min && left <= remainder.max;
  const used = baseRatio.reduce((sum, count) => sum + count, 0);
  if (!inRange(deckSize - used))
    throw new RangeError(
      `the base ratio leaves ${deckSize - used} unspecified cards, outside the remainder's range ${remainder.min}–${remainder.max}`,
    );

  const ranker = createRanker(compiled.problem);
  const cells: FixedSweepCell[] = [];
  for (let count = own[swept]!.min; count <= own[swept]!.max; count++) {
    const left = deckSize - used + baseRatio[swept]! - count;
    if (!inRange(left)) {
      cells.push({ count, remainder: left, feasible: false });
      continue;
    }
    const classTotals = new Array<number>(compiled.classes.length).fill(0);
    [...baseRatio, left].forEach((held, line) => {
      classTotals[lines[line]!.cls]! += line === swept ? count : held;
    });
    cells.push({ count, remainder: left, feasible: true, best: ranker.scored(classTotals) });
  }
  return cells;
}

/** A criterion as the TEMPLATE has it: `ResolvedCriterion` satisfies this. */
export interface BreakdownCriterion {
  id: string;
  name?: string;
  /** Its own flat alternatives; the descriptions are columns of the match matrix `compiled` was built from. */
  alternatives: readonly FlatAlternative[];
  /**
   * Parallel to `compiled.problem.handSizes`: whether this criterion counts
   * for that part. Absent: every part, which is what an untagged criterion
   * means and what a single-part run always is. A part this criterion is not
   * in scores 0 there — a criterion for going second contributes nothing to
   * going first, and its share of an average is halved rather than hidden.
   */
  parts?: readonly boolean[];
  /** What meeting it is worth (PRD §5.6); absent is 1. Reported, never scored — see `breakdown`. */
  weight?: number;
}

export interface CriterionScore {
  id: string;
  name?: string;
  score: BlendScore;
  blend: Fraction;
  /** What the run counts a hand meeting it as being worth; 1 when nothing is weighted. */
  weight: number;
}

/**
 * The exact probability of each TEMPLATE criterion by itself, for one class
 * vector (PRD §5.6) — computed for the rows that are shown, never in the
 * search. `compiled.problem.criteria` cannot answer this: it holds the flat
 * alternatives of ALL the criteria together, duplicates removed, so its
 * indices are not the template's. Each criterion is judged as a problem of
 * its own instead — the same classes, its own alternatives.
 *
 * WEIGHTS ARE REPORTED, NOT APPLIED. A criterion's own number is its
 * PROBABILITY, in a weighted run exactly as in an unweighted one, because that
 * is the question the row answers — how often this happens — and it is what
 * makes the rows of a weighted run comparable with those of the same template
 * unweighted. There is no per-criterion "contribution" to the weighted total to
 * put here instead: the total is a MAXIMUM over the criteria a hand meets, not
 * a sum, so it does not decompose criterion by criterion at all, and a column
 * of `weight × probability` would add up to something the run never computed.
 * The weight is carried beside the probability so the reader can see which
 * criterion the score is leaning on.
 */
export function breakdown(
  compiled: Compiled,
  criteria: readonly BreakdownCriterion[],
  classTotals: ArrayLike<number>,
): CriterionScore[] {
  checkTotals(compiled, classTotals);
  const maskOf = (desc: number): number => {
    let mask = 0;
    compiled.classes.forEach(({ fills }, cls) => {
      if (fills.includes(desc)) mask |= 1 << cls;
    });
    return mask >>> 0;
  };
  // The same ceiling and limit dropping the whole problem got, so a criterion
  // alone is judged exactly as it is judged among the others.
  const largestHand = Math.max(...compiled.problem.handSizes.map(({ H }) => H));
  return criteria.map(({ id, name, alternatives, parts, weight }) => {
    // Its own alternatives, unweighted whatever the run does: this row is a
    // probability, and a weight here would scale it into something else.
    const own = alternatives.map(
      (alternative) =>
        compileCriterion({ ...alternative, weight: 1 }, maskOf, largestHand).criterion,
    );
    // Every one of its own alternatives in the parts it counts for, none in
    // the others — the same shape of blend the run has, so its numbers sit
    // under the run's and mean the same thing.
    const all = own.map((_, at) => at);
    const alone: Problem = {
      ...compiled.problem,
      // `drawn` is the RUN's, not this criterion's: it says what a hand IS, and
      // a row scored over a sixth of the headline's denominator would not sit
      // under it. A criterion that names no sixth card is simply worth the same
      // whichever of the six cards was drawn.
      handSizes: compiled.problem.handSizes.map((hand, at) => ({
        H: hand.H,
        weight: hand.weight,
        criteria: (parts?.[at] ?? true) ? all : [],
        ...(hand.drawn === true ? { drawn: true as const } : {}),
      })),
      criteria: own,
    };
    const { score, blend } = createRanker(alone).scored(classTotals);
    const row: CriterionScore = { id, score, blend, weight: weight ?? 1 };
    if (name !== undefined) row.name = name;
    return row;
  });
}
