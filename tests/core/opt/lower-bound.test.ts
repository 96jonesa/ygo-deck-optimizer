import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { TYPE_CONTINUOUS, TYPE_TRAP } from '../../../src/core/cards/constants';
import { CardIndex } from '../../../src/core/cards/index';
import type { CardRecord } from '../../../src/core/cards/record';
import { evaluate } from '../../../src/core/desc/evaluate';
import {
  type CompileInput,
  compileProblem,
  groupMembersOf,
  REMAINDER_ID,
  type ResolvedTemplate,
  resolveTemplate,
} from '../../../src/core/model/compile';
import type { Template, TemplateLine } from '../../../src/core/model/template';
import { exampleRatio, optimize } from '../../../src/core/opt/optimizer';
import { createScorer, type Fraction } from '../../../src/core/prob/scorer';
import { SETNAMES } from '../../helpers/desc-context';
import { buildCdb, FIXTURE_ROWS, type FixtureRow } from '../../helpers/fixture-cards';
import { templateOf } from '../../helpers/gen-template';
import { MOTIVATING_ROWS } from '../../helpers/motivating';
import { type Rng, seededRng } from '../../helpers/prng';

// ---------------------------------------------------------------------------
// Oracle O3 — the lower-bound guarantee (PRD §6.3, §10; TDD §15.1), scoped
// exactly as the PRD scopes it. The optimizer reports a probability for a
// ratio of LINES; a real deck is CARDS. Fill every generic line with real
// fixture cards that match its description — and the remainder with anything
// — then score that concrete deck with every card fully known: a card fills a
// requirement, or counts against a limit, iff `evaluate` says it matches. No
// line, no `implies`.
// ---------------------------------------------------------------------------

/** The fixture has one trap; an adversarial fill, and a careful one, want a few kinds of card more. */
const EXTRA_ROWS: readonly FixtureRow[] = [
  { id: 90002010, name: 'Synthetic Normal Trap', type: TYPE_TRAP, level: 0, race: 0, attribute: 0 },
  {
    id: 90002020,
    name: 'Synthetic Continuous Trap',
    type: TYPE_TRAP | TYPE_CONTINUOUS,
    level: 0,
    race: 0,
    attribute: 0,
  },
  { id: 90002030, name: 'Synthetic Level 2 Monster', level: 2, atk: 500 },
  { id: 90002040, name: 'Synthetic Level 6 Monster', level: 6, atk: 2400 },
];

const SQL = await initSqlJs();
const cards = CardIndex.fromDatabases(SQL, [
  { bytes: buildCdb(SQL, [...FIXTURE_ROWS, ...MOTIVATING_ROWS, ...EXTRA_ROWS]) },
]);
const ctx = { cards, setnames: SETNAMES };
const ALL_CARDS = [...cards.all()];

const GENERIC_LINES = [
  'monster',
  'level 4 monster',
  'level 4 or lower monster',
  'LIGHT monster',
  'spell',
  'normal spell',
  'quick-play spell',
  'trap',
  'spell/trap',
] as const;
const NAMED_LINES = ['[Elemental HERO Stratos]', '[Reinforcement of the Army]'] as const;

const LIMIT_FREE = [
  '1x monster',
  '1x level 4 or lower monster, 1x spell',
  '1x [Elemental HERO Stratos], 1x spell',
  '1x card, 1x monster',
  '2x monster or 1x tuner monster',
  '1x [Reinforcement of the Army] or (1x [Elemental HERO Stratos] and 1x level 4 or lower monster)',
  '1x LIGHT monster, 1x spell/trap',
  '2x level 4 or lower monster',
] as const;

const WITH_LIMITS = [
  '1x spell, at most 1x trap',
  'no trap, 1x monster',
  '1x level 4 or lower monster, at most 1x spell',
  '1x monster, 1x spell, no level 8 or higher monster',
  '(1x [Elemental HERO Stratos] or 1x level 4 or lower monster), at most 2x spell/trap',
  '1x monster, at most 1x [Elemental HERO Stratos]',
] as const;

function genTemplate(rng: Rng, criteria: readonly string[]): Template {
  const texts = [...rng.subset(NAMED_LINES, 0, 2), ...rng.subset(GENERIC_LINES, 2, 4)];
  const lines = texts.map((text, i): TemplateLine => {
    const min = rng.int(0, 3);
    return { id: `l${i + 1}`, text, min, max: Math.min(3, min + rng.int(0, 2)) };
  });
  return templateOf(lines, rng.subset(criteria, 1, 2));
}

interface Fill {
  /** One card per slot of the deck, tagged with the line (index into `resolved.lines`) it was chosen for. */
  deck: { card: CardRecord; line: number }[];
  /** Whether some card counts against a limit that its LINE is not known to count against. */
  addsLimitMatches: boolean;
}

/**
 * Fill `counts` (a count per line, the remainder's last) with concrete cards.
 * A named line is copies of its card. A generic line is random cards matching
 * its description, other than the template's named cards (PRD §6.1: those
 * live on their own lines); the remainder is any such card. `careful` keeps to
 * cards that match no limit their line is not already known to match; `pick`
 * overrides the choice for a line, for the adversarial fill. `null` when some
 * line has no card to choose from.
 */
function fill(
  rng: Rng,
  resolved: ResolvedTemplate,
  counts: readonly number[],
  opts: { careful: boolean; pick?: (line: number, candidates: CardRecord[]) => CardRecord[] },
  template: Template,
): Fill | null {
  const groups = groupMembersOf(template.groups);
  const named = new Set(
    resolved.lines.flatMap(({ desc }) =>
      desc.anyOf.length === 1 && desc.anyOf[0]!.t === 'card' ? [desc.anyOf[0]!.passcode] : [],
    ),
  );
  const limits = resolved.descriptions.flatMap((d, column) => (d.inLimit ? [column] : []));
  const adds = (card: CardRecord, line: number) =>
    limits.some(
      (column) =>
        evaluate(resolved.descriptions[column]!.desc, card, groups) &&
        !resolved.matrix[line]![column],
    );

  const deck: Fill['deck'] = [];
  for (const [line, { desc }] of resolved.lines.entries()) {
    const only = desc.anyOf[0]!;
    const isNamed = desc.anyOf.length === 1 && only.t === 'card';
    let candidates = ALL_CARDS.filter(
      (card) => evaluate(desc, card, groups) && (isNamed || !named.has(card.code)),
    );
    if (opts.careful) candidates = candidates.filter((card) => !adds(card, line));
    if (opts.pick !== undefined) candidates = opts.pick(line, candidates);
    if (candidates.length === 0 && counts[line]! > 0) return null;
    for (let copy = 0; copy < counts[line]!; copy++)
      deck.push({ card: rng.pick(candidates), line });
  }
  return { deck, addsLimitMatches: deck.some(({ card, line }) => adds(card, line)) };
}

/**
 * The TRUE probability of a concrete deck: every distinct card is a line of
 * its own, pinned at its copies, whose matrix row is what `evaluate` says of
 * the card — the same criteria, the same exact scorer, no implication.
 */
function trueScore(resolved: ResolvedTemplate, template: Template, deck: Fill['deck']): Fraction {
  const groups = groupMembersOf(template.groups);
  const copies = new Map<number, { card: CardRecord; n: number }>();
  for (const { card } of deck) {
    const seen = copies.get(card.code);
    if (seen === undefined) copies.set(card.code, { card, n: 1 });
    else seen.n++;
  }
  const concrete = [...copies.values()];
  const input: CompileInput = {
    deckSize: resolved.deckSize,
    handSize: resolved.handSize,
    lines: [
      ...concrete.map(({ card, n }) => ({
        id: `#${card.code}`,
        isRemainder: false,
        min: n,
        max: n,
      })),
      { id: REMAINDER_ID, isRemainder: true, min: 0, max: 0 },
    ],
    matrix: [
      ...concrete.map(({ card }) =>
        resolved.descriptions.map(({ desc }) => evaluate(desc, card, groups)),
      ),
      resolved.descriptions.map(() => false),
    ],
    flat: resolved.flat,
  };
  const compiled = compileProblem(input);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  // Every range is pinned: the one class vector is the class minimums.
  const totals = compiled.classes.map((cls) => cls.min);
  return createScorer(compiled.problem, resolved.handSize).score(totals);
}

interface Reported {
  template: Template;
  resolved: ResolvedTemplate;
  /** A count per line, the remainder's last, and what the optimizer says of it. */
  counts: number[];
  reported: Fraction;
}

/** Ratios the optimizer reports a probability for: its best, and two more rows of its table. */
function reportedRatios(rng: Rng, template: Template): Reported[] {
  const result = resolveTemplate(template, ctx);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const { resolved } = result;
  const compiled = compileProblem(resolved);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  const run = optimize(compiled, { cost: { perVectorUs: 0.05, perTermNs: 6 }, topK: 50 });
  if (run.status !== 'done') throw new Error(`the run did not finish: ${run.status}`);
  const rows = [run.best, rng.pick(run.ranked), rng.pick(run.ranked)];
  return rows.map((row) => {
    const [part] = row.score.parts;
    return {
      template,
      resolved,
      counts: exampleRatio(compiled, row.classTotals),
      reported: { num: part!.num, den: part!.den },
    };
  });
}

describe('the lower-bound guarantee (oracle O3, PRD §6.3)', () => {
  it('criteria WITHOUT limits: no concrete fill ever scores below the reported probability', () => {
    let fills = 0;
    let higher = 0;
    let positive = 0;
    for (let seed = 0; seed < 140; seed++) {
      const rng = seededRng(83_000 + seed);
      for (const { template, resolved, counts, reported } of reportedRatios(
        rng,
        genTemplate(rng, LIMIT_FREE),
      )) {
        const filled = fill(rng, resolved, counts, { careful: false }, template);
        if (filled === null) continue;
        const truth = trueScore(resolved, template, filled.deck);
        expect(truth.den).toBe(reported.den);
        if (truth.num < reported.num)
          throw new Error(
            `true ${truth.num} < reported ${reported.num} of ${reported.den}: ${JSON.stringify({
              template,
              counts,
              deck: filled.deck.map(({ card }) => card.name),
            })}`,
          );
        fills++;
        if (truth.num > reported.num) higher++;
        if (reported.num > 0) positive++;
      }
    }
    console.info(
      `O3, no limits: ${fills} fills, never below; ${higher} strictly above, ${positive} with a reported P > 0`,
    );
    expect(fills).toBeGreaterThanOrEqual(300);
    // The bound is not vacuous: real cards do match more than their lines promise.
    expect(higher).toBeGreaterThanOrEqual(100);
    expect(positive).toBeGreaterThanOrEqual(250);
  });

  it('criteria WITH limits: the bound holds whenever the fill adds no limit matches beyond what the lines imply', () => {
    let careful = 0;
    let free = 0;
    let freeBelow = 0;
    for (let seed = 0; seed < 140; seed++) {
      const rng = seededRng(84_000 + seed);
      for (const { template, resolved, counts, reported } of reportedRatios(
        rng,
        genTemplate(rng, WITH_LIMITS),
      )) {
        for (const mode of [true, false]) {
          const filled = fill(rng, resolved, counts, { careful: mode }, template);
          if (filled === null) continue;
          const truth = trueScore(resolved, template, filled.deck);
          if (mode) expect(filled.addsLimitMatches).toBe(false);
          if (!filled.addsLimitMatches) {
            if (truth.num < reported.num)
              throw new Error(
                `true ${truth.num} < reported ${reported.num} of ${reported.den} though no limit match was added: ${JSON.stringify(
                  { template, counts, deck: filled.deck.map(({ card }) => card.name) },
                )}`,
              );
            careful++;
          } else {
            free++;
            if (truth.num < reported.num) freeBelow++;
          }
        }
      }
    }
    console.info(
      `O3, limits: ${careful} fills adding no limit match, never below; of ${free} fills that do add some, ${freeBelow} came out below`,
    );
    expect(careful).toBeGreaterThanOrEqual(300);
    // The scope is real: an unconstrained fill under a limit DOES come out below — not often,
    // since the cards that add limit matches usually fill more requirements too.
    expect(free).toBeGreaterThanOrEqual(200);
    expect(freeBelow).toBeGreaterThanOrEqual(5);
  });

  it('the adversarial fill — unspecified cards that are all traps, under `at most 1x trap` — comes out LOWER: the documented gap', () => {
    const template = templateOf(
      [
        { id: 'spells', text: 'spell', min: 8, max: 10 },
        { id: 'monsters', text: 'monster', min: 12, max: 14 },
        { id: 'traps', text: 'trap', min: 2, max: 3 },
      ],
      ['1x spell, at most 1x trap'],
    );
    const rng = seededRng(85_000);
    const [best] = reportedRatios(rng, template);
    const { resolved, counts, reported } = best!;
    // The best ratio runs every spell it may and the fewest traps; 14 to 16 cards are unspecified
    // — `exampleRatio` hands the blank cards to `monsters` first, which leaves 14.
    expect(counts).toEqual([10, 14, 2, 14]);
    const remainderLine = resolved.lines.length - 1;
    const isTrap = (card: CardRecord) => (card.type & TYPE_TRAP) !== 0;

    const adversarial = fill(
      rng,
      resolved,
      counts,
      {
        careful: false,
        pick: (line, candidates) =>
          line === remainderLine ? candidates.filter(isTrap) : candidates,
      },
      template,
    )!;
    expect(adversarial.addsLimitMatches).toBe(true);
    expect(adversarial.deck.filter(({ card }) => isTrap(card))).toHaveLength(2 + 14);
    const truth = trueScore(resolved, template, adversarial.deck);

    // By hand: hands of `s` of the 10 spells and `t` of the traps, the rest from the other cards.
    const choose = (n: number, k: number): number =>
      k < 0 || k > n ? 0 : k === 0 ? 1 : (choose(n, k - 1) * (n - k + 1)) / k;
    const atLeastASpellAtMostATrap = (traps: number): number => {
      let hands = 0;
      for (let s = 1; s <= 5; s++)
        for (let t = 0; t <= 1 && s + t <= 5; t++)
          hands += choose(10, s) * choose(traps, t) * choose(30 - traps, 5 - s - t);
      return hands;
    };
    // Reported: the 2 traps the template knows of. True: those, and the 14 it did not.
    expect(reported).toEqual({ num: atLeastASpellAtMostATrap(2), den: 658008 });
    expect(truth).toMatchObject({ num: atLeastASpellAtMostATrap(16), den: 658008 });
    expect(truth.num).toBeLessThan(reported.num);
    console.info(
      `O3, adversarial: reported ${reported.num}/${reported.den} = ${(reported.num / reported.den).toFixed(4)}, ` +
        `true ${truth.num}/${truth.den} = ${(truth.num / truth.den).toFixed(4)}`,
    );

    // The same 16 cards, none of them a trap: the bound holds again.
    const benign = fill(
      rng,
      resolved,
      counts,
      {
        careful: false,
        pick: (line, candidates) =>
          line === remainderLine ? candidates.filter((card) => !isTrap(card)) : candidates,
      },
      template,
    )!;
    expect(benign.addsLimitMatches).toBe(false);
    expect(trueScore(resolved, template, benign.deck).num).toBeGreaterThanOrEqual(reported.num);
  });
});
