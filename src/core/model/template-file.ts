import type { Expr } from '../criteria/ast';
import type { Description } from '../desc/ast';
import type { CardLookup, DescContext } from '../desc/context';
import { criterionMeaning, lineMeaning } from './meaning';
import {
  type CardSnapshot,
  handSizeForMode,
  modeOf,
  type Template,
  type TemplateCriterion,
  type TemplateLine,
  type TemplateRemainder,
  whenOf,
} from './template';

// Writing and reading the template FILE (TDD §14), as against the `Template`
// value the editor holds: the AST beside every text, and the `cardSnapshot`
// that makes "this file gives the same numbers on another machine" a claim
// something can check. Pure — the bytes are main's business.

/** The fields a snapshot records, and the only ones a result can depend on. */
const SNAPSHOT_FIELDS = ['type', 'attribute', 'race', 'level', 'atk', 'def'] as const;

/** Every passcode a description names, directly or through a criterion's expression. */
function passcodesOf(desc: Description, into: Set<number>): void {
  for (const alt of desc.anyOf) if (alt.t === 'card') into.add(alt.passcode);
}

function passcodesOfExpr(expr: Expr, into: Set<number>): void {
  if (expr.op === 'req' || expr.op === 'atMost') passcodesOf(expr.desc, into);
  else for (const arg of expr.args) passcodesOfExpr(arg, into);
}

/**
 * Every card the template NAMES: picker lines, group members, and the
 * passcodes written into a description or a criterion. Those are exactly the
 * cards a result depends on the database through (TDD §14), which is what the
 * snapshot has to cover — a `#89631139` typed into a line is as load-bearing
 * as one chosen from the picker.
 */
export function namedPasscodes(template: Template, ctx: DescContext): number[] {
  const codes = new Set<number>();
  for (const line of template.lines) {
    if ('card' in line) codes.add(line.card.passcode);
    else {
      const meant = lineMeaning(line, ctx);
      if (meant.ok) passcodesOf(meant.desc, codes);
    }
  }
  for (const group of template.groups) for (const card of group.cards) codes.add(card.passcode);
  for (const criterion of template.criteria) {
    const meant = criterionMeaning(criterion, ctx);
    if (meant.ok) passcodesOfExpr(meant.expr, codes);
  }
  return [...codes].sort((a, b) => a - b);
}

export interface TemplateFile {
  template: Template;
  /** Lines and criteria whose text does not parse, so the file keeps the text alone. */
  warnings: string[];
}

/**
 * The template as a FILE: the same value, with the authoritative AST written
 * beside every text and a `cardSnapshot` of every named card.
 *
 * Attaching the AST is what makes a saved file survive a grammar change and an
 * install whose `strings.conf` renames an archetype (TDD §4.5, §19) — a
 * `"Warrior"` resolved to `0x2066` here stays `0x2066` there. A line whose text
 * does not parse is written as text alone and named in a warning: half a
 * meaning is worse than none, and the user can see which line it was.
 *
 * Sorted by passcode, so saving the same template twice gives the same bytes.
 */
export function templateToFile(template: Template, ctx: DescContext): TemplateFile {
  const warnings: string[] = [];

  const lines = template.lines.map((line): TemplateLine => {
    if ('card' in line) return line;
    const meant = lineMeaning(line, ctx);
    if (meant.ok)
      return { id: line.id, min: line.min, max: line.max, text: line.text, desc: meant.desc };
    warnings.push(
      `line ${JSON.stringify(line.id)} does not parse (${meant.message}); it is saved as text alone`,
    );
    return { id: line.id, min: line.min, max: line.max, text: line.text };
  });

  const criteria = template.criteria.map((criterion): TemplateCriterion => {
    const meant = criterionMeaning(criterion, ctx);
    const out: TemplateCriterion = { id: criterion.id, text: criterion.text };
    if (criterion.name !== undefined) out.name = criterion.name;
    // Written out in full, `both` included: which hand a criterion is for is
    // the user's decision, and a file that leaves it to a default is a file
    // whose meaning changes if the default ever does.
    out.when = whenOf(criterion);
    if (meant.ok) out.expr = meant.expr;
    else
      warnings.push(
        `criterion ${JSON.stringify(criterion.id)} does not parse (${meant.message}); it is saved as text alone`,
      );
    return out;
  });

  const cardSnapshot: Record<string, CardSnapshot> = {};
  for (const passcode of namedPasscodes(template, ctx)) {
    const card = ctx.cards.get(passcode);
    // A card this install lacks records nothing: an invented snapshot would be
    // worse than the honest gap, which `snapshotNotices` reads as "not recorded".
    if (card === undefined) continue;
    cardSnapshot[String(passcode)] = {
      type: card.type,
      attribute: card.attribute,
      race: card.race,
      level: card.level,
      atk: card.atk,
      def: card.def,
      setcodes: [...card.setcodes],
    };
  }

  const remainder: TemplateRemainder = { ...template.remainder };
  const mode = modeOf(template);
  return {
    template: {
      version: template.version,
      deckSize: template.deckSize,
      // Written out beside the hand size, and always agreeing with it, so that
      // opening the file gives back the mode that was run (`validateTemplate`).
      hand: { size: handSizeForMode(mode) },
      mode,
      groups: template.groups.map((group) => ({ ...group, cards: [...group.cards] })),
      lines,
      remainder,
      criteria,
      cardSnapshot,
    },
    warnings,
  };
}

/** How a card's fields differ between the file and this install; empty when they agree. */
function differences(saved: CardSnapshot, local: CardSnapshot): string[] {
  const changed = SNAPSHOT_FIELDS.filter((field) => saved[field] !== local[field]).map(
    (field) => `${field} ${saved[field]} → ${local[field]}`,
  );
  if (saved.setcodes.join(',') !== local.setcodes.join(','))
    changed.push(`setcodes [${saved.setcodes.join(', ')}] → [${local.setcodes.join(', ')}]`);
  return changed;
}

/**
 * What this install's card database says about the cards the file recorded
 * (TDD §14). Results depend on the database only through named cards, so a
 * card that is missing here, or whose fields have moved, is the whole of what
 * can make this file score differently than it did — and saying which card and
 * which field is what turns "it might not reproduce" into something checkable.
 *
 * Notices, not errors: the template is perfectly runnable, and what it means
 * is decided by the LOCAL database. Choosing the snapshot's fields over the
 * install's is not offered — see the note in `src/main/services/files.ts`.
 */
export function snapshotNotices(template: Template, cards: CardLookup): string[] {
  const snapshot = template.cardSnapshot;
  if (snapshot === undefined) return [];
  const names = new Map<number, string>();
  for (const line of template.lines)
    if ('card' in line) names.set(line.card.passcode, line.card.name);
  for (const group of template.groups)
    for (const card of group.cards) names.set(card.passcode, card.name);

  const notices: string[] = [];
  for (const [key, saved] of Object.entries(snapshot)) {
    const passcode = Number(key);
    const called = names.get(passcode);
    const label = called === undefined ? `#${passcode}` : `${called} (#${passcode})`;
    const card = cards.get(passcode);
    if (card === undefined) {
      notices.push(
        `${label} is not in this install's card database, but the file recorded it: what this line matches may differ from what it matched when the file was saved`,
      );
      continue;
    }
    const changed = differences(saved, card);
    if (changed.length > 0)
      notices.push(
        `${label} differs from the file's record of it (${changed.join('; ')}); this install's card data is what runs`,
      );
  }
  return notices;
}
