/**
 * The ranked table's container (TDD §11.2): the best `capacity` class vectors
 * seen so far, by EXACT integer key, in storage allocated once — an offer
 * copies the vector into a slot it already owns, so the optimizer's hot loop
 * allocates nothing.
 *
 * THE ORDER, everywhere the optimizer ranks: the higher key first; on equal
 * keys — an exact tie — the LEXICOGRAPHICALLY SMALLER vector first, comparing
 * from index 0 (the blank class). It depends on nothing but the entries
 * themselves, so what is kept does not depend on the order they arrive in.
 */

export interface RankedEntry {
  key: number;
  vector: number[];
}

/** Negative when `(keyA, a)` ranks before `(keyB, b)`, positive when after, 0 for the same entry. */
export function compareRanked(
  keyA: number,
  a: ArrayLike<number>,
  keyB: number,
  b: ArrayLike<number>,
): number {
  if (keyA !== keyB) return keyB - keyA;
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return a[at]! - b[at]!;
  return 0;
}

/** A bounded binary heap with the WORST kept entry at the root. */
export class TopK {
  readonly capacity: number;
  readonly width: number;
  private readonly keys: Float64Array;
  /** `vectors[slot * width …]`: the vector of the entry in `slot`; slots never move, heap positions do. */
  private readonly vectors: Int32Array;
  /** `heap[position]` is a slot; position 0 is the root. */
  private readonly heap: Int32Array;
  private count = 0;

  constructor(capacity: number, width: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError(`a capacity is a positive whole number, not ${capacity}`);
    if (!Number.isInteger(width) || width < 1)
      throw new RangeError(`a vector has a positive whole number of entries, not ${width}`);
    this.capacity = capacity;
    this.width = width;
    this.keys = new Float64Array(capacity);
    this.vectors = new Int32Array(capacity * width);
    // Every slot starts free: `heap[count …]` always lists the slots no entry holds.
    this.heap = Int32Array.from({ length: capacity }, (_, slot) => slot);
  }

  get size(): number {
    return this.count;
  }

  /** Whether the entry in slot `a` ranks AFTER the one in slot `b`. */
  private worse(a: number, b: number): boolean {
    const keyA = this.keys[a]!;
    const keyB = this.keys[b]!;
    if (keyA !== keyB) return keyA < keyB;
    const { vectors, width } = this;
    for (let at = 0; at < width; at++) {
      const lead = vectors[a * width + at]! - vectors[b * width + at]!;
      if (lead !== 0) return lead > 0;
    }
    return false;
  }

  /** Whether the offered entry ranks after the one in `slot`. */
  private offeredIsWorse(key: number, vector: ArrayLike<number>, slot: number): boolean {
    const kept = this.keys[slot]!;
    if (key !== kept) return key < kept;
    const { vectors, width } = this;
    for (let at = 0; at < width; at++) {
      const lead = vector[at]! - vectors[slot * width + at]!;
      if (lead !== 0) return lead > 0;
    }
    return true;
  }

  private store(slot: number, key: number, vector: ArrayLike<number>): void {
    this.keys[slot] = key;
    const base = slot * this.width;
    for (let at = 0; at < this.width; at++) this.vectors[base + at] = vector[at]!;
  }

  private siftUp(position: number): void {
    const { heap } = this;
    const slot = heap[position]!;
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (!this.worse(slot, heap[parent]!)) break;
      heap[position] = heap[parent]!;
      position = parent;
    }
    heap[position] = slot;
  }

  private siftDown(position: number): void {
    const { heap, count } = this;
    const slot = heap[position]!;
    for (;;) {
      let child = 2 * position + 1;
      if (child >= count) break;
      if (child + 1 < count && this.worse(heap[child + 1]!, heap[child]!)) child++;
      if (!this.worse(heap[child]!, slot)) break;
      heap[position] = heap[child]!;
      position = child;
    }
    heap[position] = slot;
  }

  /**
   * Offer an entry; `vector` is copied. Returns the KEY of the entry that
   * fell out to make room — the offered one itself, if it ranks after all
   * that are kept — or −1 when there was room and nothing fell out.
   */
  offer(key: number, vector: ArrayLike<number>): number {
    if (vector.length !== this.width)
      throw new RangeError(`expected a vector of ${this.width} entries, got ${vector.length}`);
    if (this.count < this.capacity) {
      // Slots are handed out in order while filling; `dropBelow` keeps the free ones at the end.
      const slot = this.heap[this.count]!;
      this.store(slot, key, vector);
      this.siftUp(this.count++);
      return -1;
    }
    const root = this.heap[0]!;
    if (this.offeredIsWorse(key, vector, root)) return key;
    const fell = this.keys[root]!;
    this.store(root, key, vector);
    this.siftDown(0);
    return fell;
  }

  /** Drop every entry whose key is under `key`; returns how many went. */
  dropBelow(key: number): number {
    const { heap } = this;
    let dropped = 0;
    while (this.count > 0 && this.keys[heap[0]!]! < key) {
      // The freed slot goes to the position the heap gives up, where `offer` will find it.
      const freed = heap[0]!;
      this.count--;
      heap[0] = heap[this.count]!;
      heap[this.count] = freed;
      if (this.count > 0) this.siftDown(0);
      dropped++;
    }
    return dropped;
  }

  /** The keys of the kept entries, in no particular order. */
  keptKeys(): number[] {
    return Array.from(this.heap.subarray(0, this.count), (slot) => this.keys[slot]!);
  }

  /** The kept entries, best first. The heap is left as it was. */
  sorted(): RankedEntry[] {
    const { keys, vectors, width } = this;
    const entries = Array.from(this.heap.subarray(0, this.count), (slot) => ({
      key: keys[slot]!,
      vector: Array.from(vectors.subarray(slot * width, (slot + 1) * width)),
    }));
    return entries.sort((a, b) => compareRanked(a.key, a.vector, b.key, b.vector));
  }
}
