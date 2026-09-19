import type { Description } from '../desc/ast';
import { type ImpliesContext, implies } from '../desc/implies';
import type { Counted, FlatCriterion } from './ast';

/**
 * How subsumption decides `L ⇒ q`: a context for `implies`, or a relation of
 * the caller's own — `analyze` passes a memo over the template's distinct
 * descriptions, since the same few pairs are asked about again and again.
 */
export type Implication = ImpliesContext | ((L: Description, q: Description) => boolean);

function relationOf(ctx: Implication): (L: Description, q: Description) => boolean {
  return typeof ctx === 'function' ? ctx : (L, q) => implies(L, q, ctx);
}

/** `flat[subsumed]` is subsumed by `flat[by]`: it adds no hand that `flat[by]` does not already accept. */
export interface Subsumption {
  subsumed: number;
  by: number;
}

/**
 * Whether the slots of `B` (each `n×` is `n` slots) can be sent to DISTINCT
 * slots of `A`, each to one whose description implies its own. A bipartite
 * matching by augmenting paths: first-fit is not enough — `monster` must not
 * sit on the only slot `level 4 monster` could take — and counts run to 60,
 * where trying every assignment would not end.
 */
function slotsInject(
  B: readonly Counted[],
  A: readonly Counted[],
  holds: (L: Description, q: Description) => boolean,
): boolean {
  // Decided once per pair of requirements, not per pair of slots.
  const accepts = B.map((b) => A.map((a) => holds(a.desc, b.desc)));
  const groupOfSlot = (reqs: readonly Counted[]) =>
    reqs.flatMap(({ n }, group) => Array.from({ length: n }, () => group));
  const slotsB = groupOfSlot(B);
  const slotsA = groupOfSlot(A);
  if (slotsB.length > slotsA.length) return false;

  /** The slot of `B` sitting on each slot of `A`. */
  const holder: (number | undefined)[] = slotsA.map(() => undefined);
  const place = (slotB: number, visited: Set<number>): boolean => {
    for (let slotA = 0; slotA < slotsA.length; slotA++) {
      if (visited.has(slotA) || !accepts[slotsB[slotB]!]![slotsA[slotA]!]) continue;
      visited.add(slotA);
      const sitting = holder[slotA];
      // Free, or its holder can move elsewhere.
      if (sitting === undefined || place(sitting, visited)) {
        holder[slotA] = slotB;
        return true;
      }
    }
    return false;
  };
  return slotsB.every((_, slotB) => place(slotB, new Set()));
}

/**
 * Whether `A` is subsumed by `B` — every hand that satisfies `A` satisfies
 * `B` (TDD §7.2) — as far as this SUFFICIENT condition can tell:
 * - the requirement slots of `B` inject into those of `A`, each slot of `A`
 *   implying the slot of `B` sent to it: the cards a hand assigns to `A`'s
 *   slots then fill `B`'s, and they are distinct because the slots are; and
 * - every limit `(nB, dB)` of `B` is covered by a limit `(nA, dA)` of `A` with
 *   `nA <= nB` and `dB` implying `dA`: whatever `B`'s limit counts `A`'s
 *   counts too, so `B`'s count is at most `A`'s, at most `nA`, at most `nB`.
 *   A limit with `nB >= maxHandSize` holds of every hand and needs no cover.
 *
 * `true` is a proof. `false` is NOT a refutation — the condition is not
 * necessary: two limits of `A` never combine to cover one of `B` (`no monster
 * and no spell` against `no (monster or spell)`), an `A` that no hand can
 * satisfy is subsumed by everything, and requirements are never weighed
 * against limits. It is advice for a notice (PRD §8.3); nothing computed
 * depends on it.
 */
export function subsumes(
  B: FlatCriterion,
  A: FlatCriterion,
  ctx: Implication,
  maxHandSize = Number.POSITIVE_INFINITY,
): boolean {
  const holds = relationOf(ctx);
  const covered = B.limits.every(
    (b) => b.n >= maxHandSize || A.limits.some((a) => a.n <= b.n && holds(b.desc, a.desc)),
  );
  return covered && slotsInject(B.reqs, A.reqs, holds);
}

/**
 * Every pair in which `flat[subsumed]` is subsumed by `flat[by]`, ordered by
 * `subsumed`, then `by` — the material for the "this criterion adds nothing"
 * notice. Two criteria that subsume each other are equivalent, and only the
 * later one is reported, as subsumed by the earlier.
 */
export function findSubsumed(
  flat: readonly FlatCriterion[],
  ctx: Implication,
  maxHandSize?: number,
): Subsumption[] {
  /** `holds[by][subsumed]` */
  const holds = flat.map((B, by) =>
    flat.map((A, subsumed) => subsumed !== by && subsumes(B, A, ctx, maxHandSize)),
  );
  const out: Subsumption[] = [];
  for (let subsumed = 0; subsumed < flat.length; subsumed++)
    for (let by = 0; by < flat.length; by++) {
      if (!holds[by]![subsumed]) continue;
      if (holds[subsumed]![by] && subsumed < by) continue;
      out.push({ subsumed, by });
    }
  return out;
}
