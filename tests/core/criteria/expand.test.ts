import { describe, expect, it } from 'vitest';
import { type Expr, type FlatCriterion, MAX_RANGES } from '../../../src/core/criteria/ast';
import { expand, expandAll, MAX_FLAT_CRITERIA } from '../../../src/core/criteria/expand';
import type { Description } from '../../../src/core/desc/ast';
import { same } from '../../helpers/assert';
import { type Fills, satisfiesAnyFlat, satisfiesTree } from '../../helpers/criteria-oracle';
import { genExpr } from '../../helpers/gen-criteria';
import { type Rng, seededRng } from '../../helpers/prng';

/** An opaque description: expansion only ever compares descriptions, it never reads them. */
function card(passcode: number): Description {
  return { anyOf: [{ t: 'card', passcode }] };
}

const [A, B, C, D] = [card(1), card(2), card(3), card(4)] as [
  Description,
  Description,
  Description,
  Description,
];

function req(n: number, desc: Description): Expr {
  return { op: 'req', n, desc };
}

/** `a-b×`: a requirement with a ceiling. */
function range(n: number, max: number, desc: Description): Expr {
  return { op: 'req', n, max, desc };
}

/** `n× unique`: `n` DIFFERENT cards. */
function unique(n: number, desc: Description): Expr {
  return { op: 'req', n, unique: true, desc };
}

function atMost(n: number, desc: Description): Expr {
  return { op: 'atMost', n, desc };
}

function and(...args: Expr[]): Expr {
  return { op: 'and', args };
}

function or(...args: Expr[]): Expr {
  return { op: 'or', args };
}

const HAND = { maxHandSize: 6 };

/** The flat criteria of an expansion that must succeed. */
function flatOf(expr: Expr, opts = HAND): FlatCriterion[] {
  const result = expand(expr, opts);
  if (!result.ok) throw new Error(result.message);
  return result.flat;
}

/**
 * Two flat criteria that ask the same, in whatever order, share this string —
 * written here rather than taken from `expand`, so the source oracle owes
 * nothing to the merging it is checking.
 */
function identity({ reqs, limits }: FlatCriterion): string {
  const sorted = (parts: string[]) => [...parts].sort().join(';');
  return [
    sorted(reqs.map(({ n, max, desc }) => `${n}-${max ?? ''}:${JSON.stringify(desc)}`)),
    sorted(limits.map(({ n, desc }) => `${n}:${JSON.stringify(desc)}`)),
  ].join('|');
}

/** `k` two-way choices between distinct cards, all required: 2^k alternatives of `k` slots. */
function productOfChoices(k: number): Expr {
  return and(
    ...Array.from({ length: k }, (_, i) => or(req(1, card(2 * i)), req(1, card(2 * i + 1)))),
  );
}

it('pins the cap', () => {
  expect(MAX_FLAT_CRITERIA).toBe(256);
});

describe('expand', () => {
  it('turns a leaf into one flat criterion', () => {
    expect(expand(req(2, A), HAND)).toEqual({
      ok: true,
      flat: [{ reqs: [{ n: 2, desc: A }], limits: [] }],
      sources: [[0]],
      dropped: 0,
    });
    expect(flatOf(atMost(1, A))).toEqual([{ reqs: [], limits: [{ n: 1, desc: A }] }]);
  });

  it('expands the PRD example to exactly its two alternatives', () => {
    // 1x A and 1x B and (1x C or 2x D)
    expect(flatOf(and(req(1, A), req(1, B), or(req(1, C), req(2, D))))).toEqual([
      {
        reqs: [
          { n: 1, desc: A },
          { n: 1, desc: B },
          { n: 1, desc: C },
        ],
        limits: [],
      },
      {
        reqs: [
          { n: 1, desc: A },
          { n: 1, desc: B },
          { n: 2, desc: D },
        ],
        limits: [],
      },
    ]);
  });

  it('distributes and over or in written order, first choice outermost', () => {
    const flat = flatOf(and(or(req(1, A), req(1, B)), or(req(1, C), req(1, D))));
    expect(flat.map((f) => f.reqs.map((r) => r.desc))).toEqual([
      [A, C],
      [A, D],
      [B, C],
      [B, D],
    ]);
  });

  it('expands or inside and inside or', () => {
    const flat = flatOf(or(req(1, A), and(req(1, B), or(req(1, C), req(2, D)))));
    expect(flat.map((f) => f.reqs)).toEqual([
      [{ n: 1, desc: A }],
      [
        { n: 1, desc: B },
        { n: 1, desc: C },
      ],
      [
        { n: 1, desc: B },
        { n: 2, desc: D },
      ],
    ]);
  });

  describe('merging within a flat criterion', () => {
    it('sums the counts of requirements with the same description: they need distinct cards', () => {
      expect(flatOf(and(req(1, A), req(1, A)))).toEqual([
        { reqs: [{ n: 2, desc: A }], limits: [] },
      ]);
      expect(flatOf(and(req(1, A), req(1, B), req(2, A)))[0]!.reqs).toEqual([
        { n: 3, desc: A },
        { n: 1, desc: B },
      ]);
    });

    it('sums across the branches a requirement is distributed into', () => {
      const flat = flatOf(and(req(1, A), or(req(1, A), req(1, B))));
      expect(flat.map((f) => f.reqs)).toEqual([
        [{ n: 2, desc: A }],
        [
          { n: 1, desc: A },
          { n: 1, desc: B },
        ],
      ]);
    });

    it('adds the ceilings of two ranges on the same description', () => {
      expect(flatOf(and(range(1, 2, A), range(1, 2, A)))).toEqual([
        { reqs: [{ n: 2, max: 4, desc: A }], limits: [] },
      ]);
      expect(flatOf(and(range(0, 1, A), range(2, 3, A)))[0]!.reqs).toEqual([
        { n: 2, max: 4, desc: A },
      ]);
    });

    it('lets an unbounded requirement void the ceiling: it absorbs the surplus', () => {
      expect(flatOf(and(req(1, A), range(1, 2, A)))).toEqual([
        { reqs: [{ n: 2, desc: A }], limits: [] },
      ]);
      // Whichever way round they are written.
      expect(flatOf(and(range(1, 2, A), req(1, A)))[0]!.reqs).toEqual([{ n: 2, desc: A }]);
    });

    it('keeps two ranges on DIFFERENT descriptions apart', () => {
      expect(flatOf(and(range(1, 2, A), range(1, 2, B)))[0]!.reqs).toEqual([
        { n: 1, max: 2, desc: A },
        { n: 1, max: 2, desc: B },
      ]);
    });

    it('keeps `0-b` rather than dropping it as a requirement of no cards', () => {
      expect(flatOf(range(0, 2, A))).toEqual([{ reqs: [{ n: 0, max: 2, desc: A }], limits: [] }]);
      // A plain `0x` still asks for nothing and goes.
      expect(flatOf(req(0, A))).toEqual([{ reqs: [], limits: [] }]);
    });

    it('tells two alternatives apart by their ceilings, not only their counts', () => {
      const result = expand(or(range(1, 2, A), range(1, 3, A), req(1, A)), HAND);
      expect(result.ok && result.flat).toEqual([
        { reqs: [{ n: 1, max: 2, desc: A }], limits: [] },
        { reqs: [{ n: 1, max: 3, desc: A }], limits: [] },
        { reqs: [{ n: 1, desc: A }], limits: [] },
      ]);
    });

    it('keeps the tighter of two limits with the same description', () => {
      expect(flatOf(and(atMost(2, A), atMost(1, A), atMost(3, A)))).toEqual([
        { reqs: [], limits: [{ n: 1, desc: A }] },
      ]);
    });

    it('compares descriptions structurally, whatever their key order, and never semantically', () => {
      const written: Description = {
        anyOf: [{ t: 'clause', clause: { level: [4], kinds: ['monster'] } }],
      };
      const reordered: Description = {
        anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [4, 4] } }],
      };
      // The same cards as `A or B`, but alternatives keep their written order (TDD §5.1).
      const flat = flatOf(
        and(
          req(1, written),
          req(1, reordered),
          req(1, { anyOf: [...A.anyOf, ...B.anyOf] }),
          req(1, { anyOf: [...B.anyOf, ...A.anyOf] }),
        ),
      );
      expect(flat[0]!.reqs.map((r) => r.n)).toEqual([2, 1, 1]);
    });

    it('never merges a requirement with a limit', () => {
      expect(flatOf(and(req(1, A), atMost(1, A)))).toEqual([
        { reqs: [{ n: 1, desc: A }], limits: [{ n: 1, desc: A }] },
      ]);
    });

    it('treats a requirement of no cards as no requirement', () => {
      expect(flatOf(and(req(0, A), req(1, B)))).toEqual([
        { reqs: [{ n: 1, desc: B }], limits: [] },
      ]);
    });
  });

  it('carries a limit into every branch it is anded with, and into no other', () => {
    // 1x A and ((1x B and no C) or 1x D), at most 1x D over all of it
    const flat = flatOf(and(req(1, A), or(and(req(1, B), atMost(0, C)), req(1, D)), atMost(1, D)));
    expect(flat).toEqual([
      {
        reqs: [
          { n: 1, desc: A },
          { n: 1, desc: B },
        ],
        limits: [
          { n: 0, desc: C },
          { n: 1, desc: D },
        ],
      },
      {
        reqs: [
          { n: 1, desc: A },
          { n: 1, desc: D },
        ],
        limits: [{ n: 1, desc: D }],
      },
    ]);
  });

  describe('unique requirements', () => {
    it('carries `unique` into the flat criterion, between the count and the description', () => {
      const [flat] = flatOf(unique(3, A));
      expect(JSON.stringify(flat)).toBe(
        JSON.stringify({ reqs: [{ n: 3, unique: true, desc: A }], limits: [] }),
      );
    });

    it('never merges two on one description: they are not one of their sum', () => {
      // `2x unique A and 1x unique A` lets the second take another copy of a card
      // the first holds, which `3x unique A` forbids.
      expect(flatOf(and(unique(2, A), unique(1, A)))).toEqual([
        {
          reqs: [
            { n: 2, unique: true, desc: A },
            { n: 1, unique: true, desc: A },
          ],
          limits: [],
        },
      ]);
    });

    it('never merges one with a plain requirement on the same description, either way round', () => {
      expect(flatOf(and(unique(2, A), req(1, A)))[0]!.reqs).toEqual([
        { n: 2, unique: true, desc: A },
        { n: 1, desc: A },
      ]);
      // The two plain ones still merge with each other, around it.
      expect(flatOf(and(req(1, A), unique(2, A), req(1, A)))[0]!.reqs).toEqual([
        { n: 2, desc: A },
        { n: 2, unique: true, desc: A },
      ]);
    });

    it('counts its cards toward what the hand must hold, and drops what cannot fit', () => {
      expect(expand(and(unique(4, A), req(3, B)), { maxHandSize: 6 })).toMatchObject({
        flat: [],
        dropped: 1,
      });
      expect(flatOf(and(unique(3, A), req(3, B)))).toHaveLength(1);
    });

    it('is one alternative however its unique requirements were ordered, and two when they differ', () => {
      expect(
        flatOf(or(and(unique(1, A), unique(2, A)), and(unique(2, A), unique(1, A)))),
      ).toHaveLength(1);
      expect(flatOf(or(unique(2, A), req(2, A)))).toHaveLength(2);
      expect(flatOf(or(and(unique(1, A), unique(1, A)), unique(2, A)))).toHaveLength(2);
    });
  });

  describe('a split criterion', () => {
    const split = (five: Expr | undefined, sixth: Expr): Expr =>
      five === undefined ? { op: 'split', sixth } : { op: 'split', five, sixth };

    it('keeps the two sides apart, each merged on its own', () => {
      expect(flatOf(split(and(req(1, A), req(1, A)), atMost(0, B)))).toEqual([
        { reqs: [{ n: 2, desc: A }], limits: [], sixth: { reqs: [], limits: [{ n: 0, desc: B }] } },
      ]);
    });

    it('does not merge across then: the five and the one drawn are different cards', () => {
      // `1x A then 1x A` needs an A among the five AND an A drawn, which is two
      // A's — but the two requirements are about different windows, so neither
      // side sums.
      expect(flatOf(split(req(1, A), req(1, A)))).toEqual([
        { reqs: [{ n: 1, desc: A }], limits: [], sixth: { reqs: [{ n: 1, desc: A }], limits: [] } },
      ]);
    });

    it('is the product of the two sides distributed, in reading order', () => {
      expect(flatOf(split(or(req(1, A), req(1, B)), or(req(1, C), req(1, D))))).toEqual([
        { reqs: [{ n: 1, desc: A }], limits: [], sixth: { reqs: [{ n: 1, desc: C }], limits: [] } },
        { reqs: [{ n: 1, desc: A }], limits: [], sixth: { reqs: [{ n: 1, desc: D }], limits: [] } },
        { reqs: [{ n: 1, desc: B }], limits: [], sixth: { reqs: [{ n: 1, desc: C }], limits: [] } },
        { reqs: [{ n: 1, desc: B }], limits: [], sixth: { reqs: [{ n: 1, desc: D }], limits: [] } },
      ]);
    });

    it('carries an empty five-card part as an alternative that asks nothing of it', () => {
      expect(flatOf(split(undefined, req(1, A)))).toEqual([
        { reqs: [], limits: [], sixth: { reqs: [{ n: 1, desc: A }], limits: [] } },
      ]);
    });

    it('counts two alternatives as one only when BOTH sides agree', () => {
      const same5 = split(or(req(1, A), req(1, A)), req(1, B));
      expect(flatOf(same5)).toHaveLength(1);
      // The same five, two different cards drawn: two alternatives.
      expect(flatOf(split(req(1, A), or(req(1, B), req(1, C))))).toHaveLength(2);
    });

    it('drops a five-card part that needs more than the hand less the card drawn', () => {
      // At a hand of 6, the five you open on are five: `6x A` can never hold
      // there, while `5x A` can.
      expect(expand(split(req(5, A), req(1, B)), HAND)).toMatchObject({ ok: true, dropped: 0 });
      expect(expand(split(req(6, A), req(1, B)), HAND)).toMatchObject({
        ok: true,
        flat: [],
        dropped: 1,
      });
      // An unsplit criterion still gets all six.
      expect(expand(and(req(6, A)), HAND)).toMatchObject({ ok: true, dropped: 0 });
    });

    it('refuses more than one card of the drawn set, as an error and not a drop', () => {
      // A hand-written AST bypasses the parser's own check, so expansion keeps
      // one: a silent zero is exactly what this must not become.
      expect(expandAll([{ op: 'split', sixth: and(req(1, A), req(1, B)) }], HAND)).toEqual({
        ok: false,
        reason: 'sixth-card',
        message:
          'the card you draw is one card, and this asks 2 of it: after `then`, write one requirement — `1x …` — or limits alone, as in `no trap`. Mark a line as drawing cards and `then` becomes about everything you drew, which can be more than one',
      });
      // And merging is what can make it two: `1x A and 1x A` asks for two cards.
      expect(expandAll([{ op: 'split', sixth: and(req(1, A), req(1, A)) }], HAND)).toMatchObject({
        ok: false,
        reason: 'sixth-card',
      });
    });

    /**
     * With DRAW CARDS the drawn set is the card drawn for turn plus everything
     * they fetched (`largestDrawnSet`), so the bound the same alternative is
     * held to moves — and with it what a ceiling there can bind against.
     */
    describe('when draw cards widen the drawn set', () => {
      const DRAWING = { ...HAND, maxDrawnSlots: 3 };

      it('accepts what the drawn set can hold, and still refuses what it cannot', () => {
        expect(
          expandAll([{ op: 'split', sixth: and(req(1, A), req(1, B)) }], DRAWING),
        ).toMatchObject({ ok: true });
        expect(expandAll([{ op: 'split', sixth: req(4, A) }], DRAWING)).toMatchObject({
          ok: false,
          reason: 'sixth-card',
        });
      });

      it('says how many cards there are to ask of, not that there is one', () => {
        const refused = expandAll([{ op: 'split', sixth: req(4, A) }], DRAWING);
        if (refused.ok) throw new Error('expected a refusal');
        expect(refused.message).toContain('you draw at most 3 cards here');
        expect(refused.message).not.toContain('one card');
      });

      /**
       * DRAW CARDS PULL THE TWO SIZES APART: `maxHandSize` becomes the hand
       * they can BUILD, while the cards opened on are five however deep the
       * prefix goes. An opening part asking for six is then unmeetable, and has
       * to be DROPPED and counted — left to follow `maxHandSize` it would
       * survive and score zero on every hand, which is the one outcome this
       * file exists to avoid.
       */
      it('drops an alternative the opening five cannot hold, though the hand could', () => {
        const wide = { maxHandSize: 9, maxOpenedSize: 5, maxDrawnSlots: 3 };
        const six: Expr = { op: 'split', five: req(6, A), sixth: req(1, B) };
        expect(expandAll([six], wide)).toMatchObject({ ok: true, flat: [], dropped: 1 });
        // Five fits, so the bound is the opening's and not an off-by-one.
        expect(
          expandAll([{ op: 'split', five: req(5, A), sixth: req(1, B) } as Expr], wide),
        ).toMatchObject({ ok: true, dropped: 0 });
        // And an UNSPLIT criterion still gets the whole hand the draws build.
        expect(expandAll([req(9, A)], wide)).toMatchObject({ ok: true, dropped: 0 });
      });

      /**
       * A ceiling counts against `MAX_RANGES` only where it can BIND, and on
       * ONE card a ceiling of 1 never can — the drawn set holds one card, so
       * `0-1x` is free. Widen it and the same ceilings start costing, which is
       * the bound reaching a different answer about the same text rather than a
       * second rule about draw cards.
       */
      it('starts counting ceilings on the drawn set that one card could never break', () => {
        const ceilings = Array.from({ length: MAX_RANGES + 1 }, (_, at) =>
          range(0, 1, card(100 + at)),
        );
        const split: Expr = { op: 'split', sixth: and(...ceilings) };
        expect(expandAll([split], HAND)).toMatchObject({ ok: true });
        expect(expandAll([split], DRAWING)).toMatchObject({ ok: false, reason: 'ranges' });
      });
    });

    it('never lets a split stand below the root', () => {
      const nested = and(req(1, A), { op: 'split', sixth: req(1, B) } as Expr);
      expect(() => expandAll([nested], HAND)).toThrow(/only at the root/);
    });

    it('says which criteria a shared split alternative came from', () => {
      const one = split(req(1, A), req(1, B));
      const two = split(or(req(1, A), req(1, C)), req(1, B));
      const result = expandAll([one, two], HAND);
      if (!result.ok) throw new Error(result.message);
      expect(result.sources).toEqual([[0, 1], [1]]);
    });
  });

  describe('a `finally` part', () => {
    type Split = Extract<Expr, { op: 'split' }>;
    const parts = (over: Omit<Split, 'op'>): Expr => ({ op: 'split', ...over });

    it('keeps all three windows apart, each merged on its own', () => {
      expect(
        flatOf(
          parts({
            five: and(req(1, A), req(1, A)),
            sixth: atMost(0, B),
            whole: and(req(1, C), req(1, C)),
          }),
        ),
      ).toEqual([
        {
          reqs: [{ n: 2, desc: A }],
          limits: [],
          sixth: { reqs: [], limits: [{ n: 0, desc: B }] },
          whole: { reqs: [{ n: 2, desc: C }], limits: [] },
        },
      ]);
    });

    it('does not merge across `finally`: one card answers both parts', () => {
      // `1x A finally 1x A` asks for an A among the five and an A in the hand —
      // which the SAME card answers, since assignment does not span windows. So
      // neither side sums, exactly as neither side of a `then` does.
      expect(flatOf(parts({ five: req(1, A), whole: req(1, A) }))).toEqual([
        { reqs: [{ n: 1, desc: A }], limits: [], whole: { reqs: [{ n: 1, desc: A }], limits: [] } },
      ]);
    });

    it('is the product of every part distributed, in reading order', () => {
      expect(
        flatOf(parts({ five: or(req(1, A), req(1, B)), whole: or(req(1, C), req(1, D)) })),
      ).toEqual([
        { reqs: [{ n: 1, desc: A }], limits: [], whole: { reqs: [{ n: 1, desc: C }], limits: [] } },
        { reqs: [{ n: 1, desc: A }], limits: [], whole: { reqs: [{ n: 1, desc: D }], limits: [] } },
        { reqs: [{ n: 1, desc: B }], limits: [], whole: { reqs: [{ n: 1, desc: C }], limits: [] } },
        { reqs: [{ n: 1, desc: B }], limits: [], whole: { reqs: [{ n: 1, desc: D }], limits: [] } },
      ]);
    });

    it('carries an empty five-card part as an alternative that asks nothing of it', () => {
      expect(flatOf(parts({ whole: req(1, A) }))).toEqual([
        { reqs: [], limits: [], whole: { reqs: [{ n: 1, desc: A }], limits: [] } },
      ]);
    });

    /**
     * A `finally` part makes the criterion SPLIT even with no `then`, so its own
     * part is judged over the cards OPENED ON — which is the whole reading the
     * clause exists to make writable, and the one thing here most easily lost.
     */
    it('judges its own part over the cards opened on, `then` or no `then`', () => {
      expect(expand(parts({ five: req(5, A), whole: req(1, B) }), HAND)).toMatchObject({
        ok: true,
        dropped: 0,
      });
      expect(expand(parts({ five: req(6, A), whole: req(1, B) }), HAND)).toMatchObject({
        ok: true,
        flat: [],
        dropped: 1,
      });
      // Where the very same text without the `finally` gets all six cards.
      expect(expand(req(6, A), HAND)).toMatchObject({ ok: true, dropped: 0 });
    });

    /**
     * Its OWN window is the whole hand, so it is bounded as an unsplit criterion
     * is — DROPPED and counted, never refused. `then` is the one part refused on
     * the text, because the drawn set can never hold more than the draw cards
     * fetch, where the whole hand is simply the hand.
     */
    it('drops a `finally` part the hand cannot hold, rather than refusing it', () => {
      expect(expand(parts({ five: req(1, A), whole: req(6, B) }), HAND)).toMatchObject({
        ok: true,
        dropped: 0,
      });
      expect(expand(parts({ five: req(1, A), whole: req(7, B) }), HAND)).toMatchObject({
        ok: true,
        flat: [],
        dropped: 1,
      });
      // The same shape of ask, unsplit, is dropped in the same way.
      expect(expand(req(7, B), HAND)).toMatchObject({ ok: true, flat: [], dropped: 1 });
      // And `then` asking too much is an ERROR, which is the difference.
      expect(expandAll([parts({ sixth: and(req(1, A), req(1, B)) })], HAND)).toMatchObject({
        ok: false,
        reason: 'sixth-card',
      });
    });

    /** Its ceilings count against `MAX_RANGES` against the WHOLE hand's room. */
    it('counts a ceiling on the whole hand that six cards could break', () => {
      const ceilings = Array.from({ length: MAX_RANGES + 1 }, (_, at) =>
        range(0, 1, card(200 + at)),
      );
      expect(expandAll([parts({ whole: and(...ceilings) })], HAND)).toMatchObject({
        ok: false,
        reason: 'ranges',
      });
      // A ceiling of six can never bind on six cards, so it costs nothing.
      const free = Array.from({ length: MAX_RANGES + 1 }, (_, at) => range(0, 6, card(300 + at)));
      expect(expandAll([parts({ whole: and(...free) })], HAND)).toMatchObject({ ok: true });
    });

    it('never lets a split stand below the root, `finally` part included', () => {
      const nested = parts({ whole: and(req(1, A), parts({ whole: req(1, B) })) });
      expect(() => expandAll([nested], HAND)).toThrow(/only at the root/);
    });

    /**
     * A split that asks NOTHING of the cards drawn and nothing of the whole hand
     * would flatten to an alternative nothing downstream could tell from an
     * UNSPLIT one — and would then be judged over five cards here and six there.
     * No text writes it and `validateExpr` refuses it; this is the backstop.
     */
    it('refuses a split with neither a drawn part nor a whole-hand part', () => {
      expect(() => expandAll([{ op: 'split' } as Expr], HAND)).toThrow(/asks something/);
    });

    it('counts two alternatives as one only when EVERY window agrees', () => {
      expect(flatOf(parts({ five: req(1, A), whole: or(req(1, B), req(1, B)) }))).toHaveLength(1);
      expect(flatOf(parts({ five: req(1, A), whole: or(req(1, B), req(1, C)) }))).toHaveLength(2);
      // And an unsplit alternative is never the same as a split one asking the
      // same thing: the first window is a different window.
      const split = expand(parts({ five: req(1, A), whole: req(1, B) }), HAND);
      const unsplit = expand(and(req(1, A), req(1, B)), HAND);
      if (!split.ok || !unsplit.ok) throw new Error('expansion failed');
      expect(split.flat).not.toEqual(unsplit.flat);
      const together = expandAll(
        [parts({ five: req(1, A), whole: req(1, B) }), and(req(1, A), req(1, B))],
        HAND,
      );
      expect(together).toMatchObject({ ok: true, sources: [[0], [1]] });
    });
  });

  describe('dropping what the hand cannot hold', () => {
    it('drops an alternative with more slots than cards in the hand, and counts it', () => {
      const expr = or(req(1, A), and(req(3, B), req(3, C)), and(req(2, B), req(3, C)));
      expect(expand(expr, { maxHandSize: 5 })).toEqual({
        ok: true,
        flat: [
          { reqs: [{ n: 1, desc: A }], limits: [] },
          {
            reqs: [
              { n: 2, desc: B },
              { n: 3, desc: C },
            ],
            limits: [],
          },
        ],
        sources: [[0], [0]],
        dropped: 1,
      });
      expect(expand(expr, { maxHandSize: 6 })).toMatchObject({ dropped: 0 });
      expect(expand(expr, { maxHandSize: 4 })).toMatchObject({ dropped: 2 });
    });

    it('counts slots after merging', () => {
      expect(expand(and(req(3, A), req(3, A)), { maxHandSize: 5 })).toEqual({
        ok: true,
        flat: [],
        sources: [],
        dropped: 1,
      });
    });

    it('is still ok when every alternative is dropped: the caller warns', () => {
      expect(expand(and(req(3, A), req(3, B)), { maxHandSize: 5 })).toEqual({
        ok: true,
        flat: [],
        sources: [],
        dropped: 1,
      });
    });

    it('never drops for its limits, however many cards they mention', () => {
      expect(expand(and(atMost(40, A), atMost(40, B)), { maxHandSize: 5 })).toMatchObject({
        flat: [{ reqs: [] }],
        dropped: 0,
      });
    });

    it('counts only the LOWER bounds of ranges: `0-2x` asks for no card', () => {
      const wide = and(range(0, 2, A), range(0, 2, B), range(0, 2, C), range(0, 2, D));
      expect(expand(wide, { maxHandSize: 2 })).toMatchObject({ dropped: 0 });
      // Lower bounds still add up and still drop.
      expect(expand(and(range(3, 4, A), range(3, 4, B)), { maxHandSize: 5 })).toMatchObject({
        flat: [],
        dropped: 1,
      });
    });
  });

  describe('the cap on range requirements', () => {
    /** `n` ranges on distinct descriptions, each a ceiling that can bind at a hand of 6. */
    const ranges = (n: number) => and(...Array.from({ length: n }, (_, i) => range(0, 1, card(i))));

    it(`accepts exactly ${MAX_RANGES} ranges that can bind`, () => {
      expect(expand(ranges(MAX_RANGES), HAND).ok).toBe(true);
    });

    it('refuses one more, with a message that names the cap', () => {
      expect(expand(ranges(MAX_RANGES + 1), HAND)).toEqual({
        ok: false,
        reason: 'ranges',
        message: expect.stringContaining(String(MAX_RANGES)),
      });
    });

    it('does not count a ceiling that can never bind: the hand is not that large', () => {
      // `0-6x` at a hand of 6 can never be exceeded, so it costs the engine nothing.
      const wide = and(...Array.from({ length: MAX_RANGES + 5 }, (_, i) => range(0, 6, card(i))));
      expect(expand(wide, HAND).ok).toBe(true);
    });

    it('is an error and not a drop: the alternative is judged or it is not', () => {
      const result = expand(or(req(1, A), ranges(MAX_RANGES + 1)), HAND);
      expect(result.ok).toBe(false);
    });
  });

  describe('duplicate alternatives', () => {
    it('removes a repeated alternative, keeping the first', () => {
      expect(flatOf(or(req(1, A), req(1, B), req(1, A)))).toEqual([
        { reqs: [{ n: 1, desc: A }], limits: [] },
        { reqs: [{ n: 1, desc: B }], limits: [] },
      ]);
    });

    it('ignores the order of requirements and of limits', () => {
      const flat = flatOf(
        or(
          and(req(1, A), req(2, B), atMost(0, C), atMost(1, D)),
          and(atMost(1, D), req(2, B), atMost(0, C), req(1, A)),
        ),
      );
      expect(flat).toHaveLength(1);
      expect(flat[0]!.reqs.map((r) => r.desc)).toEqual([A, B]);
    });

    it('compares after merging', () => {
      expect(flatOf(or(req(2, A), and(req(1, A), req(1, A))))).toHaveLength(1);
    });

    it('tells apart what differs only in a count, or in requirement against limit', () => {
      expect(flatOf(or(req(1, A), req(2, A), atMost(1, A), atMost(2, A)))).toHaveLength(4);
    });

    it('counts a dropped alternative once, however often it was written', () => {
      const big = and(req(3, A), req(3, B));
      expect(expand(or(big, req(1, C), big), { maxHandSize: 5 })).toMatchObject({ dropped: 1 });
    });
  });

  describe('the cap', () => {
    it('accepts exactly 256 alternatives', () => {
      const result = expand(productOfChoices(8), { maxHandSize: 8 });
      expect(result.ok && result.flat).toHaveLength(256);
    });

    it('refuses 512 with a message that names the cap', () => {
      const result = expand(productOfChoices(9), { maxHandSize: 9 });
      expect(result).toEqual({
        ok: false,
        reason: 'cap',
        message: expect.stringContaining('256'),
      });
    });

    it('refuses before it drops: 512 alternatives no hand can hold are still an error', () => {
      expect(expand(productOfChoices(9), { maxHandSize: 5 }).ok).toBe(false);
    });

    it('refuses 257 alternatives of a plain or', () => {
      const leaves = Array.from({ length: 257 }, (_, i) => req(1, card(i)));
      expect(expand(or(...leaves.slice(0, 256)), HAND).ok).toBe(true);
      expect(expand(or(...leaves), HAND).ok).toBe(false);
    });

    it('gives up on 2^40 alternatives during distribution, not after it', () => {
      const started = performance.now();
      expect(expand(productOfChoices(40), HAND).ok).toBe(false);
      expect(expand(or(req(1, A), and(req(1, B), productOfChoices(40))), HAND).ok).toBe(false);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('reads no further into the criterion once the cap is passed', () => {
      let read = 0;
      const tripwire = {
        op: 'or',
        get args(): Expr[] {
          read++;
          throw new Error('read past the cap');
        },
      } as Expr;
      const choices = Array.from({ length: 9 }, (_, i) =>
        or(req(1, card(2 * i)), req(1, card(2 * i + 1))),
      );
      expect(expand(and(...choices, tripwire), HAND).ok).toBe(false);
      expect(read).toBe(0);
    });

    it('counts distinct alternatives, so a choice between equals costs nothing', () => {
      const either = or(req(1, A), req(1, A));
      const result = expand(and(...Array.from({ length: 40 }, () => either)), { maxHandSize: 60 });
      expect(result).toEqual({
        ok: true,
        flat: [{ reqs: [{ n: 40, desc: A }], limits: [] }],
        sources: [[0]],
        dropped: 0,
      });
    });
  });

  it('gives canonical descriptions and leaves its input alone', () => {
    const messy: Description = { anyOf: [{ t: 'clause', clause: { level: [4, 2, 4] } }] };
    const expr = and(req(1, messy), atMost(1, messy));
    const before = JSON.stringify(expr);
    const tidy: Description = { anyOf: [{ t: 'clause', clause: { level: [2, 4] } }] };
    expect(flatOf(expr)).toEqual([
      { reqs: [{ n: 1, desc: tidy }], limits: [{ n: 1, desc: tidy }] },
    ]);
    expect(JSON.stringify(expr)).toBe(before);
  });

  it('reads an and of nothing as always satisfied and an or of nothing as never', () => {
    expect(flatOf(and())).toEqual([{ reqs: [], limits: [] }]);
    expect(flatOf(or())).toEqual([]);
    expect(flatOf(and(req(1, A), or()))).toEqual([]);
  });
});

describe('expandAll', () => {
  it('reads the list of criteria as an or at the root', () => {
    const exprs = [and(req(1, A), or(req(1, B), req(1, C))), req(2, D)];
    // The same alternatives, in the same order. Only their provenance differs:
    // one criterion at the root there, two here — which is the whole of what
    // `sources` is for, and the reason it is compared apart.
    const many = expandAll(exprs, HAND);
    const one = expand(or(...exprs), HAND);
    if (!many.ok || !one.ok) throw new Error('both expand');
    expect(many.flat).toEqual(one.flat);
    expect(many.dropped).toBe(one.dropped);
    expect(many.sources).toEqual([[0], [0], [1]]);
    expect(one.sources).toEqual([[0], [0], [0]]);
    expect(expandAll(exprs, HAND)).toMatchObject({ ok: true, dropped: 0 });
    expect(flatOf(or(...exprs))).toHaveLength(3);
  });

  it('removes duplicates across criteria and counts drops across them', () => {
    const result = expandAll([req(1, A), and(req(3, A), req(3, B)), req(1, A), req(6, C)], {
      maxHandSize: 5,
    });
    expect(result).toEqual({
      ok: true,
      flat: [{ reqs: [{ n: 1, desc: A }], limits: [] }],
      // Criteria 0 and 2 are the same alternative; the other two are dropped.
      sources: [[0, 2]],
      dropped: 2,
    });
  });

  it('applies the cap to the union', () => {
    expect(expandAll([productOfChoices(7), productOfChoices(7)], HAND).ok).toBe(true);
    expect(expandAll([productOfChoices(8), req(1, card(999))], HAND).ok).toBe(false);
  });

  /**
   * Which criteria an alternative came from, which is the only thing left to
   * say so once duplicates are merged. A run that judges a SUBSET of the
   * criteria — going first, going second (PRD §5.5) — picks its alternatives
   * by these, so an alternative attributed to the wrong criterion would be
   * judged in the wrong hand.
   */
  describe('sources', () => {
    /** The oracle: expand each criterion ALONE and look its alternatives up in the union. */
    function sourcesByHand(exprs: readonly Expr[], maxHandSize: number): number[][] {
      const all = expandAll(exprs, { maxHandSize });
      if (!all.ok) throw new Error(all.message);
      const at = new Map(all.flat.map((flat, i) => [identity(flat), i]));
      const out = all.flat.map((): number[] => []);
      exprs.forEach((expr, criterion) => {
        const alone = expand(expr, { maxHandSize });
        if (!alone.ok) throw new Error(alone.message);
        for (const flat of alone.flat) {
          const index = at.get(identity(flat));
          if (index !== undefined && !out[index]!.includes(criterion)) out[index]!.push(criterion);
        }
      });
      return out;
    }

    it('names the one criterion an alternative came from', () => {
      const result = expandAll([req(1, A), req(1, B)], HAND);
      expect(result).toMatchObject({ sources: [[0], [1]] });
    });

    it('names every criterion that produced the SAME alternative, in order', () => {
      const result = expandAll([req(1, A), req(1, B), and(req(1, A)), req(1, A)], HAND);
      expect(result).toMatchObject({ sources: [[0, 2, 3], [1]] });
    });

    it('lists one alternative per `or` branch, all owned by the criterion that wrote it', () => {
      expect(expandAll([or(req(1, A), req(1, B), req(1, C))], HAND)).toMatchObject({
        sources: [[0], [0], [0]],
      });
    });

    it('stays parallel to `flat` when alternatives are dropped', () => {
      // Criterion 1 is dropped whole; criterion 2 keeps only its small branch.
      const result = expandAll([req(1, A), req(6, B), or(req(6, C), req(1, A))], {
        maxHandSize: 5,
      });
      expect(result).toMatchObject({ flat: [{ reqs: [{ n: 1, desc: A }] }], sources: [[0, 2]] });
    });

    it('agrees with expanding each criterion alone, over the generated criteria', () => {
      const rng = seededRng(90_210);
      let merged = 0;
      for (let round = 0; round < 200; round++) {
        const exprs = Array.from({ length: rng.int(1, 4) }, () =>
          genExpr(rng, {
            desc: (r) => card(r.int(0, 3)),
            maxDepth: 2,
            maxArgs: 3,
            limitChance: 0.25,
          }),
        );
        const result = expandAll(exprs, HAND);
        if (!result.ok) continue;
        expect(result.sources).toEqual(sourcesByHand(exprs, HAND.maxHandSize));
        expect(result.sources).toHaveLength(result.flat.length);
        for (const owners of result.sources) {
          expect(owners.length).toBeGreaterThan(0);
          expect([...owners].sort((a, b) => a - b)).toEqual(owners);
          if (owners.length > 1) merged++;
        }
      }
      // The interesting case — two criteria that expand to one alternative —
      // is reached, so the oracle is not agreeing about a vacuous thing.
      expect(merged).toBeGreaterThan(20);
    });
  });

  it('has no alternatives for no criteria', () => {
    expect(expandAll([], HAND)).toEqual({ ok: true, flat: [], sources: [], dropped: 0 });
  });
});

describe('expansion against the direct evaluator of the tree (E1)', () => {
  const DESCRIPTIONS = Array.from({ length: 6 }, (_, i) => card(i + 1));
  const CARD_TYPES = 5;

  interface Case {
    expr: Expr;
    hand: number[];
    fills: Fills<number>;
  }

  /** A random table of which card type fills which description, and a hand drawn from the types. */
  function genCase(rng: Rng, rangeChance = 0, splitChance = 0, uniqueChance = 0): Case {
    const density = rng.pick([0.25, 0.4, 0.6]);
    const table = Array.from({ length: CARD_TYPES }, () =>
      DESCRIPTIONS.map(() => rng.chance(density)),
    );
    const expr = genExpr(rng, {
      desc: (r) => r.pick(DESCRIPTIONS),
      maxDepth: rng.pick([1, 2, 3, 3, 4]),
      maxArgs: 3,
      limitChance: 0.2,
      rangeChance,
      splitChance,
      uniqueChance,
    });
    const hand = Array.from({ length: rng.int(0, 6) }, () => rng.int(0, CARD_TYPES - 1));
    return {
      expr,
      hand,
      fills: (type, desc) => {
        const alt = desc.anyOf[0]!;
        return alt.t === 'card' && table[type]![alt.passcode - 1]!;
      },
    };
  }

  describe('the evaluators themselves, on cases worked by hand', () => {
    // Hands of card names; a description is filled by the names listed for its passcode.
    const FILLED_BY: Record<number, string> = { 1: 'a', 2: 'b', 3: 'ab', 4: 'c' };
    const fills: Fills<string> = (name, desc) => {
      const alt = desc.anyOf[0]!;
      return alt.t === 'card' && FILLED_BY[alt.passcode]!.includes(name);
    };
    const [a, b, aOrB, c] = [A, B, C, D];
    const both = (expr: Expr, hand: string, expected: boolean) => {
      expect(satisfiesTree(expr, [...hand], fills), hand).toBe(expected);
      const flat = flatOf(expr, { maxHandSize: 60 });
      expect(satisfiesAnyFlat(flat, [...hand], fills), hand).toBe(expected);
    };

    it('assigns distinct cards: one card cannot fill two requirements (PRD §5.4)', () => {
      const expr = and(req(1, a), req(1, b), req(1, aOrB));
      both(expr, 'abb', true);
      both(expr, 'abc', false);
      both(expr, 'ab', false);
    });

    it('is not greedy: the flexible card is kept for the slot only it can fill', () => {
      // `aOrB` comes first and would take the `a`, which `1x a` then misses.
      both(and(req(1, aOrB), req(1, a)), 'ab', true);
      both(and(req(1, aOrB), req(1, b)), 'ab', true);
      both(and(req(2, aOrB), req(1, a)), 'ab', false);
    });

    it('counts a limit over the whole hand, cards taken by requirements included', () => {
      both(and(req(1, a), atMost(1, a)), 'ab', true);
      both(and(req(1, a), atMost(1, a)), 'aab', false);
      both(and(req(1, a), atMost(0, aOrB)), 'ac', false);
    });

    it('takes one branch at every or, and its limits with it', () => {
      const expr = and(req(1, c), or(and(req(1, a), atMost(0, b)), req(2, b)));
      both(expr, 'ca', true);
      both(expr, 'cab', false);
      both(expr, 'cabb', true);
      both(expr, 'a', false);
    });

    it('satisfies nothing with no alternatives, and anything with an empty one', () => {
      expect(satisfiesAnyFlat([], [], fills)).toBe(false);
      expect(satisfiesAnyFlat([{ reqs: [], limits: [] }], [], fills)).toBe(true);
    });
  });

  it('agrees on 6,000 generated criteria and hands, with and without dropping', () => {
    const rng = seededRng(0xe1e10001);
    let compared = 0;
    let satisfied = 0;
    let dropped = 0;
    let merged = 0;
    for (let i = 0; i < 6000; i++) {
      const { expr, hand, fills } = genCase(rng);
      const direct = satisfiesTree(expr, hand, fills);
      const exact = expand(expr, { maxHandSize: hand.length });
      const undropped = expand(expr, { maxHandSize: 60 });
      // Only the cap may fail, and the hand size has no say in it.
      same(exact.ok, undropped.ok, () => expr);
      if (!exact.ok || !undropped.ok) continue;
      compared++;
      if (direct) satisfied++;
      dropped += exact.dropped;
      if (sumsCounts(expr, undropped.flat)) merged++;
      same(satisfiesAnyFlat(exact.flat, hand, fills), direct, () => ({ expr, hand }));
      // What was dropped could not have been satisfied: keeping it changes nothing.
      same(satisfiesAnyFlat(undropped.flat, hand, fills), direct, () => ({ expr, hand }));
      same(exact.flat.length + exact.dropped, undropped.flat.length, () => expr);
    }
    // Measured: 5,969 compared (31 hit the cap), 44% satisfied, 25,201 alternatives dropped,
    // 2,668 criteria in which counts were summed.
    expect(compared).toBeGreaterThan(5900);
    expect(satisfied / compared).toBeGreaterThan(0.35);
    expect(satisfied / compared).toBeLessThan(0.55);
    expect(dropped).toBeGreaterThan(20000);
    expect(merged).toBeGreaterThan(2000);
  });

  it('agrees on 6,000 generated criteria and hands WITH range requirements', () => {
    const rng = seededRng(0xe1e1a2e5);
    let compared = 0;
    let satisfied = 0;
    let ranged = 0;
    let merged = 0;
    for (let i = 0; i < 6000; i++) {
      const { expr, hand, fills } = genCase(rng, 0.5);
      const direct = satisfiesTree(expr, hand, fills);
      const exact = expand(expr, { maxHandSize: Math.max(hand.length, 1) });
      if (!exact.ok) continue;
      compared++;
      if (direct) satisfied++;
      if (exact.flat.some((f) => f.reqs.some((r) => r.max !== undefined))) ranged++;
      if (mergesCeilings(expr, exact.flat)) merged++;
      // The tree evaluator never merges two requirements on one description;
      // `expand` always does. That they still agree is what checks the merge
      // rule — ceilings adding, and an unbounded requirement voiding them.
      same(satisfiesAnyFlat(exact.flat, hand, fills), direct, () => ({ expr, hand }));
    }
    expect(compared).toBeGreaterThan(5500);
    expect(satisfied / compared).toBeGreaterThan(0.2);
    expect(satisfied / compared).toBeLessThan(0.8);
    expect(ranged).toBeGreaterThan(3000);
    expect(merged).toBeGreaterThan(200);
  });

  it('agrees on 6,000 generated criteria and hands WHERE HALF NAME THE CARD DRAWN', () => {
    const rng = seededRng(0xe1e1516a);
    let compared = 0;
    let satisfied = 0;
    let split = 0;
    let sixthOnly = 0;
    for (let i = 0; i < 6000; i++) {
      const { expr, hand, fills } = genCase(rng, 0, 0.5);
      const direct = satisfiesTree(expr, hand, fills);
      // A split criterion's five-card part is judged over one card fewer, so
      // the hand it is expanded for is the WHOLE hand and expansion takes the
      // card away itself — the one place the two sides of `then` differ.
      const exact = expand(expr, { maxHandSize: Math.max(hand.length, 1) });
      if (!exact.ok) continue;
      compared++;
      if (direct) satisfied++;
      if (expr.op === 'split') {
        split++;
        if (expr.five === undefined) sixthOnly++;
      }
      // The tree evaluator splits the HAND and walks the tree; `expand` splits
      // the CRITERION and merges each side. That they agree on which card is
      // which is the whole of what this checks.
      same(satisfiesAnyFlat(exact.flat, hand, fills), direct, () => ({ expr, hand }));
    }
    expect(compared).toBeGreaterThan(5500);
    expect(split).toBeGreaterThan(2500);
    expect(sixthOnly).toBeGreaterThan(400);
    expect(satisfied / compared).toBeGreaterThan(0.05);
    expect(satisfied / compared).toBeLessThan(0.6);
  });

  /**
   * Hands of card TYPES, where two equal entries are two copies of one card —
   * so `unique` has copies to refuse. The tree evaluator never merges and
   * `expand` never merges a `unique` requirement either; what this checks is
   * that the plain requirements it DOES merge beside one still mean what they
   * meant, ceilings included.
   */
  it('agrees on 6,000 generated criteria and hands WITH unique requirements', () => {
    const rng = seededRng(0xe1e1d01e);
    let compared = 0;
    let satisfied = 0;
    let uniques = 0;
    let beside = 0;
    for (let i = 0; i < 6000; i++) {
      const { expr, hand, fills } = genCase(rng, 0.25, 0.2, 0.5);
      const direct = satisfiesTree(expr, hand, fills);
      const exact = expand(expr, { maxHandSize: Math.max(hand.length, 1) });
      if (!exact.ok) continue;
      compared++;
      if (direct) satisfied++;
      const flatUniques = exact.flat.filter((f) => f.reqs.some((r) => r.unique === true));
      if (flatUniques.length > 0) uniques++;
      if (flatUniques.some((f) => f.reqs.length > 1)) beside++;
      same(satisfiesAnyFlat(exact.flat, hand, fills), direct, () => ({ expr, hand }));
    }
    expect(compared).toBeGreaterThan(5500);
    expect(uniques).toBeGreaterThan(2500);
    expect(beside).toBeGreaterThan(1000);
    expect(satisfied / compared).toBeGreaterThan(0.1);
    expect(satisfied / compared).toBeLessThan(0.7);
  });

  it('covers nested or-in-and-in-or, limits at every depth and repeated descriptions', () => {
    const rng = seededRng(0xe1e10001);
    const seen = new Set<string>();
    const walk = (expr: Expr, path: string) => {
      if (expr.op === 'and' || expr.op === 'or')
        for (const arg of expr.args) walk(arg, `${path}${expr.op}>`);
      else seen.add(`${path}${expr.op}`);
    };
    for (let i = 0; i < 6000; i++) walk(genCase(rng).expr, '');
    for (const path of [
      'req',
      'atMost',
      'and>atMost',
      'or>atMost',
      'or>and>or>req',
      'and>or>and>atMost',
      'or>and>or>atMost',
      'and>or>and>or>req',
    ])
      expect(seen, path).toContain(path);
  });
});

/**
 * Whether some flat requirement's ceiling is wider than any single leaf's, or
 * was voided altogether: two leaves on one description were merged.
 */
function mergesCeilings(expr: Expr, flat: readonly FlatCriterion[]): boolean {
  const widest = new Map<string, number | undefined>();
  const seen = new Set<string>();
  const walk = (node: Expr) => {
    if (node.op === 'and' || node.op === 'or') node.args.forEach(walk);
    else if (node.op === 'req') {
      const key = JSON.stringify(node.desc);
      const earlier = widest.get(key);
      if (!seen.has(key) || (earlier !== undefined && (node.max ?? Infinity) > earlier))
        widest.set(key, node.max);
      seen.add(key);
    }
  };
  walk(expr);
  return flat.some((criterion) =>
    criterion.reqs.some(({ max, desc }) => {
      const leaf = widest.get(JSON.stringify(desc));
      return max === undefined ? leaf !== undefined : leaf !== undefined && max > leaf;
    }),
  );
}

/** Whether some flat requirement asks for more than any single leaf did: two leaves were summed. */
function sumsCounts(expr: Expr, flat: readonly FlatCriterion[]): boolean {
  const largest = new Map<string, number>();
  const walk = (node: Expr) => {
    if (node.op === 'and' || node.op === 'or') node.args.forEach(walk);
    else if (node.op === 'req') {
      const key = JSON.stringify(node.desc);
      largest.set(key, Math.max(largest.get(key) ?? 0, node.n));
    }
  };
  walk(expr);
  return flat.some((criterion) =>
    criterion.reqs.some(({ n, desc }) => n > largest.get(JSON.stringify(desc))!),
  );
}
