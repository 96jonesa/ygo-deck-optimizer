/**
 * A count that can be astronomically large — the raw ratios of a wide
 * template — as a plain JSON value, because it crosses IPC inside an
 * `Analysis` (TDD §9, §12): a `number` while it is a safe integer, and
 * otherwise its EXACT decimal digits as a `string`. Nothing is rounded until
 * `formatCount` shows it.
 */
export type Count = number | string;

export function toCount(value: bigint): Count {
  if (value < 0n) throw new RangeError(`a count cannot be negative: ${value}`);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

/** For estimates only: the nearest float to a count past 2^53. */
export function countToNumber(count: Count): number {
  return typeof count === 'number' ? count : Number(count);
}

/** `4,096`, or `about 9.01 × 10^15` — truncated to three figures — past 2^53. */
export function formatCount(count: Count): string {
  if (typeof count === 'number') return count.toLocaleString('en-US');
  return `about ${count[0]}.${count.slice(1, 3)} × 10^${count.length - 1}`;
}
