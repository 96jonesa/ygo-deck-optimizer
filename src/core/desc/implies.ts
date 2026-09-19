import type { CardRecord } from '../cards/record';
import type { Alternative, Description } from './ast';
import {
  type ArchetypeDims,
  archetypeDimsOf,
  type Box,
  boxIntersect,
  subtractAll,
  toBoxes,
} from './boxes';
import { type Groups, matcher } from './evaluate';

/**
 * What `implies` may look up. Cards are consulted ONLY for the `card` and
 * `group` alternatives of a description, which are points; what a generic
 * description matches is never decided against a card pool (TDD §6.3).
 */
export interface ImpliesContext {
  cards: { get(code: number): CardRecord | undefined };
  groups: Groups;
}

/** The remainder line's description, `card`: every Main Deck card (TDD §6.2). */
export const UNIVERSE: Description = Object.freeze({
  anyOf: Object.freeze([Object.freeze({ t: 'clause', clause: Object.freeze({}) })]),
}) as Description;

/**
 * The passcodes a `card` or `group` alternative names. A group the map does
 * not hold has no members, as in `evaluate`.
 */
function codesOf(alt: Exclude<Alternative, { t: 'clause' }>, groups: Groups): number[] {
  return alt.t === 'card' ? [alt.passcode] : [...(groups.get(alt.groupId) ?? [])];
}

/**
 * One side of a comparison, as the other side's points see it. Everything is
 * computed on first use: a comparison of two generic descriptions never
 * builds a matcher, and one of two cards never builds a box.
 */
interface Side {
  boxes(): Box[];
  /**
   * Whether the card with this passcode matches the description. A card in
   * the index is fully known and is judged by `evaluate`. Of a card MISSING
   * from the index only the passcode is known, so it matches exactly what
   * is true of it whatever its record says: a `card` alternative naming the
   * same passcode, a `group` alternative holding it, or a description whose
   * clauses cover the whole universe (`card`, `monster or spell/trap`).
   */
  holds(code: number): boolean;
}

function sideOf(desc: Description, dims: ArchetypeDims, ctx: ImpliesContext): Side {
  let boxes: Box[] | undefined;
  let test: ((card: CardRecord) => boolean) | undefined;
  let universe: boolean | undefined;
  const side: Side = {
    boxes: () => {
      boxes ??= toBoxes(desc, dims);
      return boxes;
    },
    holds: (code) => {
      const card = ctx.cards.get(code);
      if (card !== undefined) {
        test ??= matcher(desc, ctx.groups);
        return test(card);
      }
      const named = desc.anyOf.some((alt) =>
        alt.t === 'card'
          ? alt.passcode === code
          : alt.t === 'group' && ctx.groups.get(alt.groupId)?.has(code) === true,
      );
      if (named) return true;
      universe ??= subtractAll(toBoxes(UNIVERSE, dims), side.boxes()).length === 0;
      return universe;
    },
  };
  return side;
}

/**
 * Whether every card `L` can stand for is one `q` matches — the tool's single
 * matching relation (TDD §6). It is LOGICAL: a function of the two
 * descriptions and the axioms of `boxes.ts`, never of the card pool, so
 * `monster` does not imply `level 4 or lower monster` however the pool looks.
 *
 * `L` implies `q` iff EVERY alternative of `L` does:
 * - a card is fully known, so it implies whatever `evaluate(q, record)` says.
 *   A passcode missing from the index implies only what needs no record —
 *   a `q` that names it, by passcode or through a group, or that is the
 *   whole universe — which keeps `implies` reflexive;
 * - a group implies `q` iff every member does, by the same two rules, and an
 *   EMPTY group implies anything, vacuously (flagging empty groups is the
 *   analysis layer's job);
 * - a clause implies only the CLAUSE alternatives of `q`, by box subtraction:
 *   a generic line stands for cards other than the ones the template names,
 *   so it never implies a `card` or `group` alternative. An unsatisfiable
 *   clause has no boxes and implies anything.
 */
export function implies(L: Description, q: Description, ctx: ImpliesContext): boolean {
  const dims = archetypeDimsOf(L, q);
  const target = sideOf(q, dims, ctx);
  return L.anyOf.every((alt) =>
    alt.t === 'clause'
      ? subtractAll(toBoxes({ anyOf: [alt] }, dims), target.boxes()).length === 0
      : codesOf(alt, ctx.groups).every((code) => target.holds(code)),
  );
}

/**
 * Whether some card could match both — the "near miss" of a line that does
 * not imply a requirement but is not disjoint from it either. Symmetric, and
 * monotone: what meets `q` meets everything `q` implies. A card or group on
 * either side is judged against the other side as in `implies`, and ANY
 * member will do; two clauses meet when two of their boxes do. Archetypes
 * never keep two clauses apart: a card can carry both.
 */
export function intersects(L: Description, q: Description, ctx: ImpliesContext): boolean {
  const dims = archetypeDimsOf(L, q);
  const left = sideOf(L, dims, ctx);
  const right = sideOf(q, dims, ctx);
  const meets = (points: Description, other: Side): boolean =>
    points.anyOf.some(
      (alt) => alt.t !== 'clause' && codesOf(alt, ctx.groups).some((code) => other.holds(code)),
    );
  if (meets(L, right) || meets(q, left)) return true;
  return left.boxes().some((a) => right.boxes().some((b) => boxIntersect(a, b) !== null));
}
