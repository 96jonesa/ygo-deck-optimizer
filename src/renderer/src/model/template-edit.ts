import type {
  CardHit,
  Description,
  DrawSpec,
  Template,
  TemplateCard,
  TemplateCriterion,
  TemplateGroup,
  TemplateLine,
} from '../../../shared/types';
import type { CopyRange } from './copy-range';
import { type CriterionWhen, handSizeForMode, type RunMode } from './deck-form';
import type { DrawDraft } from './draw-view';

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

/** A criterion's parsed form; named here so the AST can be walked without importing core. */
type CriterionExpr = NonNullable<TemplateCriterion['expr']>;

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
    isCardLine(line) ? line : { ...withoutDesc(line), text },
  );
}

/**
 * A line with the parsed form dropped and EVERYTHING ELSE kept. Typing over the
 * text takes the AST away and nothing more — the copy range, and what the line
 * DRAWS (PRD §5.7), are the line's own and are not what changed.
 *
 * It is written this way because the criterion side of exactly this rule was
 * once got wrong: those transforms rebuilt the criterion out of the fields they
 * knew about, which silently reset the `when` tag of any criterion whose text
 * was typed into. Listing the fields to keep is how that happens.
 */
function withoutDesc(line: TemplateLine): TemplateLine {
  if (isCardLine(line) || line.desc === undefined) return line;
  const { desc: _dropped, ...rest } = line;
  return rest;
}

export function withLineRange(template: Template, id: string, { min, max }: CopyRange): Template {
  return mapLine(template, id, (line) =>
    line.min === min && line.max === max ? line : { ...line, min, max },
  );
}

/**
 * What the line DRAWS (PRD §5.7), or `null` for a line that is not a draw card.
 *
 * A line IS a draw card exactly when it carries the field, so `null` DELETES it
 * rather than storing `undefined`: unticking the box has to give back the line
 * the template would have had if the box had never been ticked, which is also
 * the line a template file records. `oncePerTurn` follows the same rule one
 * level down — it is `true` or absent, never `false` — because "once" is a
 * property of the card and `false` is what every card that is not once-per-turn
 * already means.
 *
 * The text, the copy range and any parsed form stay: what a line draws is not
 * what it matches, so the AST beside it is still a faithful record of the text
 * (TDD §14) — the rule `withCriterionWhen` follows on the other side.
 */
export function withLineDraw(template: Template, id: string, draw: DrawDraft | null): Template {
  return mapLine(template, id, (line) => {
    if (draw === null) return withoutDraw(line);
    const next: DrawSpec =
      draw.oncePerTurn === true ? { n: draw.n, oncePerTurn: true } : { n: draw.n };
    const had = line.draw;
    if (had !== undefined && had.n === next.n && had.oncePerTurn === next.oncePerTurn) return line;
    return { ...withoutDraw(line), draw: next };
  });
}

/** A line with `draw` gone and everything else kept; the SAME line when it had none. */
function withoutDraw(line: TemplateLine): TemplateLine {
  if (line.draw === undefined) return line;
  if (isCardLine(line)) {
    const { draw: _dropped, ...rest } = line;
    return rest;
  }
  const { draw: _dropped, ...rest } = line;
  return rest;
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

/**
 * An imported `.ydk` decklist, laid over the template: its LINES and its deck
 * size, and nothing else (PRD §9).
 *
 * What the deck becomes — which card a passcode is, how many copies a line
 * holds, what the deck size is — was decided in main and arrives whole; this
 * only says where it goes. And it goes over the lines alone: a decklist states
 * no criteria and no groups, and throwing away the part the user wrote
 * themselves would be the worst possible reading of "import". The hand size
 * and the remainder are the user's too.
 */
export function withImportedDeck(template: Template, imported: Template): Template {
  return { ...template, deckSize: imported.deckSize, lines: [...imported.lines] };
}

export function withDeckSize(template: Template, deckSize: number): Template {
  return template.deckSize === deckSize ? template : { ...template, deckSize };
}

export function withHandSize(template: Template, size: number): Template {
  return template.hand.size === size ? template : { ...template, hand: { size } };
}

/**
 * The run mode, and the hand size that goes with it (PRD §5.5). The two are
 * set TOGETHER, always: `mode` is what the template means and `hand.size` is
 * the size its criteria are expanded at, and `core` refuses a template whose
 * two disagree. Going first is a hand of five; going second and the average
 * of the two are both judged at six, since the average must be able to score
 * the larger hand.
 */
export function withMode(template: Template, mode: RunMode): Template {
  const size = handSizeForMode(mode);
  if (template.mode === mode && template.hand.size === size) return template;
  return { ...template, mode, hand: { size } };
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
 * The criterion WITHOUT its stored AST, and with everything else untouched.
 *
 * Dropping the AST is the rule of TDD §14: a stored `expr` may be trusted
 * because it always came from text that still means that, so an edit to the
 * text takes it away. Keeping everything else is the other half of the rule,
 * and it was got wrong here — these transforms used to rebuild the criterion
 * out of `id`, `text` and `name`, which silently reset the `when` tag of any
 * criterion whose text was typed into. Nothing but the parsed form goes.
 */
function withoutExpr(criterion: TemplateCriterion): TemplateCriterion {
  if (criterion.expr === undefined) return criterion;
  const { expr: _dropped, ...rest } = criterion;
  return rest;
}

/**
 * The text of a criterion. Any AST stored beside it is dropped, since it is no
 * longer what the text says (TDD §14) — the same rule `withLineText` follows.
 * The tag and the weight stay: neither is text, and neither is what changed.
 */
export function withCriterionText(template: Template, id: string, text: string): Template {
  return mapCriterion(template, id, (criterion) => ({ ...withoutExpr(criterion), text }));
}

/**
 * The criterion's own name — the example's "A, B and any monster" — which is
 * what the readouts call it instead of its id. Trimmed; cleared to nothing, the
 * field goes away rather than being stored blank, so a saved template says
 * "unnamed" the one way. The stored AST is KEPT: a name is not a description.
 */
export function withCriterionName(template: Template, id: string, name: string): Template {
  const trimmed = name.trim();
  return mapCriterion(template, id, (criterion) => {
    if ((criterion.name ?? '') === trimmed) return criterion;
    const { name: _old, ...rest } = criterion;
    return trimmed === '' ? rest : { ...rest, name: trimmed };
  });
}

/**
 * Which hand the criterion is judged for (PRD §5.5). The stored AST is KEPT:
 * the tag says when the criterion is asked, not what it asks, so the text and
 * its parsed form still agree — unlike `withCriterionText`, which drops it.
 */
export function withCriterionWhen(template: Template, id: string, when: CriterionWhen): Template {
  return mapCriterion(template, id, (criterion) => {
    if ((criterion.when ?? 'both') === when) return criterion;
    return { ...criterion, when };
  });
}

/**
 * What a criterion is WORTH when the template weights its criteria (PRD §5.6).
 * The stored AST is KEPT, for the reason `withCriterionWhen` keeps it: a weight
 * says what meeting the criterion is worth, not what it asks for, so the text
 * and its parsed form still agree.
 *
 * A weight of 1 is stored as no weight at all, so that one criterion has one
 * spelling: a template where nothing is weighted is the template it would have
 * been, byte for byte, and the file a criterion of weight 1 is saved to is the
 * file it was before weighting existed.
 */
export function withCriterionWeight(template: Template, id: string, weight: number): Template {
  return mapCriterion(template, id, (criterion) => {
    if ((criterion.weight ?? 1) === weight) return criterion;
    const { weight: _old, ...rest } = criterion;
    return weight === 1 ? rest : { ...rest, weight };
  });
}

/**
 * Whether the player would STOP for this criterion (PRD §5.7): `true` and an
 * opening hand that already meets it activates no draw card. Andy's own
 * sentence is the definition — unchecked means "I would stop for this", checked
 * means "I am willing to lose this by drawing" — and it is the box's LABEL that
 * is inverted, not the field: `stop: true` is the one that stops.
 *
 * The stored AST is KEPT, for the reason `withCriterionWhen` keeps it: the flag
 * says WHEN the criterion is asked, not what it asks for.
 *
 * `false` is stored as no field at all, the rule `withCriterionWeight` follows
 * for a weight of 1. Not stopping is the identity — it is what every criterion
 * of every template written before draw cards existed already means — so
 * turning the box off gives back, byte for byte, the criterion that was there.
 */
export function withCriterionStop(template: Template, id: string, stop: boolean): Template {
  return mapCriterion(template, id, (criterion) => {
    if ((criterion.stop ?? false) === stop) return criterion;
    const { stop: _old, ...rest } = criterion;
    return stop ? { ...rest, stop } : rest;
  });
}

/**
 * Whether the criteria are weighted at all (PRD §5.6). The per-criterion
 * weights are LEFT ALONE either way: the switch decides whether they count, so
 * turning it off and on again gives back exactly what was set — and turning it
 * off gives back, exactly, the template's unweighted answer.
 */
export function withWeighted(template: Template, weighted: boolean): Template {
  if ((template.weighted ?? false) === weighted) return template;
  return { ...template, weighted };
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

/** Whether a description names the group `id` directly. */
function descNamesGroup(desc: Description, id: string): boolean {
  return desc.anyOf.some((alt) => alt.t === 'group' && alt.groupId === id);
}

function exprNamesGroup(expr: CriterionExpr, id: string): boolean {
  if (expr.op === 'req' || expr.op === 'atMost') return descNamesGroup(expr.desc, id);
  // A group named as the card you draw, or in a `finally` part, is named just as
  // much as one named anywhere else: miss a branch and the stored AST survives a
  // deletion that made it meaningless.
  if (expr.op === 'split')
    return [expr.five, expr.sixth, expr.whole].some(
      (part) => part !== undefined && exprNamesGroup(part, id),
    );
  return expr.args.some((arg) => exprNamesGroup(arg, id));
}

/**
 * Without that group — and without the stored AST of any line or criterion
 * that named it.
 *
 * The user's TEXT is left exactly as it was: a description that said
 * `{starter}` keeps saying it, and rewriting it to cover the deletion up would
 * be the renderer deciding semantics (TDD §3). What goes is the parsed form
 * beside it, for the reason the whole authoritative-AST rule rests on (TDD
 * §14, `core/model/meaning.ts`): a stored AST may be trusted BECAUSE it always
 * came from text that still means that, which is why every edit to the text
 * drops it. Deleting a group changes what `{starter}` can mean, so the AST it
 * produced is no longer a faithful record of the text and must not outlive it.
 *
 * The practical difference is the diagnosis. Keeping the AST leaves the line
 * running as a reference to a group that is gone, and the reader gets a stale-
 * text warning plus "this line can hold no card" — two messages, neither of
 * which says what happened. Dropping it re-parses the text and gives the one
 * message that does: no group called `starter`.
 *
 * A RENAME is the opposite case and is left alone: the id still names the same
 * group, so the AST is the faithful record and the text is the stale half —
 * which is exactly what the stale-text warning then says.
 */
export function withoutGroup(template: Template, id: string): Template {
  const groups = template.groups.filter((group) => group.id !== id);
  if (groups.length === template.groups.length) return template;

  const lines = template.lines.map((line) =>
    !isCardLine(line) && line.desc !== undefined && descNamesGroup(line.desc, id)
      ? withoutDesc(line)
      : line,
  );
  const criteria = template.criteria.map((criterion) =>
    criterion.expr === undefined || !exprNamesGroup(criterion.expr, id)
      ? criterion
      : withoutExpr(criterion),
  );
  return { ...template, groups, lines, criteria };
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

/** One group's checkbox under a line that names a card. */
export interface GroupBox {
  id: string;
  name: string;
  checked: boolean;
}

/**
 * The group checkboxes under a line naming card `passcode`: one per group,
 * ticked iff the group holds it. A box has no state of its own — the group's
 * card list is the one record of membership — so a card typed into a group,
 * a rename, or a line removed and added back all show here without an edit of
 * their own. Ticking and unticking are `withGroupCard` and `withoutGroupCard`.
 */
export function groupBoxes(groups: readonly TemplateGroup[], passcode: number): GroupBox[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    checked: group.cards.some((member) => member.passcode === passcode),
  }));
}
