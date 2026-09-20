import { describe, expect, it } from 'vitest';
import { drawClassesOf, largestHand, longestPrefix } from '../../../src/core/model/problem';
import { drawSet, hasDrawCards, reachablePrefixes } from '../../../src/core/prob/draw-set';
import { createBlendScorer } from '../../../src/core/prob/scorer';
import { bit, drawProblem } from '../../helpers/draw-problem';

/** `1x` of the classes in `mask`; `stop` makes it one the player would stop for. */
const needs = (mask: number, over: Partial<{ stop: true; weight: number }> = {}) => ({
  slots: [mask],
  limits: [],
  ...over,
});

describe('reachablePrefixes', () => {
  it('is the opening hand alone when nothing draws', () => {
    expect(reachablePrefixes(5, [])).toEqual([5]);
  });

  it('is every length the copies can reach, ascending, the opening included', () => {
    const draws = drawClassesOf(
      drawProblem({
        n: [34, 3],
        H: 5,
        draw: { 1: { n: 2 } },
        criteria: [],
      }).classes,
    );
    // 0, 1, 2 or 3 copies of a draw-2: 5, 7, 9, 11.
    expect(reachablePrefixes(5, draws)).toEqual([5, 7, 9, 11]);
  });

  it('collapses to two lengths under once-per-turn: one copy resolves however many are held', () => {
    const draws = drawClassesOf(
      drawProblem({
        n: [34, 3],
        H: 5,
        draw: { 1: { n: 2, oncePerTurn: true } },
        criteria: [],
      }).classes,
    );
    expect(reachablePrefixes(5, draws)).toEqual([5, 7]);
  });

  it('leaves out a length whose draw cards would not fit in it', () => {
    // Four copies of a card that draws 1 need a prefix of at least four cards
    // to hold them, and `H + 4 = 5` only just does.
    const draws = drawClassesOf(
      drawProblem({
        n: [36, 4],
        H: 1,
        draw: { 1: { n: 1 } },
        criteria: [],
      }).classes,
    );
    expect(reachablePrefixes(1, draws)).toEqual([1, 2, 3, 4, 5]);
  });

  it('agrees with the two bounds: the first is the hand and the last is the longest prefix', () => {
    const draws = drawClassesOf(
      drawProblem({
        n: [30, 3, 3],
        H: 5,
        draw: { 1: { n: 2 }, 2: { n: 1 } },
        criteria: [],
      }).classes,
    );
    const lengths = reachablePrefixes(5, draws);
    expect(lengths[0]).toBe(5);
    expect(lengths.at(-1)).toBe(longestPrefix(5, draws));
    // 3 Pots (draw 2) and 3 Upstarts (draw 1): prefix 14, hand 8.
    expect(longestPrefix(5, draws)).toBe(14);
    expect(largestHand(5, draws)).toBe(8);
  });
});

describe('hasDrawCards', () => {
  const criteria = [needs(bit(1))];

  it('is false without draw cards, whatever the criteria say about stopping', () => {
    expect(hasDrawCards(drawProblem({ n: [5, 3], H: 2, criteria }))).toBe(false);
    expect(
      hasDrawCards(drawProblem({ n: [5, 3], H: 2, criteria: [needs(bit(1), { stop: true })] })),
    ).toBe(false);
  });

  /**
   * EVERY problem with a draw class takes the prefix route, whatever its
   * criteria say about stopping: a template whose every criterion would stop
   * still DRAWS when the opening meets none of them, so there is no template
   * with draw cards the plain success set can answer.
   */
  it('is true with draw cards, even when every criterion would stop the draws', () => {
    expect(hasDrawCards(drawProblem({ n: [5, 3], H: 2, draw: { 1: { n: 2 } }, criteria }))).toBe(
      true,
    );
    expect(
      hasDrawCards(
        drawProblem({
          n: [5, 3],
          H: 2,
          draw: { 1: { n: 2 } },
          criteria: [needs(bit(1), { stop: true })],
        }),
      ),
    ).toBe(true);
  });
});

describe('drawSet', () => {
  it('refuses a problem with no draw card, naming the route that scores it', () => {
    expect(() => drawSet(drawProblem({ n: [5, 3], H: 2, criteria: [needs(bit(1))] }), 2)).toThrow(
      /successSet/,
    );
  });

  describe('the parts', () => {
    const problem = drawProblem({
      n: [4, 2, 2],
      H: 2,
      draw: { 1: { n: 2 } },
      criteria: [needs(bit(2))],
    });

    it('is one per STRUCTURALLY reachable length, ascending', () => {
      expect(drawSet(problem, 2).parts.map(({ prefix }) => prefix)).toEqual([2, 4, 6]);
    });

    /**
     * The shape of a score has to be a property of the PROBLEM and not of the
     * ratio, or two decks of one run would have scores `compareScores` refuses
     * to compare. A length no hand of this deck succeeds at is still a part.
     */
    it('keeps a part that holds no row, so the shape does not move with the ratio', () => {
      // Four cards asked of a hand of two: NO composition of the opening can
      // meet it, and only the hand a draw-3 builds can. The shorter part is
      // still a part — the shape is the problem's, not the ratio's.
      const deep = drawProblem({
        n: [1, 1, 6],
        max: [1, 1, 6],
        H: 2,
        deckSize: 8,
        draw: { 1: { n: 3 } },
        criteria: [{ slots: [bit(2), bit(2), bit(2), bit(2)], limits: [] }],
      });
      const set = drawSet(deep, 2);
      expect(set.parts.map(({ prefix }) => prefix)).toEqual([2, 5]);
      expect(set.parts[0]!.groups).toEqual([]);
      expect(set.parts[0]!.terms).toBe(0);
      expect(set.parts[1]!.terms).toBeGreaterThan(0);
      expect(
        createBlendScorer(deep)
          .score([1, 1, 6])
          .parts.map(({ prefix, num }) => [prefix, num === 0]),
      ).toEqual([
        [2, true],
        [5, false],
      ]);
    });

    it('groups rows by the ORDERING FACTOR, not by the draw vector that produced it', () => {
      // Nothing is once-per-turn, so the factor is `H / ℓ` — one value per
      // length, however many draw vectors reach it.
      const set = drawSet(problem, 2);
      for (const part of set.parts) expect(part.groups).toHaveLength(1);
      expect(set.groups).toBe(3);
    });
  });

  /**
   * THE STANDING SELF-TEST. The reachable prefixes carry probability exactly 1,
   * and they do so only because deck-out is refused rather than modelled: a
   * template that could run out of cards would lose that mass, and the invariant
   * is what says so.
   */
  describe('mass', () => {
    const everyHand = { slots: [], limits: [] };
    const cases = [
      ['one draw class', [4, 2], { 1: { n: 2 } }, 2],
      ['once-per-turn', [4, 3], { 1: { n: 2, oncePerTurn: true } }, 2],
      ['two draw classes', [5, 2, 2], { 1: { n: 2 }, 2: { n: 1 } }, 2],
      ['a draw class of one card', [5, 1], { 1: { n: 3 } }, 2],
      ['five cards drawn, hand of one', [7, 2], { 1: { n: 2 } }, 1],
    ] as const;

    it.each(cases)('is 1 over every reachable length: %s', (_label, n, draw, H) => {
      const problem = drawProblem({ n: [...n], H, draw, criteria: [everyHand] });
      const { parts } = createBlendScorer(problem).score([...n]);
      const mass = parts.reduce((sum, { num, den }) => sum + num / den, 0);
      expect(mass).toBeCloseTo(1, 12);
      // And exactly, in integers: every part's fraction summed on one denominator.
      const common = parts.reduce((lcm, { den }) => {
        const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
        const at = BigInt(den);
        return (lcm / gcd(lcm, at)) * at;
      }, 1n);
      const total = parts.reduce(
        (sum, { num, den }) => sum + BigInt(num) * (common / BigInt(den)),
        0n,
      );
      expect(total).toBe(common);
    });
  });

  /**
   * The exactness of a draw score is checked when the SET is built, because
   * everything it depends on — the lcm of the ordering factors, and the largest
   * a group's sum can be — is a property of the problem and not of the deck. The
   * shape below is the one that put the rejected design 127× past 2^53.
   */
  describe('exactness', () => {
    const fiveOncePerTurnLines = () =>
      drawProblem({
        n: [25, 3, 3, 3, 3, 3],
        H: 5,
        draw: Object.fromEntries(
          [1, 2, 3, 4, 5].map((cls) => [cls, { n: 2, oncePerTurn: true as const }]),
        ),
        criteria: [needs(bit(1))],
      });

    it('refuses five once-per-turn draw-2 lines rather than round their score', () => {
      expect(() => drawSet(fiveOncePerTurnLines(), 5)).toThrow(
        /cannot be scored exactly.*once-per-turn/s,
      );
    });

    it('scores four of them, and every inner sum is a whole number', () => {
      const problem = drawProblem({
        n: [28, 3, 3, 3, 3],
        H: 5,
        draw: Object.fromEntries(
          [1, 2, 3, 4].map((cls) => [cls, { n: 2, oncePerTurn: true as const }]),
        ),
        criteria: [needs(bit(1))],
      });
      const { parts } = createBlendScorer(problem).score([28, 3, 3, 3, 3]);
      for (const { num, den } of parts) {
        expect(Number.isSafeInteger(num)).toBe(true);
        expect(Number.isSafeInteger(den)).toBe(true);
      }
    });
  });
});
