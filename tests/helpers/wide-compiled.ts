import { type CompileInput, compileProblem } from '../../src/core/model/compile';
import type { BreakdownCriterion, Compiled } from '../../src/core/opt/optimizer';
import type { RunRequest, WorkerRunOptions } from '../../src/worker/protocol';

export interface WideOptions {
  /** Lines `l0`, `l1`, …, each `0–max` copies and each a class of its own. */
  lines: number;
  max: number;
  /** One more line, `twin`, that the criteria cannot tell from `l0`: the two merge into one class. */
  twin?: boolean;
  deckSize?: number;
}

export interface WideProblem {
  compiled: Compiled;
  criteria: BreakdownCriterion[];
}

/**
 * A compiled problem of any width, written straight over a match matrix — no
 * card data, as the worker sees it. Line `i` fills description `i` and
 * nothing else; the criteria pair the descriptions off (`1x d0, 1x d1`,
 * `1x d2, 1x d3`, …), so every line matters and the vectors number about
 * `(max + 1) ^ lines`: 8 lines of 0–6 are millions, and seconds of search.
 */
export function wideProblem({ lines, max, twin = false, deckSize = 40 }: WideOptions): WideProblem {
  const ids = Array.from({ length: lines }, (_, i) => `l${i}`);
  const fills = ids.map((_, i) => i);
  if (twin) {
    ids.push('twin');
    fills.push(0);
  }
  const input: CompileInput = {
    deckSize,
    handSize: 5,
    lines: [
      ...ids.map((id) => ({ id, isRemainder: false, min: 0, max })),
      { id: 'remainder', isRemainder: true, min: 0, max: null },
    ],
    matrix: [
      ...fills.map((desc) => Array.from({ length: lines }, (_, column) => column === desc)),
      new Array<boolean>(lines).fill(false),
    ],
    flat: [],
  };
  const criteria: BreakdownCriterion[] = [];
  for (let desc = 0; desc + 1 < lines; desc += 2) {
    const alternative = {
      reqs: [
        { n: 1, desc },
        { n: 1, desc: desc + 1 },
      ],
      limits: [],
    };
    criteria.push({ id: `c${desc / 2}`, alternatives: [alternative] });
    (input.flat as (typeof alternative)[]).push(alternative);
  }
  const compiled = compileProblem(input);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return { compiled, criteria };
}

/** A fresh cancel flag: four bytes, zero. */
export function cancelFlag(): SharedArrayBuffer {
  return new SharedArrayBuffer(4);
}

export function runRequest(
  runId: number,
  problem: WideProblem,
  options: WorkerRunOptions = {},
  flag: SharedArrayBuffer = cancelFlag(),
): RunRequest {
  return { type: 'run', runId, ...problem, options, cancelFlag: flag };
}
