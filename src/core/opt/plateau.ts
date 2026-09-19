import { type RankedEntry, TopK } from './heap';

/**
 * The plateau (TDD §11.2, PRD §5.6): every class vector whose EXACT key is
 * within `tolerance` of the best — "2 or 3 copies are equally fine" — kept in
 * ONE pass, while the best is still moving. The kept entries live in a
 * bounded heap with the worst at its root, so that whenever the best improves
 * the entries that fell out of reach are exactly the ones popped off the top;
 * when more than `cap` vectors qualify, the best-scoring `cap` are kept.
 *
 * How many vectors qualify is counted EXACTLY even then, by a histogram over
 * the window of keys `[best − tolerance, best]` — a ring of `tolerance + 1`
 * counters indexed by `key mod (tolerance + 1)`, from which the keys that
 * leave the window are cleared as the best moves up. The ring is built the
 * first time the cap bites — until then the kept entries ARE the plateau —
 * so a run that never truncates never pays for it. Past `histogramLimit`
 * counters it is not built at all, and a truncated size is a lower bound.
 */

export interface PlateauOptions {
  /** Entries per vector. */
  width: number;
  /** The most entries kept. */
  cap: number;
  /** In key units, a whole number: an entry qualifies iff `best − key <= tolerance`. */
  tolerance: number;
  /** The most histogram counters worth their memory (8 bytes each). Default 2^23. */
  histogramLimit?: number;
}

export interface PlateauEntries {
  /** Best first, in the order of `compareRanked`; at most `cap`. */
  entries: RankedEntry[];
  /** How many vectors are within the tolerance of the best; a LOWER BOUND when `sizeExact` is false. */
  size: number;
  sizeExact: boolean;
  /** More vectors qualify than `entries` holds. */
  truncated: boolean;
}

export const DEFAULT_HISTOGRAM_LIMIT = 2 ** 23;

export class Plateau {
  readonly tolerance: number;
  private readonly kept: TopK;
  private readonly ringSize: number;
  /** `null` until the cap first bites, and for good when `ringSize` is 0. */
  private ring: Float64Array | null = null;
  private top = -1;
  /** The highest key that ever fell out to the cap: if it still qualifies at the end, the plateau is truncated. */
  private highestFallen = -1;

  constructor({ width, cap, tolerance, histogramLimit = DEFAULT_HISTOGRAM_LIMIT }: PlateauOptions) {
    if (!Number.isSafeInteger(tolerance) || tolerance < 0)
      throw new RangeError(`a tolerance is a whole number of key units, not ${tolerance}`);
    this.tolerance = tolerance;
    this.kept = new TopK(cap, width);
    this.ringSize = tolerance + 1 <= histogramLimit ? tolerance + 1 : 0;
  }

  /** The best key offered so far; −1 before the first. */
  get best(): number {
    return this.top;
  }

  /** Move the best up to `key`: forget the keys that leave the window, in the ring and in the heap. */
  private raise(key: number): void {
    const { ring, tolerance } = this;
    if (ring !== null && this.top >= 0) {
      if (key - this.top >= ring.length) ring.fill(0);
      else
        for (let gone = Math.max(0, this.top - tolerance); gone < key - tolerance; gone++)
          ring[gone % ring.length] = 0;
    }
    this.top = key;
    this.kept.dropBelow(key - tolerance);
  }

  /** Offer a vector with its exact key, a whole number >= 0; `vector` is copied if it is kept. */
  offer(key: number, vector: ArrayLike<number>): void {
    if (key > this.top) this.raise(key);
    else if (this.top - key > this.tolerance) return;
    const fell = this.kept.offer(key, vector);
    if (this.ring !== null) this.ring[key % this.ring.length]!++;
    if (fell < 0) return;
    if (fell > this.highestFallen) this.highestFallen = fell;
    if (this.ring === null && this.ringSize > 0) {
      // The first entry ever to fall to the cap: with it, the kept entries are still everything
      // that qualifies — `raise` drops the rest as the best moves — so the count starts here.
      this.ring = new Float64Array(this.ringSize);
      for (const counted of [...this.kept.keptKeys(), fell]) this.ring[counted % this.ringSize]!++;
    }
  }

  result(): PlateauEntries {
    const entries = this.kept.sorted();
    if (this.ring === null) {
      // Nothing ever fell to the cap, or there is no histogram to say how much of it still qualifies.
      const truncated = this.highestFallen >= 0 && this.top - this.highestFallen <= this.tolerance;
      return { entries, size: entries.length, sizeExact: !truncated, truncated };
    }
    let size = 0;
    for (const count of this.ring) size += count;
    return { entries, size, sizeExact: true, truncated: size > entries.length };
  }
}
