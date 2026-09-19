import type {
  CardHit,
  Template,
  TemplateCard,
  TemplateCriterion,
  TemplateGroup,
  TemplateLine,
} from '../../../shared/types';
import type { CopyRange } from './copy-range';

// Every edit the template editor makes, as a pure function from one template
// to the next (TDD §3: all the renderer logic worth testing is here, and the
// components are markup over it). Nothing mutates what it is given, and an
// edit that changes nothing gives back the SAME object, so zustand's identity
// comparison keeps the screen still.

export const EMPTY_TEMPLATE: Template = {
  version: 1,
  deckSize: 40,
  hand: { size: 5 },
  groups: [],
  lines: [],
  remainder: { min: 0, max: null },
  criteria: [],
};

/** The copy range a line starts at: anything from none to a full three. */
const NEW_LINE_MIN = 0;
const NEW_LINE_MAX = 3;

/** A line that names one card, as opposed to one that describes a kind of card. */
export type CardLine = Extract<TemplateLine, { card: TemplateCard }>;

export function isCardLine(line: TemplateLine): line is CardLine {
  return 'card' in line;
}

export function cardLines(template: Template): CardLine[] {
  return template.lines.filter(isCardLine);
}

/**
 * An id no line of `template` has, `card1` / `line1` upwards. Named cards and
 * descriptions are numbered separately so that the ids read as what they are;
 * a removal frees its number again.
 */
export function nextLineId(template: Template, prefix: 'card' | 'line'): string {
  const taken = new Set(template.lines.map((line) => line.id));
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!taken.has(id)) return id;
  }
}

/** `lines` replaced, everything else kept. */
function withLines(template: Template, lines: TemplateLine[]): Template {
  return { ...template, lines };
}

/** The template with one line mapped; the SAME template when the id is not there. */
function mapLine(
  template: Template,
  id: string,
  edit: (line: TemplateLine) => TemplateLine,
): Template {
  const at = template.lines.findIndex((line) => line.id === id);
  if (at < 0) return template;
  const line = template.lines[at]!;
  const next = edit(line);
  if (next === line) return template;
  return withLines(
    template,
    template.lines.map((old, i) => (i === at ? next : old)),
  );
}

/**
 * The picked card as a line of its own. A card already on a line is not added
 * again — two lines for one card is a `duplicate-card` error (TDD §9) — and
 * the template comes back unchanged, so nothing re-renders.
 */
export function withCardLine(template: Template, card: CardHit): Template {
  const already = template.lines.some(
    (line) => isCardLine(line) && line.card.passcode === card.passcode,
  );
  if (already) return template;
  return withLines(template, [
    ...template.lines,
    {
      id: nextLineId(template, 'card'),
      card: { passcode: card.passcode, name: card.name },
      min: NEW_LINE_MIN,
      max: NEW_LINE_MAX,
    },
  ]);
}

/**
 * An empty description line at the end. Empty is a parse error and `analyze`
 * says so, which is the prompt to type something — the alternative would be a
 * line the tool pretends to understand.
 */
export function withDescriptionLine(template: Template): Template {
  return withSuggestedLine(template, '');
}

/**
 * A description line holding `text`, at the end. This is the one-click split of
 * PRD §6.4: the text is a near miss's `suggestion`, which `analyze` wrote and
 * already checked re-parses, so it is used WORD FOR WORD — the renderer neither
 * composes it nor corrects it (TDD §3). A line saying the same thing may exist
 * already; adding a second one is additive and harmless (PRD §6.1), and the
 * readout says so rather than this refusing.
 */
export function withSuggestedLine(template: Template, text: string): Template {
  return withLines(template, [
    ...template.lines,
    { id: nextLineId(template, 'line'), text, min: NEW_LINE_MIN, max: NEW_LINE_MAX },
  ]);
}

/** Without the line of that id; unchanged — the same object — when there is none. */
export function withoutLine(template: Template, id: string): Template {
  const lines = template.lines.filter((line) => line.id !== id);
  return lines.length === template.lines.length ? template : withLines(template, lines);
}

/**
 * The text of a description line. A card line is left alone: a named card is
 * changed through the picker, not by typing over it. Any AST stored beside the
 * text is dropped, since it is no longer what the text says (TDD §14).
 */
export function withLineText(template: Template, id: string, text: string): Template {
  return mapLine(template, id, (line) =>
    isCardLine(line) ? line : { id: line.id, min: line.min, max: line.max, text },
  );
}

export function withLineRange(template: Template, id: string, { min, max }: CopyRange): Template {
  return mapLine(template, id, (line) =>
    line.min === min && line.max === max ? line : { ...line, min, max },
  );
}

/**
 * The line moved one place up (`by` -1) or down (`by` +1). A line already at
 * the end it is asked to move towards stays where it is, and the template
 * comes back unchanged — the button for it is disabled, and this is the other
 * half of that.
 */
export function withMovedLine(template: Template, id: string, by: number): Template {
  const at = template.lines.findIndex((line) => line.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= template.lines.length) return template;
  const lines = [...template.lines];
  const [line] = lines.splice(at, 1);
  lines.splice(to, 0, line!);
  return withLines(template, lines);
}

export function withDeckSize(template: Template, deckSize: number): Template {
  return template.deckSize === deckSize ? template : { ...template, deckSize };
}

export function withHandSize(template: Template, size: number): Template {
  return template.hand.size === size ? template : { ...template, hand: { size } };
}

// --- criteria --------------------------------------------------------------

/** An id no criterion of `template` has, `c1` upwards; a removal frees its number again. */
export function nextCriterionId(template: Template): string {
  const taken = new Set(template.criteria.map((criterion) => criterion.id));
  for (let n = 1; ; n++) {
    const id = `c${n}`;
    if (!taken.has(id)) return id;
  }
}

function withCriteria(template: Template, criteria: TemplateCriterion[]): Template {
  return { ...template, criteria };
}

function mapCriterion(
  template: Template,
  id: string,
  edit: (criterion: TemplateCriterion) => TemplateCriterion,
): Template {
  const at = template.criteria.findIndex((criterion) => criterion.id === id);
  if (at < 0) return template;
  const criterion = template.criteria[at]!;
  const next = edit(criterion);
  if (next === criterion) return template;
  return withCriteria(
    template,
    template.criteria.map((old, i) => (i === at ? next : old)),
  );
}

/**
 * An empty criterion at the end. Empty is a parse error, as an empty line is,
 * and for the same reason: the prompt to type something.
 */
export function withCriterion(template: Template): Template {
  return withCriteria(template, [
    ...template.criteria,
    { id: nextCriterionId(template), text: '' },
  ]);
}

export function withoutCriterion(template: Template, id: string): Template {
  const criteria = template.criteria.filter((criterion) => criterion.id !== id);
  return criteria.length === template.criteria.length ? template : withCriteria(template, criteria);
}

/**
 * The text of a criterion. Any AST stored beside it is dropped, since it is no
 * longer what the text says (TDD §14) — the same rule `withLineText` follows.
 */
export function withCriterionText(template: Template, id: string, text: string): Template {
  return mapCriterion(template, id, (criterion) => {
    const next: TemplateCriterion = { id: criterion.id, text };
    if (criterion.name !== undefined) next.name = criterion.name;
    return next;
  });
}

/**
 * The criterion's own name — the example's "A, B and any monster" — which is
 * what the readouts call it instead of its id. Trimmed; cleared to nothing, the
 * field goes away rather than being stored blank, so a saved template says
 * "unnamed" the one way.
 */
export function withCriterionName(template: Template, id: string, name: string): Template {
  const trimmed = name.trim();
  return mapCriterion(template, id, (criterion) => {
    if ((criterion.name ?? '') === trimmed) return criterion;
    const next: TemplateCriterion = { id: criterion.id, text: criterion.text };
    if (trimmed !== '') next.name = trimmed;
    if (criterion.expr !== undefined) next.expr = criterion.expr;
    return next;
  });
}

/** One place up (`by` -1) or down (`by` +1); a criterion already at that end does not move. */
export function withMovedCriterion(template: Template, id: string, by: number): Template {
  const at = template.criteria.findIndex((criterion) => criterion.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= template.criteria.length) return template;
  const criteria = [...template.criteria];
  const [criterion] = criteria.splice(at, 1);
  criteria.splice(to, 0, criterion!);
  return withCriteria(template, criteria);
}

// --- groups ----------------------------------------------------------------

export function nextGroupId(template: Template): string {
  const taken = new Set(template.groups.map((group) => group.id));
  for (let n = 1; ; n++) {
    const id = `g${n}`;
    if (!taken.has(id)) return id;
  }
}

function withGroups(template: Template, groups: TemplateGroup[]): Template {
  return { ...template, groups };
}

function mapGroup(
  template: Template,
  id: string,
  edit: (group: TemplateGroup) => TemplateGroup,
): Template {
  const at = template.groups.findIndex((group) => group.id === id);
  if (at < 0) return template;
  const group = template.groups[at]!;
  const next = edit(group);
  if (next === group) return template;
  return withGroups(
    template,
    template.groups.map((old, i) => (i === at ? next : old)),
  );
}

/**
 * A new, empty group. The name is what `{name}` in a description resolves
 * through, so it is trimmed, and a blank one is refused rather than made into
 * a group no description could ever reach.
 */
export function withGroup(template: Template, name: string): Template {
  const trimmed = name.trim();
  if (trimmed === '') return template;
  return withGroups(template, [
    ...template.groups,
    { id: nextGroupId(template), name: trimmed, cards: [] },
  ]);
}

export function withRenamedGroup(template: Template, id: string, name: string): Template {
  const trimmed = name.trim();
  if (trimmed === '') return template;
  return mapGroup(template, id, (group) =>
    group.name === trimmed ? group : { ...group, name: trimmed },
  );
}

/**
 * Without that group. The LINES are left exactly as they were: a description
 * that named it keeps saying `{name}`, and `analyze` reports that as a parse
 * error naming the group that is gone. Rewriting the user's text to cover the
 * deletion up would be the renderer deciding semantics (TDD §3).
 */
export function withoutGroup(template: Template, id: string): Template {
  const groups = template.groups.filter((group) => group.id !== id);
  return groups.length === template.groups.length ? template : withGroups(template, groups);
}

export function withGroupCard(template: Template, id: string, card: CardHit): Template {
  return mapGroup(template, id, (group) =>
    group.cards.some((member) => member.passcode === card.passcode)
      ? group
      : { ...group, cards: [...group.cards, { passcode: card.passcode, name: card.name }] },
  );
}

export function withoutGroupCard(template: Template, id: string, passcode: number): Template {
  return mapGroup(template, id, (group) => {
    const cards = group.cards.filter((member) => member.passcode !== passcode);
    return cards.length === group.cards.length ? group : { ...group, cards };
  });
}
