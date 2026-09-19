import type { Expr, FlatCriterion } from '../../src/core/criteria/ast';
import type { Description } from '../../src/core/desc/ast';

/**
 * The oracles for `src/core/criteria` (TDD §15.1). A hand is a list of cards
 * of any type `C` — two equal entries are two physical cards — and `fills` is
 * the one relation everything is defined over: whether a card can stand in a
 * slot, or counts against a limit, with that description. The tests choose
 * it: a random table for the expansion oracle, `implies` from a line for the
 * subsumption oracle.
 *
 * The two evaluators share no code with `expand`, nor with each other:
 * `satisfiesTree` walks the expression over bitmasks of hand positions, and
 * `satisfiesFlat` assigns cards to slots one at a time.
 */
export type Fills<C> = (card: C, desc: Description) => boolean;

/**
 * Every set of hand positions that can be left over once `expr` has taken the
 * cards it needs out of `available` (both as bitmasks); empty when `expr`
 * cannot be satisfied from `available`.
 */
function remainders<C>(
  expr: Expr,
  available: number,
  hand: readonly C[],
  fills: Fills<C>,
): Set<number> {
  switch (expr.op) {
    case 'req': {
      let fillers = 0;
      hand.forEach((card, position) => {
        if ((available & (1 << position)) !== 0 && fills(card, expr.desc)) fillers |= 1 << position;
      });
      // Every choice of `n` of them, not the first that works: a later
      // requirement may need exactly the card a greedy choice would take.
      const out = new Set<number>();
      for (let taken = fillers; ; taken = (taken - 1) & fillers) {
        if (popcount(taken) === expr.n) out.add(available & ~taken);
        if (taken === 0) break;
      }
      return out;
    }
    case 'atMost': {
      // A limit counts over the WHOLE hand, whatever has been taken, and takes nothing.
      const count = hand.filter((card) => fills(card, expr.desc)).length;
      return new Set(count <= expr.n ? [available] : []);
    }
    case 'and': {
      let states = new Set([available]);
      for (const arg of expr.args) {
        const next = new Set<number>();
        for (const state of states)
          for (const remainder of remainders(arg, state, hand, fills)) next.add(remainder);
        states = next;
      }
      return states;
    }
    case 'or': {
      const out = new Set<number>();
      for (const arg of expr.args)
        for (const remainder of remainders(arg, available, hand, fills)) out.add(remainder);
      return out;
    }
  }
}

function popcount(mask: number): number {
  let count = 0;
  for (let rest = mask; rest !== 0; rest &= rest - 1) count++;
  return count;
}

/**
 * The meaning of a criterion, read directly off its tree (PRD §5.3): for some
 * choice of one branch at every `or`, the requirements met on the way take
 * distinct cards and every limit met on the way holds. Hands of up to 30 cards.
 */
export function satisfiesTree<C>(expr: Expr, hand: readonly C[], fills: Fills<C>): boolean {
  return remainders(expr, 2 ** hand.length - 1, hand, fills).size > 0;
}

/**
 * The meaning of a flat criterion (TDD §10.1), by brute force: every limit
 * holds over the whole hand, and the requirement slots (`n×` is `n` slots)
 * can be given distinct cards, each filling its slot.
 */
export function satisfiesFlat<C>(flat: FlatCriterion, hand: readonly C[], fills: Fills<C>) {
  for (const { n, desc } of flat.limits)
    if (hand.filter((card) => fills(card, desc)).length > n) return false;

  const slots = flat.reqs.flatMap(({ n, desc }) => Array.from({ length: n }, () => desc));
  const used = hand.map(() => false);
  const assign = (slot: number): boolean => {
    if (slot === slots.length) return true;
    for (let position = 0; position < hand.length; position++) {
      if (used[position] || !fills(hand[position]!, slots[slot]!)) continue;
      used[position] = true;
      if (assign(slot + 1)) return true;
      used[position] = false;
    }
    return false;
  };
  return assign(0);
}

/** A hand succeeds when ANY flat criterion is satisfied; none at all never is. */
export function satisfiesAnyFlat<C>(
  flat: readonly FlatCriterion[],
  hand: readonly C[],
  fills: Fills<C>,
): boolean {
  return flat.some((criterion) => satisfiesFlat(criterion, hand, fills));
}

/** Every multiset of up to `maxSize` of `items`, as sorted lists; the empty hand included. */
export function multisets<T>(items: readonly T[], maxSize: number): T[][] {
  const out: T[][] = [];
  const extend = (hand: T[], from: number) => {
    out.push(hand);
    if (hand.length === maxSize) return;
    for (let i = from; i < items.length; i++) extend([...hand, items[i]!], i);
  };
  extend([], 0);
  return out;
}
