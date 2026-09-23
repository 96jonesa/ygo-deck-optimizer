import type { Expr } from '../../src/core/criteria/ast';
import type { Description } from '../../src/core/desc/ast';
import { choose } from './combinatorics';
import { satisfiesTree } from './criteria-oracle';

/**
 * THE CARD-LEVEL ORACLE for a template (TDD §15.1): every hand the deck can
 * deal, as CONCRETE cards, judged by `satisfiesTree` straight off each
 * criterion's expression. It shares nothing with `expand`, classes, masks,
 * Hall's or Gale's conditions, the success set or the scorer — only the one
 * matching relation, `fills`, which the caller builds from `implies`.
 *
 * Every card is its IDENTITY: the value the caller gives its line. Two lines
 * naming one passcode give the same value, so their copies are copies of one
 * card — which is what a `unique` requirement refuses twice, and exactly the
 * thing classes have to get right.
 */
export interface OracleLine {
  /** Copies in the deck. The remainder is not listed: it is whatever is left. */
  copies: number;
  /** What the line's cards ARE: equal values are one card. */
  identity: string | number;
}

/**
 * `Σ Π C(copies, k)` over every hand of `H` cards — lines, then the remainder
 * holding what they leave — that meets ANY of `criteria`. An exact integer
 * over `C(deckSize, H)`, found by listing and nothing cleverer.
 *
 * `drawn`: the hand's last card is drawn apart, going second, so each hand is
 * `H` outcomes — one per card that could have been the one drawn — and the sum
 * is over `H · C(deckSize, H)`. The card drawn is put LAST, which is the window
 * `satisfiesTree` reads a `then` part over.
 */
export function cardLevelNumerator(
  lines: readonly OracleLine[],
  remainder: OracleLine,
  deckSize: number,
  H: number,
  criteria: readonly Expr[],
  fills: (identity: string | number, desc: Description) => boolean,
  drawn = false,
): number {
  const all = [
    ...lines,
    { ...remainder, copies: deckSize - lines.reduce((s, l) => s + l.copies, 0) },
  ];
  if (all.at(-1)!.copies < 0) throw new Error('the lines hold more cards than the deck');
  const held = all.map(() => 0);
  let sum = 0;
  const walk = (at: number, left: number): void => {
    if (at === all.length) {
      if (left !== 0) return;
      const ways = all.reduce((product, line, i) => product * choose(line.copies, held[i]!), 1);
      const handWith = (last: number | null) =>
        all.flatMap((line, i) =>
          new Array<string | number>(held[i]! - (i === last ? 1 : 0)).fill(line.identity),
        );
      const meets = (hand: (string | number)[]) =>
        criteria.some((expr) => satisfiesTree(expr, hand, fills));
      if (!drawn) {
        if (meets(handWith(null))) sum += ways;
        return;
      }
      all.forEach((line, i) => {
        if (held[i]! > 0 && meets([...handWith(i), line.identity])) sum += held[i]! * ways;
      });
      return;
    }
    for (let k = 0; k <= Math.min(all[at]!.copies, left); k++) {
      held[at] = k;
      walk(at + 1, left - k);
    }
    held[at] = 0;
  };
  walk(0, H);
  return sum;
}
