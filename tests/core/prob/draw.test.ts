import { describe, expect, it } from 'vitest';
import type { DrawSpec } from '../../../src/core/model/problem';
import {
  gcdBig,
  lcmBig,
  multinomial,
  prefixFactor,
  type Rational,
  rationalKey,
  reduced,
  splitFactor,
} from '../../../src/core/prob/draw';
import { seededRng } from '../../helpers/prng';

/**
 * THE ORACLE for both factors, and it shares nothing with them: it lists every
 * arrangement of the prefix one symbol at a time and PLAYS IT OUT, exactly as a
 * player would — draw `H`, resolve what can be resolved, see how far down the
 * deck that took you. No path condition, no cycle lemma, no DP.
 *
 * `held[i]` is the copies of draw class `i`; the rest are interchangeable
 * fillers, written `-1`.
 */
function arrangements(held: readonly number[], fillers: number): number[][] {
  const symbols = [
    ...held.flatMap((count, cls) => Array.from({ length: count }, () => cls)),
    ...Array.from({ length: fillers }, () => -1),
  ];
  const out: number[][] = [];
  const used = symbols.map(() => false);
  const order: number[] = [];
  const walk = (): void => {
    if (order.length === symbols.length) {
      out.push([...order]);
      return;
    }
    const seen = new Set<number>();
    for (let at = 0; at < symbols.length; at++) {
      if (used[at] || seen.has(symbols[at]!)) continue;
      seen.add(symbols[at]!);
      used[at] = true;
      order.push(symbols[at]!);
      walk();
      order.pop();
      used[at] = false;
    }
  };
  walk();
  return out;
}

/**
 * Whether the process, drawing `H` and then resolving, sees EVERY card of this
 * arrangement — which is what "the prefix is this multiset, in this order"
 * means. Played out card by card, so the fixed point is reached and never
 * solved for.
 */
function reaches(H: number, draws: readonly DrawSpec[], order: readonly number[]): boolean {
  let budget = H;
  const usedOnce = new Set<number>();
  for (let at = 0; at < order.length; at++) {
    if (budget <= at) return false;
    const cls = order[at]!;
    if (cls < 0) continue;
    const spec = draws[cls]!;
    if (spec.oncePerTurn === true) {
      if (usedOnce.has(cls)) continue;
      usedOnce.add(cls);
    }
    budget += spec.n;
  }
  return budget === order.length;
}

/** The factor, counted by listing: valid arrangements over all of them. */
function byListing(
  H: number,
  draws: readonly DrawSpec[],
  held: number[],
  fillers: number,
): Rational {
  const all = arrangements(held, fillers);
  const good = all.filter((order) => reaches(H, draws, order)).length;
  return reduced(BigInt(good), BigInt(all.length));
}

const same = (a: Rational, b: Rational) => expect(rationalKey(a)).toBe(rationalKey(b));

describe('gcdBig', () => {
  it('is the greatest common divisor, sign and order aside', () => {
    expect(gcdBig(12n, 18n)).toBe(6n);
    expect(gcdBig(18n, 12n)).toBe(6n);
    expect(gcdBig(-12n, 18n)).toBe(6n);
    expect(gcdBig(0n, 7n)).toBe(7n);
    expect(gcdBig(7n, 0n)).toBe(7n);
  });
});

describe('lcmBig', () => {
  it('is the least common multiple, and 0 absorbs', () => {
    expect(lcmBig(4n, 6n)).toBe(12n);
    expect(lcmBig(1n, 9n)).toBe(9n);
    expect(lcmBig(0n, 9n)).toBe(0n);
  });
});

describe('reduced', () => {
  it('is lowest terms, and 0 is 0 / 1 whatever it was over', () => {
    same(reduced(6n, 8n), { num: 3n, den: 4n });
    same(reduced(0n, 97n), { num: 0n, den: 1n });
  });

  it('refuses a denominator of 0 rather than answer', () => {
    expect(() => reduced(1n, 0n)).toThrow(RangeError);
  });
});

describe('multinomial', () => {
  it('counts the arrangements of a multiset, and agrees with listing them', () => {
    expect(multinomial([])).toBe(1n);
    expect(multinomial([3])).toBe(1n);
    expect(multinomial([1, 1])).toBe(2n);
    expect(multinomial([2, 3])).toBe(10n);
    expect(multinomial([1, 1, 1, 2])).toBe(60n);
    for (const [held, fillers] of [
      [[2], 3],
      [[1, 2], 2],
      [[3], 2],
    ] as const)
      expect(multinomial([...held, fillers])).toBe(BigInt(arrangements([...held], fillers).length));
  });

  it('refuses a negative part', () => {
    expect(() => multinomial([2, -1])).toThrow(RangeError);
  });
});

describe('prefixFactor', () => {
  /**
   * THE CLOSED FORM. With nothing once-per-turn every copy of a draw class
   * moves the budget alike, and the cycle lemma gives `H / ℓ` outright — which
   * is a claim about every multiset, so it is checked against the listing over
   * a sweep of them and not on an example or two.
   */
  describe('without once-per-turn', () => {
    it('is H / ℓ, whatever the multiset', () => {
      const draws: DrawSpec[] = [{ n: 2 }, { n: 1 }];
      for (let H = 1; H <= 4; H++)
        for (let pots = 0; pots <= 3; pots++)
          for (let upstarts = 0; upstarts <= 3; upstarts++) {
            const prefix = H + 2 * pots + 1 * upstarts;
            const fillers = prefix - pots - upstarts;
            if (fillers < 0 || prefix > 9) continue;
            const held = [pots, upstarts];
            same(prefixFactor(H, draws, held, fillers), reduced(BigInt(H), BigInt(prefix)));
            same(prefixFactor(H, draws, held, fillers), byListing(H, draws, held, fillers));
          }
    });

    it('is 1 when the prefix is the opening hand itself', () => {
      same(prefixFactor(3, [{ n: 2 }], [0], 3), { num: 1n, den: 1n });
    });
  });

  /**
   * ONCE-PER-TURN BREAKS IT, and that is the whole reason the DP exists: the
   * first copy draws and the rest do not, so two copies of one class are not
   * interchangeable steps and the cycle lemma does not apply.
   */
  describe('with once-per-turn', () => {
    it('agrees with listing the arrangements, over a sweep of multisets', () => {
      const draws: DrawSpec[] = [{ n: 2, oncePerTurn: true }, { n: 1 }];
      let checked = 0;
      for (let H = 1; H <= 4; H++)
        for (let pots = 0; pots <= 3; pots++)
          for (let upstarts = 0; upstarts <= 2; upstarts++) {
            const prefix = H + 2 * Math.min(pots, 1) + upstarts;
            const fillers = prefix - pots - upstarts;
            if (fillers < 0 || prefix > 8) continue;
            const held = [pots, upstarts];
            same(prefixFactor(H, draws, held, fillers), byListing(H, draws, held, fillers));
            checked++;
          }
      expect(checked).toBeGreaterThan(20);
    });

    it('is NOT H / ℓ: two copies of a once-per-turn draw-2, and the gap is the feature', () => {
      // H = 5, two copies, five fillers, ℓ = 7. Only ONE copy resolves, so the
      // prefix is reached unless BOTH copies sit past position 5 — 20 of the 21
      // arrangements. The cycle lemma would claim 5/7, a third less.
      const draws: DrawSpec[] = [{ n: 2, oncePerTurn: true }];
      const counted = prefixFactor(5, draws, [2], 5);
      same(counted, byListing(5, draws, [2], 5));
      same(counted, { num: 20n, den: 21n });
      expect(Number(counted.num) / Number(counted.den)).toBeCloseTo(0.952381, 6);
      expect(5 / 7).toBeCloseTo(0.714286, 6);
    });

    it('is 0 for a multiset the process can never produce', () => {
      // Three once-per-turn copies still draw two, so a prefix of eight is not a
      // prefix this deck ever reaches — it is inconsistent, not merely unlikely.
      expect(prefixFactor(5, [{ n: 2, oncePerTurn: true }], [3], 5).num).toBe(0n);
    });

    it('falls back to the closed form when at most one copy is held: a lone copy is an ordinary draw card', () => {
      const draws: DrawSpec[] = [{ n: 2, oncePerTurn: true }];
      same(prefixFactor(5, draws, [1], 6), reduced(5n, 7n));
      same(prefixFactor(5, draws, [1], 6), byListing(5, draws, [1], 6));
    });
  });

  it('refuses an empty prefix', () => {
    expect(() => prefixFactor(0, [{ n: 2 }], [0], 0)).toThrow(RangeError);
  });
});

describe('splitFactor', () => {
  /**
   * ψ counts the EXTENSION's arrangements alone: the first `H` positions are
   * unconstrained, because the budget starts at `H` and never falls. Listing
   * checks that directly — the arrangements of the whole prefix that begin with
   * a given opening, over the arrangements of that opening's extension.
   */
  function byListingSplit(
    H: number,
    draws: readonly DrawSpec[],
    opening: number[],
    extension: number[],
    fillersAfter: number,
  ): Rational {
    const all = arrangements(extension, fillersAfter);
    // The opening's own order does not matter, so one of them stands for all.
    const before = opening.flatMap((count, cls) => Array.from({ length: count }, () => cls));
    while (before.length < H) before.push(-1);
    const good = all.filter((after) => reaches(H, draws, [...before, ...after])).length;
    return reduced(BigInt(good), BigInt(all.length));
  }

  it('agrees with listing, over a sweep of splits', () => {
    const draws: DrawSpec[] = [{ n: 2 }];
    let checked = 0;
    for (let H = 1; H <= 4; H++)
      for (let opened = 0; opened <= 2; opened++)
        for (let later = 0; later <= 2; later++) {
          const held = opened + later;
          const prefix = H + 2 * held;
          const fillersAfter = prefix - H - later;
          if (opened > H || fillersAfter < 0 || prefix > 9) continue;
          same(
            splitFactor(H, draws, [opened], [later], fillersAfter),
            byListingSplit(H, draws, [opened], [later], fillersAfter),
          );
          checked++;
        }
    expect(checked).toBeGreaterThan(15);
  });

  it('agrees with listing under once-per-turn, where the closed form does not exist', () => {
    const draws: DrawSpec[] = [{ n: 2, oncePerTurn: true }, { n: 2 }];
    const rng = seededRng(7);
    for (let trial = 0; trial < 40; trial++) {
      const H = rng.int(1, 3);
      const opening = [rng.int(0, 2), rng.int(0, 1)];
      const extension = [rng.int(0, 2), rng.int(0, 1)];
      const held = opening.map((count, at) => count + extension[at]!);
      const prefix = H + 2 * Math.min(held[0]!, 1) + 2 * held[1]!;
      const fillersAfter = prefix - H - extension.reduce((sum, count) => sum + count, 0);
      if (opening.reduce((sum, count) => sum + count, 0) > H) continue;
      if (fillersAfter < 0 || prefix > 8) continue;
      same(
        splitFactor(H, draws, opening, extension, fillersAfter),
        byListingSplit(H, draws, opening, extension, fillersAfter),
      );
    }
  });

  it('is 1 when nothing was drawn: the opening IS the prefix', () => {
    same(splitFactor(5, [{ n: 2 }], [0], [0], 0), { num: 1n, den: 1n });
  });

  it('is 0 when the extension exists and the opening drew nothing', () => {
    // Two cards after the opening, and no draw card among the first `H` to have
    // asked for them: the process never got there.
    expect(splitFactor(2, [{ n: 2 }], [0], [1], 1).num).toBe(0n);
  });

  /**
   * φ IS ψ SUMMED OVER THE OPENINGS, weighted by how many openings there are:
   * the two are one object read two ways, and this is the identity the mixed
   * route rests on.
   */
  it('sums back to prefixFactor over every way the opening could have held the draw cards', () => {
    const draws: DrawSpec[] = [{ n: 2 }];
    for (const [H, held] of [
      [3, 1],
      [3, 2],
      [4, 2],
    ] as const) {
      const prefix = H + 2 * held;
      const fillers = prefix - held;
      let total = 0;
      for (let opened = 0; opened <= Math.min(held, H); opened++) {
        const later = held - opened;
        const fillersOpen = H - opened;
        const fillersAfter = prefix - H - later;
        if (fillersOpen < 0 || fillersAfter < 0) continue;
        const psi = splitFactor(H, draws, [opened], [later], fillersAfter);
        // The openings with this many draw cards, as a share of all openings.
        const openings = Number(multinomial([opened, fillersOpen]));
        const extensions = Number(multinomial([later, fillersAfter]));
        const whole = Number(multinomial([held, fillers]));
        total += (Number(psi.num) / Number(psi.den)) * ((openings * extensions) / whole);
      }
      const phi = prefixFactor(H, draws, [held], fillers);
      expect(total).toBeCloseTo(Number(phi.num) / Number(phi.den), 12);
    }
  });
});
