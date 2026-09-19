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
 * One way `expr` can have taken its cards: which hand positions are still
 * unassigned, and the descriptions of the CAPPED requirements it met on the
 * way. A capped requirement is one written `a-b×`, and no card left over at
 * the end may match any of them.
 */
interface Outcome {
  available: number;
  capped: readonly Description[];
}

/** The identity of an outcome: two that leave the same cards under the same caps are one. */
function outcomeKey({ available, capped }: Outcome): string {
  const keys = capped.map((desc) => JSON.stringify(desc)).sort();
  return `${available}|${keys.join(';')}`;
}

function collect(outcomes: Iterable<Outcome>): Outcome[] {
  const seen = new Map<string, Outcome>();
  for (const outcome of outcomes) seen.set(outcomeKey(outcome), outcome);
  return [...seen.values()];
}

/**
 * Every way `expr` can take the cards it needs out of `available` (a bitmask
 * of hand positions); empty when `expr` cannot be satisfied from `available`.
 */
function outcomesOf<C>(
  expr: Expr,
  available: number,
  hand: readonly C[],
  fills: Fills<C>,
): Outcome[] {
  switch (expr.op) {
    case 'req': {
      let fillers = 0;
      hand.forEach((card, position) => {
        if ((available & (1 << position)) !== 0 && fills(card, expr.desc)) fillers |= 1 << position;
      });
      // Every choice the range allows, not the first that works: a later
      // requirement may need exactly the card a greedy choice would take, and
      // a ceiling elsewhere may forbid taking as few as possible.
      const capped = expr.max === undefined ? [] : [expr.desc];
      const out: Outcome[] = [];
      for (let taken = fillers; ; taken = (taken - 1) & fillers) {
        const count = popcount(taken);
        if (count >= expr.n && count <= (expr.max ?? hand.length))
          out.push({ available: available & ~taken, capped });
        if (taken === 0) break;
      }
      return out;
    }
    case 'atMost': {
      // A limit counts over the WHOLE hand, whatever has been taken, and takes nothing.
      const count = hand.filter((card) => fills(card, expr.desc)).length;
      return count <= expr.n ? [{ available, capped: [] }] : [];
    }
    case 'and': {
      let states: Outcome[] = [{ available, capped: [] }];
      for (const arg of expr.args)
        states = collect(
          states.flatMap((state) =>
            outcomesOf(arg, state.available, hand, fills).map(
              (next): Outcome => ({
                available: next.available,
                capped: [...state.capped, ...next.capped],
              }),
            ),
          ),
        );
      return states;
    }
    case 'or':
      return collect(expr.args.flatMap((arg) => outcomesOf(arg, available, hand, fills)));
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
 * distinct cards — each a count within its own range — every limit met on the
 * way holds, and no card left over matches a requirement that has a ceiling.
 * Hands of up to 30 cards.
 *
 * Requirements are NOT merged here: `1x D and 1-2x D` stays two requirements,
 * and the unbounded one absorbs whatever the capped one cannot take. That is
 * the same meaning `expand` gives when it merges the pair into `2x D`, which
 * is what holding the two against each other checks.
 */
export function satisfiesTree<C>(expr: Expr, hand: readonly C[], fills: Fills<C>): boolean {
  return outcomesOf(expr, 2 ** hand.length - 1, hand, fills).some(({ available, capped }) =>
    hand.every(
      (card, position) =>
        (available & (1 << position)) === 0 || capped.every((desc) => !fills(card, desc)),
    ),
  );
}

/**
 * The meaning of a flat criterion (TDD §10.1), by brute force: every limit
 * holds over the whole hand, and the cards can be handed out so that every
 * requirement takes a count within `[n, max]` and every card left over matches
 * no requirement that has a ceiling.
 */
export function satisfiesFlat<C>(flat: FlatCriterion, hand: readonly C[], fills: Fills<C>) {
  for (const { n, desc } of flat.limits)
    if (hand.filter((card) => fills(card, desc)).length > n) return false;

  const taken = flat.reqs.map(() => 0);
  const capped = flat.reqs.filter(({ max }) => max !== undefined);
  const assign = (position: number): boolean => {
    if (position === hand.length) return flat.reqs.every(({ n }, at) => taken[at]! >= n);
    const card = hand[position]!;
    for (let at = 0; at < flat.reqs.length; at++) {
      const req = flat.reqs[at]!;
      if (taken[at]! >= (req.max ?? hand.length) || !fills(card, req.desc)) continue;
      taken[at]!++;
      const done = assign(position + 1);
      taken[at]!--;
      if (done) return true;
    }
    // Left over, which only a card no ceiling would have counted may be.
    return capped.every(({ desc }) => !fills(card, desc)) && assign(position + 1);
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
