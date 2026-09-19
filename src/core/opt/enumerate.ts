import { countSums, type IntRange } from '../model/ranges';
import { type Count, toCount } from '../util/count';

/**
 * The optimizer's search space (TDD §11.1): every class-total vector `t` with
 * `t[c]` inside the range of class `c` and `Σ t[c] = deckSize`. The walk runs
 * over the NON-BLANK classes (1, 2, …) only; the blank class (index 0) absorbs
 * whatever they leave of the deck, and the bounds of every level are tightened
 * so that it always lands inside its own range — a branch is entered only if
 * some vector lies under it, so none is dead.
 */

/**
 * One slice of the space, for a fan-out over workers: shard `shard` of `of`
 * holds the vectors whose FIRST NON-BLANK total is congruent to `shard`
 * modulo `of`. (A space with no non-blank class is one vector, in shard 0.)
 */
export interface Shard {
  shard: number;
  of: number;
}

export interface WalkOptions {
  /** Default: the whole space. */
  shard?: Shard;
}

/**
 * Called once per vector. `totals` is LIVE: the one array the walk keeps
 * writing into — read it during the call, and copy what must outlive it.
 * Return `false` to stop the walk.
 */
export type VisitVector = (totals: Int32Array) => boolean;

function checkSpace(classes: readonly IntRange[], deckSize: number, shard: Shard): void {
  if (classes.length === 0)
    throw new RangeError('a space has at least the blank class, at index 0');
  if (!Number.isInteger(deckSize) || deckSize < 0)
    throw new RangeError(`a deck size is a whole number of cards, not ${deckSize}`);
  classes.forEach(({ min, max }, cls) => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0)
      throw new RangeError(`class ${cls}: a range is in whole cards, not ${min} to ${max}`);
  });
  if (
    !Number.isInteger(shard.of) ||
    !Number.isInteger(shard.shard) ||
    shard.of < 1 ||
    shard.shard < 0 ||
    shard.shard >= shard.of
  )
    throw new RangeError(`a shard is one of 0 … of − 1, not ${shard.shard} of ${shard.of}`);
}

const WHOLE: Shard = { shard: 0, of: 1 };

/** The least `value >= from` with `value ≡ shard (mod of)`. */
function firstInShard(from: number, { shard, of }: Shard): number {
  return from + ((((shard - from) % of) + of) % of);
}

/**
 * Walk the space depth-first, in lexicographic order of the non-blank totals
 * `(t[1], t[2], …)`, allocating nothing per vector. Returns `false` if a visit
 * stopped it, `true` if it ran to the end (an empty space included).
 */
export function walkVectors(
  classes: readonly IntRange[],
  deckSize: number,
  visit: VisitVector,
  opts: WalkOptions = {},
): boolean {
  const shard = opts.shard ?? WHOLE;
  checkSpace(classes, deckSize, shard);
  if (classes.some(({ min, max }) => min > max)) return true;

  const k = classes.length;
  const blank = classes[0]!;
  // What the non-blank classes must add up to, for the blank class to be in range.
  const least = deckSize - blank.max;
  const most = deckSize - blank.min;
  const totals = new Int32Array(k);
  if (k === 1) {
    if (least > 0 || most < 0 || shard.shard !== 0) return true;
    totals[0] = deckSize;
    return visit(totals);
  }

  // suffixMin[i] / suffixMax[i]: what the classes i, i + 1, … hold at least / at most.
  const suffixMin = new Float64Array(k + 1);
  const suffixMax = new Float64Array(k + 1);
  for (let cls = k - 1; cls >= 1; cls--) {
    suffixMin[cls] = suffixMin[cls + 1]! + classes[cls]!.min;
    suffixMax[cls] = suffixMax[cls + 1]! + classes[cls]!.max;
  }
  const mins = Int32Array.from(classes, ({ min }) => min);
  const maxs = Float64Array.from(classes, ({ max }) => max);

  /** `used[d]`: the cards of classes 1 … d − 1; `next[d]` and `last[d]`: the values of class `d` still to try. */
  const used = new Int32Array(k);
  const next = new Float64Array(k);
  const last = new Float64Array(k);
  const open = (depth: number, held: number): void => {
    used[depth] = held;
    // High enough that the rest can still reach `least`; low enough that it need not pass `most`.
    const lo = Math.max(mins[depth]!, least - held - suffixMax[depth + 1]!);
    next[depth] = depth === 1 ? firstInShard(lo, shard) : lo;
    last[depth] = Math.min(maxs[depth]!, most - held - suffixMin[depth + 1]!);
  };

  const deepest = k - 1;
  let depth = 1;
  open(1, 0);
  while (depth >= 1) {
    if (next[depth]! > last[depth]!) {
      depth--;
      continue;
    }
    const value = next[depth]!;
    next[depth] = value + (depth === 1 ? shard.of : 1);
    totals[depth] = value;
    const held = used[depth]! + value;
    if (depth < deepest) open(++depth, held);
    else {
      totals[0] = deckSize - held;
      if (!visit(totals)) return false;
    }
  }
  return true;
}

/**
 * How many vectors `walkVectors` visits — exactly, by the counting DP
 * (`countSums`), without walking: the `total` of a run's progress (TDD §11.3).
 * It can pass 2^53, hence a `Count`.
 */
export function countVectors(
  classes: readonly IntRange[],
  deckSize: number,
  opts: WalkOptions = {},
): Count {
  const shard = opts.shard ?? WHOLE;
  checkSpace(classes, deckSize, shard);
  if (shard.of === 1) return toCount(countSums(classes, deckSize));
  if (classes.length === 1) return shard.shard === 0 ? toCount(countSums(classes, deckSize)) : 0;
  // A shard pins the first non-blank class to every `of`-th value.
  const [blank, first, ...rest] = classes as [IntRange, IntRange, ...IntRange[]];
  let count = 0n;
  for (let v = firstInShard(first.min, shard); v <= Math.min(first.max, deckSize); v += shard.of)
    count += countSums([blank, { min: v, max: v }, ...rest], deckSize);
  return toCount(count);
}
