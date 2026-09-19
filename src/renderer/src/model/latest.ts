/**
 * Numbers the requests of one kind, and tells the answer to the newest from
 * an answer a newer request has overtaken (TDD §12): main echoes each
 * request's number, and a stale answer is dropped instead of rendered.
 */
export class LatestOnly {
  private latest = 0;

  /** The sequence number for a request about to be sent. */
  next(): number {
    return ++this.latest;
  }

  /** Whether `seq` is the newest request's — nothing is, before the first. */
  isCurrent(seq: number): boolean {
    return this.latest > 0 && seq === this.latest;
  }
}
