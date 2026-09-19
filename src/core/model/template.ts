import type { Expr } from '../criteria/ast';
import type { Description } from '../desc/ast';

/** The only template file version this build reads (TDD §14). */
export const TEMPLATE_VERSION = 1;

export const DECK_SIZE_MIN = 40;
export const DECK_SIZE_MAX = 60;
/** Going first, going second (PRD §5.5). */
export const HAND_SIZES = [5, 6] as const;
/** The game's copy limit, which a line that names one card cannot exceed (PRD §5.1). */
export const NAMED_CARD_MAX = 3;

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
}

/** The unspecified cards; `max: null` is unbounded. */
export interface TemplateRemainder {
  min: number;
  max: number | null;
}

/** The template file (TDD §14). */
export interface Template {
  version: typeof TEMPLATE_VERSION;
  deckSize: number;
  hand: { size: number };
  groups: TemplateGroup[];
  lines: TemplateLine[];
  remainder: TemplateRemainder;
  criteria: TemplateCriterion[];
  /** The fields of every named card when the file was saved; read and written by M2g. */
  cardSnapshot?: Record<string, unknown>;
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

  line(where: string, value: unknown): TemplateLine | undefined {
    if (!isObject(value)) return this.fail(`${where}: must be an object, not ${show(value)}`);
    const id = this.text(where, 'id', value.id);
    const min = this.count(where, 'min', value.min);
    const max = this.count(where, 'max', value.max);
    if (min !== undefined && max !== undefined && min > max)
      this.fail(`${where}: \`min\` ${min} is greater than \`max\` ${max}`);

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
      return { id, min, max, card };
    }
    const text = this.text(where, 'text', value.text);
    if (value.desc !== undefined && !isObject(value.desc))
      this.fail(`${where}: \`desc\` must be a description object, not ${show(value.desc)}`);
    if (id === undefined || min === undefined || max === undefined || text === undefined)
      return undefined;
    // TODO(M2g): the stored AST is authoritative (TDD §14). Until then it is
    // carried through unread, and `text` is what gets parsed.
    return isObject(value.desc)
      ? { id, min, max, text, desc: value.desc as unknown as Description }
      : { id, min, max, text };
  }

  criterion(where: string, value: unknown): TemplateCriterion | undefined {
    if (!isObject(value)) return this.fail(`${where}: must be an object, not ${show(value)}`);
    const id = this.text(where, 'id', value.id);
    const text = this.text(where, 'text', value.text);
    if (value.name !== undefined && typeof value.name !== 'string')
      this.fail(`${where}: \`name\` must be text, not ${show(value.name)}`);
    if (value.expr !== undefined && !isObject(value.expr))
      this.fail(`${where}: \`expr\` must be an expression object, not ${show(value.expr)}`);
    if (id === undefined || text === undefined) return undefined;
    const out: TemplateCriterion = { id, text };
    if (typeof value.name === 'string') out.name = value.name;
    // TODO(M2g): as for a line's `desc` — carried through unread for now.
    if (isObject(value.expr)) out.expr = value.expr as unknown as Expr;
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
 * `desc` and `expr` are accepted and carried through, but only checked to be
 * objects: until M2g makes the stored AST authoritative, the text is parsed.
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

  if (json.cardSnapshot !== undefined && !isObject(json.cardSnapshot))
    v.fail(`\`cardSnapshot\` must be an object, not ${show(json.cardSnapshot)}`);

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
  if (isObject(json.cardSnapshot)) template.cardSnapshot = json.cardSnapshot;
  return { ok: true, template };
}
