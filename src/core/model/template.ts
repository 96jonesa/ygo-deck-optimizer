import type { Expr } from '../criteria/ast';
import { validateExpr } from '../criteria/validate';
import type { Description } from '../desc/ast';
import { validateDescription } from '../desc/validate';
import type { DrawSpec } from './problem';

/** The only template file version this build reads (TDD §14). */
export const TEMPLATE_VERSION = 1;

export const DECK_SIZE_MIN = 40;
export const DECK_SIZE_MAX = 60;
/** Going first, going second (PRD §5.5). */
export const HAND_SIZES = [5, 6] as const;
/** The game's copy limit, which a line that names one card cannot exceed (PRD §5.1). */
export const NAMED_CARD_MAX = 3;

/**
 * The most cards one draw card may draw (PRD §5.7). The engine's own bounds are
 * `MAX_PREFIX` and `MAX_HAND`, which depend on the copies held as well and are
 * what actually refuse a template; this is the EDITOR's bound, and it is here so
 * that a mistyped `20` is caught where it is typed. Pot of Greed draws two and
 * Pot of Prosperity looks at six, so six is already past everything printed.
 */
export const DRAW_CARDS_MAX = 6;

/**
 * The two halves of a game (PRD §5.5): going FIRST is a hand of five, going
 * SECOND a hand of six. The pairing is the domain's, not a setting — the whole
 * point of a six-card hand is that it is the one you draw on the draw.
 */
export type Part = 'first' | 'second';

/**
 * Which hand a criterion is judged for. ONE criteria list, each entry tagged:
 * a criterion that applies either way is written once, as `both`, which is
 * also what a criterion that says nothing means.
 */
export type CriterionWhen = Part | 'both';
export const CRITERION_WHENS = ['first', 'second', 'both'] as const;

/**
 * What a run ranks by:
 *
 * - `first`   — a hand of five over the criteria tagged `first` or `both`;
 * - `second`  — a hand of six over the criteria tagged `second` or `both`;
 * - `average` — both of those, weighted 1 : 1, ranked by their exact mean.
 */
export type RunMode = Part | 'average';
export const RUN_MODES = ['first', 'second', 'average'] as const;

/** The hand a mode's LARGEST part holds: the size a template must resolve at. */
export function handSizeForMode(mode: RunMode): 5 | 6 {
  return mode === 'first' ? 5 : 6;
}

/** The parts a mode scores, in the order their scores are reported. */
export function partsOfMode(mode: RunMode): Part[] {
  return mode === 'average' ? ['first', 'second'] : [mode];
}

/** Whether a criterion tagged `when` counts for `part`. */
export function countsFor(when: CriterionWhen, part: Part): boolean {
  return when === 'both' || when === part;
}

/** A criterion's tag; an untagged one counts for both hands. */
export function whenOf(criterion: Pick<TemplateCriterion, 'when'>): CriterionWhen {
  return criterion.when ?? 'both';
}

/**
 * The largest weight a criterion may carry (PRD §5.6). The engine's real bound
 * is `floor((2^53 - 1) / C(N, H))` — 179,914,198 for the largest deck and hand
 * there is, and more for every other — and `checkWeightBound` enforces it
 * exactly. This is the EDITOR's bound, far below it: weights are a ranking of
 * outcomes, a hundred to one is already an extreme, and a field that accepts
 * nine digits is a field that accepts a typo.
 */
export const CRITERION_WEIGHT_MAX = 1000;

/**
 * Why a criterion split across the opening five and the sixth card must be
 * tagged going second — in the one wording `resolveTemplate` and `analyze` both
 * use, so that the run and the readout cannot come to disagree about it.
 *
 * It is an ERROR and not a warning, and not the criterion quietly going
 * unjudged. `then` says which card is which, and only the hand you draw a sixth
 * card into has a sixth card to say it about; going first there is nothing for
 * the second half of the criterion to be true or false of. A tag saying
 * otherwise is a contradiction the user wrote down, and the tag is also what the
 * editor groups the criteria by — so narrowing it silently would leave a
 * criterion sitting under a heading that no longer describes it. Tagging it
 * going second costs nothing, an AVERAGE included: the average judges every
 * criterion, and a going-second one in its six-card half.
 */
export function splitNeedsSecond(when: CriterionWhen): string {
  const judged =
    when === 'first'
      ? 'this one is judged going first, where the hand is five cards and none of them is drawn after'
      : 'this one is judged for both hands, and going first the hand is five cards and none of them is drawn after';
  return `\`then\` is about the card you draw going second, but ${judged} — tag it going second, or ask for the six cards together and drop the \`then\``;
}

/** A criterion's weight; one that says nothing is worth 1 (PRD §5.6). */
export function weightOf(criterion: Pick<TemplateCriterion, 'weight'>): number {
  return criterion.weight ?? 1;
}

/**
 * Whether the player would STOP for this criterion (PRD §5.7): if the opening
 * hand already meets it, no draw card is activated at all. One that says nothing
 * would not — the checkbox is checked by default, and checked means "I am
 * willing to lose this by drawing".
 *
 * It decides the STOP, and not which criteria are eligible: whichever window
 * the stop decision lands on, every criterion is judged in it.
 */
export function stopsFor(criterion: Pick<TemplateCriterion, 'stop'>): boolean {
  return criterion.stop ?? false;
}

/**
 * The mode a template runs in. `mode` is what it says when it says anything;
 * a file written before modes existed says it with its hand size alone, and a
 * hand of five has always meant going first.
 */
export function modeOf(template: Pick<Template, 'mode' | 'hand'>): RunMode {
  return template.mode ?? (template.hand.size === 6 ? 'second' : 'first');
}

/** A card as a template stores it: the passcode is the identity, the name is for the reader. */
export interface TemplateCard {
  passcode: number;
  name: string;
}

export interface TemplateGroup {
  id: string;
  name: string;
  cards: TemplateCard[];
}

interface LineRange {
  id: string;
  min: number;
  max: number;
  /**
   * Set when the line's cards DRAW (PRD §5.7): each copy that resolves leaves
   * the hand and is replaced by `n` cards off the top, and cards so drawn draw
   * in turn. Absent is every line written before draw cards, and every line
   * that is not one — which is why `TEMPLATE_VERSION` is not bumped for this.
   *
   * `oncePerTurn` is a property of the CARD: only the first copy resolves and
   * the rest sit in hand. Two once-per-turn lines therefore never merge into
   * one class, each naming its own card and each getting its own once.
   */
  draw?: DrawSpec;
}

/**
 * A line is a copy range plus EITHER a card chosen through the picker OR a
 * description as text. `desc` is the parsed form the app saves beside the text.
 */
export type TemplateLine =
  | (LineRange & { card: TemplateCard })
  | (LineRange & { text: string; desc?: Description });

export interface TemplateCriterion {
  id: string;
  name?: string;
  text: string;
  expr?: Expr;
  /** Which hand it is judged for; absent is `both` (`whenOf`). */
  when?: CriterionWhen;
  /**
   * What a hand meeting it is worth when the template weights its criteria
   * (`Template.weighted`); absent is 1 (`weightOf`), and it is READ ONLY when
   * weighting is on — a weight left on a template whose switch is off changes
   * nothing, which is what lets the switch be turned off and on again without
   * losing what was set.
   *
   * A positive whole number at most `CRITERION_WEIGHT_MAX`: the score is a sum
   * of weights, and exactness (TDD §10.3) rests on that sum being an integer.
   */
  weight?: number;
  /**
   * Whether the player would STOP for this criterion (PRD §5.7): `true` and an
   * opening hand that already meets it activates no draw card. Absent is false
   * (`stopsFor`) — the "Stop here" box is UNTICKED, which means "I draw
   * regardless, and accept that drawing may lose this".
   *
   * It is the STOP DECISION and not an eligibility list. Whichever window the
   * decision lands on, every criterion is judged in it: a `stop` criterion is
   * still judged after the draws when some other criterion failed to stop them,
   * and a criterion left alone still counts towards the weight in a hand that
   * stopped. Marking one is what protects a hand that already works from being
   * drawn out of — the only escape hatch the model offers, since every draw card
   * otherwise resolves.
   */
  stop?: boolean;
}

/** The unspecified cards; `max: null` is unbounded. */
export interface TemplateRemainder {
  min: number;
  max: number | null;
}

/**
 * The fields of one named card as a template file records them (TDD §14
 * `cardSnapshot`). Results depend on the card database ONLY through named
 * cards, so these are exactly the fields a reproduced run would need — which
 * is what makes "this file gives the same numbers on another machine" a
 * checkable claim rather than a hope.
 */
export interface CardSnapshot {
  type: number;
  attribute: number;
  race: number;
  level: number;
  atk: number;
  def: number;
  setcodes: number[];
}

/** The template file (TDD §14). */
export interface Template {
  version: typeof TEMPLATE_VERSION;
  deckSize: number;
  /**
   * The hand the criteria are expanded and judged at. It is the mode's largest
   * part (`handSizeForMode`), and `validateTemplate` holds the two to that, so
   * neither can drift: `mode` is what the template MEANS, and `hand.size` is
   * how a file written before modes existed said the same thing.
   */
  hand: { size: number };
  /** Absent: read off `hand.size` (`modeOf`), which is what every v1 file does. */
  mode?: RunMode;
  /**
   * Whether the criteria carry WEIGHTS (PRD §5.6). Absent is false, which is
   * every template written before weighting existed and every template that
   * does not want it: a hand then succeeds or does not, and the score is the
   * probability it always was.
   *
   * With it on, a hand is worth the highest weight among the criteria it meets
   * and the run ranks by the expected weight per hand. It is one switch for the
   * template rather than a property of each criterion, because it decides what
   * the ANSWER is — a probability or an expectation — and a template cannot
   * report half of each.
   */
  weighted?: boolean;
  groups: TemplateGroup[];
  lines: TemplateLine[];
  remainder: TemplateRemainder;
  criteria: TemplateCriterion[];
  /** The fields of every named card when the file was saved, by passcode. */
  cardSnapshot?: Record<string, CardSnapshot>;
}

export type ValidateResult = { ok: true; template: Template } | { ok: false; errors: string[] };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

/** `lines[2] ("l3")`: the position finds it in the file, the id names it in the app. */
function labelOf(list: string, index: number, item: unknown): string {
  const id = isObject(item) && typeof item.id === 'string' ? ` (${JSON.stringify(item.id)})` : '';
  return `${list}[${index}]${id}`;
}

class Validator {
  readonly errors: string[] = [];

  fail(message: string): undefined {
    this.errors.push(message);
    return undefined;
  }

  /** A non-negative integer field; anything else is reported and read as `undefined`. */
  count(where: string, field: string, value: unknown): number | undefined {
    if (isCount(value)) return value;
    if (value === undefined) return this.fail(`${where}: \`${field}\` is missing`);
    if (typeof value === 'number' && Number.isInteger(value))
      return this.fail(`${where}: \`${field}\` is ${value}; a count cannot be negative`);
    return this.fail(`${where}: \`${field}\` must be a whole number, not ${show(value)}`);
  }

  text(where: string, field: string, value: unknown): string | undefined {
    if (isText(value)) return value;
    if (value === undefined) return this.fail(`${where}: \`${field}\` is missing`);
    return this.fail(`${where}: \`${field}\` must be non-empty text, not ${show(value)}`);
  }

  /**
   * Like `text`, but an empty string is allowed. Used for the one thing a
   * half-written template is full of: a description nobody has typed yet.
   *
   * Rejecting it here would make the WHOLE template structurally invalid, so
   * `analyze` could not answer at all and an editor would have nothing to show
   * for any line — whereas an empty description is simply a description that
   * does not parse, which `analyze` already reports against the line it is on.
   * Identifiers and names still go through `text`.
   */
  draftText(where: string, field: string, value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value === undefined) return this.fail(`${where}: \`${field}\` is missing`);
    return this.fail(`${where}: \`${field}\` must be text, not ${show(value)}`);
  }

  list(field: string, value: unknown, required: boolean): unknown[] {
    if (Array.isArray(value)) return value;
    if (value === undefined) {
      if (required) this.fail(`\`${field}\` is missing`);
      return [];
    }
    this.fail(`\`${field}\` must be a list, not ${show(value)}`);
    return [];
  }

  duplicates(list: string, ids: readonly (string | undefined)[]): void {
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const id of ids) {
      if (id === undefined) continue;
      if (seen.has(id) && !reported.has(id)) {
        reported.add(id);
        this.fail(`\`${list}\`: the id ${JSON.stringify(id)} is used more than once`);
      }
      seen.add(id);
    }
  }

  /** `field` is `card` on a line, and nothing in a group's list, where the entry IS the card. */
  card(where: string, value: unknown, field: 'card' | ''): TemplateCard | undefined {
    const prefix = field === '' ? '' : `${field}.`;
    if (!isObject(value)) {
      const what = field === '' ? 'must be' : `\`${field}\` must be`;
      return this.fail(`${where}: ${what} { passcode, name }, not ${show(value)}`);
    }
    const passcode = this.count(where, `${prefix}passcode`, value.passcode);
    const name = this.text(where, `${prefix}name`, value.name);
    if (passcode === 0) return this.fail(`${where}: \`${prefix}passcode\` is 0; no card has it`);
    return passcode === undefined || name === undefined ? undefined : { passcode, name };
  }

  group(where: string, value: unknown): TemplateGroup | undefined {
    if (!isObject(value)) return this.fail(`${where}: must be an object, not ${show(value)}`);
    const id = this.text(where, 'id', value.id);
    const name = this.text(where, 'name', value.name);
    if (!Array.isArray(value.cards)) {
      this.fail(`${where}: \`cards\` must be a list, not ${show(value.cards)}`);
      return undefined;
    }
    const cards = value.cards.map((card, i) => this.card(`${where}.cards[${i}]`, card, ''));
    if (id === undefined || name === undefined || cards.includes(undefined)) return undefined;
    return { id, name, cards: cards as TemplateCard[] };
  }

  /** A line's `draw` (PRD §5.7): `{ n, oncePerTurn? }`, or nothing at all. */
  draw(where: string, value: unknown): DrawSpec | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      this.fail(`${where}: \`draw\` must be { n, oncePerTurn }, not ${show(value)}`);
      return undefined;
    }
    const n = this.count(where, 'draw.n', value.n);
    if (n !== undefined && (n < 1 || n > DRAW_CARDS_MAX))
      this.fail(
        `${where}: \`draw.n\` is ${n}; a draw card draws 1 to ${DRAW_CARDS_MAX} cards — a card that draws none is not one`,
      );
    let oncePerTurn: true | undefined;
    if (value.oncePerTurn !== undefined) {
      if (typeof value.oncePerTurn !== 'boolean')
        this.fail(
          `${where}: \`draw.oncePerTurn\` must be true or false, not ${show(value.oncePerTurn)}`,
        );
      else if (value.oncePerTurn) oncePerTurn = true;
    }
    if (n === undefined || n < 1 || n > DRAW_CARDS_MAX) return undefined;
    return oncePerTurn === undefined ? { n } : { n, oncePerTurn };
  }

  line(where: string, value: unknown): TemplateLine | undefined {
    if (!isObject(value)) return this.fail(`${where}: must be an object, not ${show(value)}`);
    const id = this.text(where, 'id', value.id);
    const min = this.count(where, 'min', value.min);
    const max = this.count(where, 'max', value.max);
    if (min !== undefined && max !== undefined && min > max)
      this.fail(`${where}: \`min\` ${min} is greater than \`max\` ${max}`);
    const draw = this.draw(where, value.draw);
    const drawn = draw === undefined ? {} : { draw };

    const hasCard = value.card !== undefined;
    const hasText = value.text !== undefined;
    if (hasCard === hasText) {
      return this.fail(
        hasCard
          ? `${where}: has both \`card\` and \`text\`; a line is one or the other`
          : `${where}: needs either \`card\` ({ passcode, name }) or \`text\` (a description)`,
      );
    }
    if (hasCard) {
      const card = this.card(where, value.card, 'card');
      if (max !== undefined && max > NAMED_CARD_MAX)
        this.fail(
          `${where}: \`max\` is ${max}, but a deck holds at most ${NAMED_CARD_MAX} copies of one card`,
        );
      if (id === undefined || min === undefined || max === undefined || card === undefined)
        return undefined;
      return { id, min, max, ...drawn, card };
    }
    const text = this.draftText(where, 'text', value.text);
    // The stored AST is AUTHORITATIVE (TDD §14), so it is checked here rather
    // than carried through unread: `implies` and the box model would otherwise
    // be the first thing to meet a `level: ["four"]` out of a hand-written file.
    let desc: Description | undefined;
    if (value.desc !== undefined) {
      const parsed = validateDescription(value.desc, `${where}: \`desc\``);
      if (parsed.ok) desc = parsed.desc;
      else for (const message of parsed.errors) this.fail(message);
    }
    if (id === undefined || min === undefined || max === undefined || text === undefined)
      return undefined;
    return desc === undefined
      ? { id, min, max, ...drawn, text }
      : { id, min, max, ...drawn, text, desc };
  }

  criterion(where: string, value: unknown): TemplateCriterion | undefined {
    if (!isObject(value)) return this.fail(`${where}: must be an object, not ${show(value)}`);
    const id = this.text(where, 'id', value.id);
    const text = this.draftText(where, 'text', value.text);
    if (value.name !== undefined && typeof value.name !== 'string')
      this.fail(`${where}: \`name\` must be text, not ${show(value.name)}`);
    let when: CriterionWhen | undefined;
    if (value.when !== undefined) {
      if (CRITERION_WHENS.includes(value.when as CriterionWhen)) when = value.when as CriterionWhen;
      else
        this.fail(
          `${where}: \`when\` is ${show(value.when)}; a criterion is judged going ${CRITERION_WHENS.join(', ')}`,
        );
    }
    // Authoritative, and so checked, exactly as a line's `desc` is.
    let expr: Expr | undefined;
    if (value.expr !== undefined) {
      const parsed = validateExpr(value.expr, `${where}: \`expr\``);
      if (parsed.ok) expr = parsed.expr;
      else for (const message of parsed.errors) this.fail(message);
    }
    // A weight is read whatever `weighted` says — the switch decides whether it
    // COUNTS, not whether it may be written down — so a broken one is a broken
    // file either way, rather than a number that starts mattering later.
    let weight: number | undefined;
    if (value.weight !== undefined) {
      const given = this.count(where, 'weight', value.weight);
      if (given !== undefined && (given < 1 || given > CRITERION_WEIGHT_MAX))
        this.fail(
          `${where}: \`weight\` is ${given}; a criterion is worth 1 to ${CRITERION_WEIGHT_MAX}`,
        );
      else weight = given;
    }
    // Read whether or not the template holds draw cards, for the reason a
    // weight is: draw cards decide whether it COUNTS, not whether it may be
    // written down.
    let stop: boolean | undefined;
    if (value.stop !== undefined) {
      if (typeof value.stop === 'boolean') stop = value.stop;
      else this.fail(`${where}: \`stop\` must be true or false, not ${show(value.stop)}`);
    }
    if (id === undefined || text === undefined) return undefined;
    const out: TemplateCriterion = { id, text };
    if (typeof value.name === 'string') out.name = value.name;
    if (expr !== undefined) out.expr = expr;
    if (when !== undefined) out.when = when;
    if (weight !== undefined) out.weight = weight;
    if (stop !== undefined) out.stop = stop;
    return out;
  }

  /**
   * `cardSnapshot`: a `CardSnapshot` per passcode. Written by the app, so a
   * broken one is a broken file and says so rather than being quietly dropped
   * — the whole point of it is that a run can be checked against it.
   */
  snapshot(value: unknown): Record<string, CardSnapshot> | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value))
      return this.fail(`\`cardSnapshot\` must be an object, not ${show(value)}`);
    const out: Record<string, CardSnapshot> = {};
    for (const [passcode, fields] of Object.entries(value)) {
      const where = `\`cardSnapshot\` [${JSON.stringify(passcode)}]`;
      if (!/^[1-9]\d*$/.test(passcode)) {
        this.fail(`${where}: the key must be a passcode`);
        continue;
      }
      if (!isObject(fields)) {
        this.fail(`${where}: must be an object, not ${show(fields)}`);
        continue;
      }
      const numbers = (['type', 'attribute', 'race', 'level', 'atk', 'def'] as const).map(
        (field) =>
          typeof fields[field] === 'number' && Number.isInteger(fields[field])
            ? (fields[field] as number)
            : this.fail(
                `${where}: \`${field}\` must be a whole number, not ${show(fields[field])}`,
              ),
      );
      const setcodes = Array.isArray(fields.setcodes)
        ? fields.setcodes.filter(
            (code): code is number => typeof code === 'number' && Number.isInteger(code),
          )
        : this.fail(`${where}: \`setcodes\` must be a list, not ${show(fields.setcodes)}`);
      if (
        Array.isArray(fields.setcodes) &&
        setcodes !== undefined &&
        setcodes.length !== fields.setcodes.length
      )
        this.fail(`${where}: every setcode must be a whole number`);
      if (numbers.includes(undefined) || setcodes === undefined) continue;
      const [type, attribute, race, level, atk, def] = numbers as number[];
      out[passcode] = {
        type: type!,
        attribute: attribute!,
        race: race!,
        level: level!,
        atk: atk!,
        def: def!,
        setcodes,
      };
    }
    return out;
  }

  remainder(value: unknown): TemplateRemainder {
    const open: TemplateRemainder = { min: 0, max: null };
    if (value === undefined) return open;
    if (!isObject(value)) {
      this.fail(`\`remainder\` must be { min, max }, not ${show(value)}`);
      return open;
    }
    const min = value.min === undefined ? 0 : this.count('`remainder`', 'min', value.min);
    const max =
      value.max === undefined || value.max === null
        ? null
        : this.count('`remainder`', 'max', value.max);
    if (min !== undefined && max !== undefined && max !== null && min > max)
      this.fail(`\`remainder\`: \`min\` ${min} is greater than \`max\` ${max}`);
    return { min: min ?? 0, max: max ?? null };
  }
}

/**
 * Structural validation of a parsed template file (TDD §14), with messages
 * meant for the person who wrote it. Every problem is reported, not just the
 * first. Nothing here needs a card database: whether a description parses,
 * and what it matches, is `resolveTemplate`'s business.
 *
 * `groups` and `remainder` may be left out — no groups, and an unbounded
 * remainder — so that a template written by hand stays short; the template
 * that comes back always has them. Unknown fields are ignored.
 *
 * A stored `desc` or `expr` is the AUTHORITATIVE meaning of its line or
 * criterion (TDD §14), so it is fully checked here and comes back CANONICAL —
 * every field the box model assumes of it is asserted before `implies` can
 * meet it, and `resolveTemplate` can compare it with a fresh parse of the text
 * by stringifying both.
 */
export function validateTemplate(json: unknown): ValidateResult {
  if (!isObject(json))
    return { ok: false, errors: [`a template is a JSON object, not ${show(json)}`] };
  if (json.version !== TEMPLATE_VERSION) {
    const found = json.version === undefined ? 'no `version`' : `\`version\` ${show(json.version)}`;
    return {
      ok: false,
      errors: [`this file has ${found}; this build reads version ${TEMPLATE_VERSION} templates`],
    };
  }

  const v = new Validator();
  const deckSize = v.count('template', 'deckSize', json.deckSize);
  if (deckSize !== undefined && (deckSize < DECK_SIZE_MIN || deckSize > DECK_SIZE_MAX))
    v.fail(`\`deckSize\` is ${deckSize}; a Main Deck holds ${DECK_SIZE_MIN} to ${DECK_SIZE_MAX}`);

  let handSize: number | undefined;
  if (!isObject(json.hand)) v.fail(`\`hand\` must be { size }, not ${show(json.hand)}`);
  else {
    handSize = v.count('`hand`', 'size', json.hand.size);
    if (handSize !== undefined && !HAND_SIZES.includes(handSize as 5 | 6))
      v.fail(`\`hand.size\` is ${handSize}; an opening hand is ${HAND_SIZES.join(' or ')} cards`);
  }

  // `mode` and `hand.size` say one thing, and a file that says it two ways is
  // refused rather than read one way and run the other.
  let mode: RunMode | undefined;
  if (json.mode !== undefined) {
    if (!RUN_MODES.includes(json.mode as RunMode))
      v.fail(`\`mode\` is ${show(json.mode)}; a run goes ${RUN_MODES.join(', ')}`);
    else {
      mode = json.mode as RunMode;
      const wanted = handSizeForMode(mode);
      if (handSize !== undefined && handSize !== wanted)
        v.fail(
          `\`mode\` is ${JSON.stringify(mode)}, which is judged at a hand of ${wanted}, but \`hand.size\` is ${handSize}`,
        );
    }
  }

  // The weighting switch (PRD §5.6). Optional on read, and false without it, so
  // every file written before weighting existed reads as the run it always was
  // — which is why `TEMPLATE_VERSION` is not bumped for this.
  let weighted: boolean | undefined;
  if (json.weighted !== undefined) {
    if (typeof json.weighted === 'boolean') weighted = json.weighted;
    else v.fail(`\`weighted\` must be true or false, not ${show(json.weighted)}`);
  }

  const rawGroups = v.list('groups', json.groups, false);
  const groups = rawGroups.map((group, i) => v.group(labelOf('groups', i, group), group));
  v.duplicates(
    'groups',
    groups.map((group) => group?.id),
  );

  const rawLines = v.list('lines', json.lines, true);
  const lines = rawLines.map((line, i) => v.line(labelOf('lines', i, line), line));
  v.duplicates(
    'lines',
    lines.map((line) => line?.id),
  );

  const remainder = v.remainder(json.remainder);

  const rawCriteria = v.list('criteria', json.criteria, true);
  const criteria = rawCriteria.map((criterion, i) =>
    v.criterion(labelOf('criteria', i, criterion), criterion),
  );
  v.duplicates(
    'criteria',
    criteria.map((criterion) => criterion?.id),
  );

  const cardSnapshot = v.snapshot(json.cardSnapshot);

  if (v.errors.length > 0) return { ok: false, errors: v.errors };
  const template: Template = {
    version: TEMPLATE_VERSION,
    deckSize: deckSize!,
    hand: { size: handSize! },
    groups: groups as TemplateGroup[],
    lines: lines as TemplateLine[],
    remainder,
    criteria: criteria as TemplateCriterion[],
  };
  if (mode !== undefined) template.mode = mode;
  if (weighted !== undefined) template.weighted = weighted;
  if (cardSnapshot !== undefined) template.cardSnapshot = cardSnapshot;
  return { ok: true, template };
}
