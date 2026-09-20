import type { DrawSpec } from '../model/problem';
import { copiesUsed } from '../model/problem';

/**
 * THE ORDERING FACTOR (PRD §5.7), which is the whole of what makes draw cards
 * exact rather than merely plausible.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NEEDED. A hand with draw cards is a PREFIX of the shuffled deck,
 * of length ℓ = the LEAST fixed point of `ℓ = H + draws(first ℓ)`. The obvious
 * model — the prefix MULTISET determines ℓ, so enumerate the multisets
 * consistent with it — is wrong, and not subtly: it gives probabilities above
 * 1 (measured 1.500, 1.762 and 2.095 on three small decks).
 *
 * ORDER MATTERS. Take one Pot of Greed (draws 2) and three blanks, H = 1:
 *
 *     [Pot, blank, blank]   the Pot is drawn, resolves, ℓ = 3
 *     [blank, Pot, blank]   a blank is drawn, nothing resolves, ℓ = 1
 *
 * the same multiset over the first three cards, two different hands. And the
 * second shows the fixed point is LEAST and not unique: `ℓ = 1 + draws(first ℓ)`
 * holds at both ℓ = 1 and ℓ = 3, and only 1 is what happens — so any solver but
 * upward iteration from `H` silently picks the wrong one.
 *
 * The fix is to count, for each consistent multiset, the share of its orderings
 * the process actually REACHES. Write the prefix as a Łukasiewicz path: start
 * with a budget of `H` cards to look at, and each card of position `t` either
 * spends one (a filler) or spends one and adds `n` (a draw card). The process
 * is still going after `t` cards exactly when the budget exceeds `t`, and the
 * prefix is the ordering's own if that holds at every `t < ℓ`.
 *
 * ---------------------------------------------------------------------------
 * TWO ROUTES, and the second exists because the first stops being true.
 *
 * With nothing ONCE-PER-TURN every copy of a draw class moves the budget the
 * same way, the path is the classical one, and the CYCLE LEMMA answers outright:
 * exactly `H` of the ℓ cyclic rotations of any such arrangement are valid, so
 *
 *     φ = H / ℓ
 *
 * exactly, whatever the multiset. Once-per-turn breaks it — the first copy
 * draws and the rest do not, so two copies of one class are not interchangeable
 * steps — and the closed form is then simply wrong: two copies of a
 * once-per-turn draw-2 with five fillers reach 20 of their 21 arrangements,
 * where `H / ℓ` claims 5/7. The arrangements are counted instead, by a DP
 * over the DRAW-CLASS counts alone: every non-draw class is one interchangeable
 * filler symbol, because a non-draw card moves the budget the same way whatever
 * class it is. So the factor depends on the draw classes and never on the rest
 * of the hand, and never on the deck — which is why it can be computed once per
 * problem and applied per deck as a constant.
 */

export interface Rational {
  num: bigint;
  den: bigint;
}

export function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function lcmBig(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcdBig(a, b)) * b;
}

/** `a / b` in lowest terms, with a positive denominator. */
export function reduced(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError('a rational cannot have a denominator of 0');
  if (num === 0n) return { num: 0n, den: 1n };
  const divisor = gcdBig(num, den);
  return { num: num / divisor, den: den / divisor };
}

/** The key two equal rationals share, so that groups can be merged by value. */
export const rationalKey = ({ num, den }: Rational): string => `${num}/${den}`;

/** `multinomial(Σ parts; parts)`: the arrangements of a multiset. */
export function multinomial(parts: readonly number[]): bigint {
  let out = 1n;
  let taken = 0n;
  for (const part of parts) {
    if (part < 0) throw new RangeError(`a multinomial counts whole parts, not ${part}`);
    // C(taken + part, part), built multiplicatively: every intermediate is a
    // binomial, so the division is always exact.
    let term = 1n;
    for (let i = 1n; i <= BigInt(part); i++) term = (term * (taken + i)) / i;
    taken += BigInt(part);
    out *= term;
  }
  return out;
}

/**
 * Arrangements of `take` draw copies and `fillers` fillers, placed after
 * `placed` cards of which the draw copies are `begun`, that keep the budget
 * above the position at every step — an exact count.
 *
 * Both factors below are this DP: φ starts at the top of the deck with nothing
 * begun, and ψ starts at position `H` with the opening's draw cards already in
 * hand. Memoized on (copies used, fillers used), which is all the budget and
 * the position depend on.
 */
function reachedCount(
  H: number,
  draws: readonly DrawSpec[],
  begun: readonly number[],
  placed: number,
  take: readonly number[],
  fillers: number,
): bigint {
  const total = fillers + take.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 1n;
  const memo = new Map<string, bigint>();
  const used = take.map(() => 0);
  const walk = (usedFillers: number, usedDraws: number): bigint => {
    const at = placed + usedFillers + usedDraws;
    if (usedFillers + usedDraws === total) return 1n;
    const key = `${used.join(',')}|${usedFillers}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let budget = H;
    for (let i = 0; i < draws.length; i++)
      budget += draws[i]!.n * copiesUsed(begun[i]! + used[i]!, draws[i]!);
    let out = 0n;
    // The process is still going after `at` cards exactly when the budget
    // exceeds them; once it stops, no arrangement of what is left is reached.
    if (budget > at) {
      for (let i = 0; i < take.length; i++) {
        if (used[i]! >= take[i]!) continue;
        used[i]!++;
        out += walk(usedFillers, usedDraws + 1);
        used[i]!--;
      }
      if (usedFillers < fillers) out += walk(usedFillers + 1, usedDraws);
    }
    memo.set(key, out);
    return out;
  };
  return walk(0, 0);
}

/**
 * φ: the share of the orderings of one consistent prefix that the process
 * reaches. `held` is the copies of each draw class the prefix holds and
 * `fillers` is everything else in it.
 *
 * `H / ℓ` by the cycle lemma wherever every copy draws — which is every
 * problem without once-per-turn, and every prefix of a once-per-turn problem
 * that holds at most one copy of each such class, since a lone copy is
 * indistinguishable from an ordinary draw card.
 */
export function prefixFactor(
  H: number,
  draws: readonly DrawSpec[],
  held: readonly number[],
  fillers: number,
): Rational {
  const prefix = fillers + held.reduce((sum, count) => sum + count, 0);
  if (prefix === 0) throw new RangeError('a prefix holds at least the cards of the opening hand');
  const repeated = draws.some((spec, i) => spec.oncePerTurn === true && held[i]! > 1);
  if (!repeated) return reduced(BigInt(H), BigInt(prefix));
  const begun = held.map(() => 0);
  return reduced(reachedCount(H, draws, begun, 0, held, fillers), multinomial([...held, fillers]));
}

/**
 * ψ: φ's generalisation for a prefix read as (the opening `H`, what came
 * after). `opening` and `extension` are the draw copies on each side and
 * `fillers` is everything else in the EXTENSION.
 *
 * The first `H` positions are unconstrained and so are not counted: the budget
 * starts at `H` and never falls, so it exceeds every `t < H` whatever stands
 * there. Validity bites only from position `H`, which is exactly what makes the
 * per-criterion STOP DECISION factor into a deck-independent constant.
 */
export function splitFactor(
  H: number,
  draws: readonly DrawSpec[],
  opening: readonly number[],
  extension: readonly number[],
  fillers: number,
): Rational {
  return reduced(
    reachedCount(H, draws, opening, H, extension, fillers),
    multinomial([...extension, fillers]),
  );
}
