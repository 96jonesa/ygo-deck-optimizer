import { ATTRIBUTE_DIVINE, RACE_BEAST, RACE_BEASTWARRIOR } from '../cards/constants';
import {
  attributeName,
  kindEntry,
  MONSTER_FLAGS,
  monsterFlagEntry,
  raceName,
  stSubkindEntry,
} from '../cards/vocabulary';
import {
  type Alternative,
  type Clause,
  type Description,
  LEVEL_MAX,
  LEVEL_MIN,
  type Stat,
  type ValueSet,
} from './ast';
import type { DescContext } from './context';

/** `0x2066`: lower-case, unpadded. */
export function formatSetcode(code: number): string {
  return `0x${code.toString(16)}`;
}

/** `"Warrior":0x2066`, the unambiguous spelling of an archetype; `"?"` stands for no name. */
export function formatArchetype(name: string | undefined, code: number): string {
  return `"${name ?? '?'}":${formatSetcode(code)}`;
}

/**
 * The most natural of the spellings the grammar has for a level set: `4`,
 * `4 or lower`, `8 or higher`, `1-4`, `1/3/5`. `or lower` reaches down to
 * `LEVEL_MIN` and `or higher` up to `LEVEL_MAX`, so they are only used for
 * runs that touch that end.
 */
export function formatLevel(level: readonly number[]): string {
  const first = level[0]!;
  const last = level[level.length - 1]!;
  if (level.length === 1) return `${first}`;
  if (last - first + 1 !== level.length) return level.join('/');
  if (first === LEVEL_MIN) return `${last} or lower`;
  if (last === LEVEL_MAX) return `${first} or higher`;
  return `${first}-${last}`;
}

/** `?`, `1500`, `1500 or more`, `1500 or less`, `1000-2000`. */
export function formatStat(stat: Stat): string {
  if (stat === '?') return '?';
  if (stat.min === stat.max) return `${stat.min}`;
  if (stat.max === null) return `${stat.min} or more`;
  if (stat.min === 0) return `${stat.max} or less`;
  return `${stat.min}-${stat.max}`;
}

function valuesOf(set: ValueSet<number>): number[] {
  return 'in' in set ? set.in : set.notIn;
}

function printValueSet(set: ValueSet<number>, nameOf: (bit: number) => string | undefined) {
  const names = valuesOf(set).map((bit) => nameOf(bit) ?? '?');
  return `${'in' in set ? '' : 'non-'}${names.join('/')}`;
}

function printArchetype(code: number, ctx: Pick<DescContext, 'setnames'>): string {
  const name = ctx.setnames?.nameOf(code);
  // A name the grammar cannot carry back to this code is printed as unknown.
  const usable =
    name !== undefined && !name.includes('"') && ctx.setnames?.lookup(name).includes(code);
  return formatArchetype(usable ? name : undefined, code);
}

/**
 * `DIVINE Beast` lexes as the Type `Divine-Beast` — hyphens and spaces are
 * equivalent inside a vocabulary word — so the one clause in which an
 * Attribute list ending in DIVINE would run into a Type list starting with
 * Beast or Beast-Warrior is printed Types first.
 */
function attributeRunsIntoRace(clause: Clause): boolean {
  if (!clause.attributes || !clause.races || !('in' in clause.races)) return false;
  const first = clause.races.in[0];
  return (
    valuesOf(clause.attributes).at(-1) === ATTRIBUTE_DIVINE &&
    (first === RACE_BEAST || first === RACE_BEASTWARRIOR)
  );
}

function printClause(clause: Clause, ctx: Pick<DescContext, 'setnames'>): string {
  const words: string[] = [];
  if (clause.level) words.push(`level ${formatLevel(clause.level)}`);
  if (clause.atk !== undefined) words.push(`ATK ${formatStat(clause.atk)}`);
  if (clause.def !== undefined) words.push(`DEF ${formatStat(clause.def)}`);
  const attributes = clause.attributes && printValueSet(clause.attributes, attributeName);
  const races = clause.races && printValueSet(clause.races, raceName);
  if (attributeRunsIntoRace(clause)) words.push(races!, attributes!);
  else {
    if (attributes) words.push(attributes);
    if (races) words.push(races);
  }
  for (const flag of MONSTER_FLAGS) {
    const want = clause.flags?.[flag];
    if (want !== undefined) words.push(want ? flag : `non-${flag}`);
  }
  if (clause.stSubkinds) words.push(clause.stSubkinds.join('/'));
  for (const code of clause.archetypes ?? []) words.push(printArchetype(code, ctx));
  words.push(clause.kinds ? clause.kinds.join('/') : 'card');
  return words.join(' ');
}

function printAlternative(alt: Alternative, ctx: Pick<DescContext, 'setnames' | 'groups'>) {
  switch (alt.t) {
    case 'card':
      return `#${alt.passcode}`;
    case 'group': {
      const name = ctx.groups.nameOf(alt.groupId);
      const usable = name !== undefined && !name.includes('}');
      return `{${usable ? name : '?'}}`;
    }
    case 'clause':
      return printClause(alt.clause, ctx);
  }
}

/**
 * The canonical text of a canonical description (TDD §5.2):
 * `parse(print(d, ctx), ctx)` is `d` for every `d` the grammar can express.
 * Cards print as `#passcode` because names are not unique; archetypes always
 * carry their code, as `"Name":0xCODE`, because names are ambiguous and get
 * reassigned between `strings.conf` versions (TDD §4.5). Qualifiers print in
 * one fixed order — level, ATK, DEF, Attributes, Types, flags, sub-kinds,
 * archetypes — and the kind word (or `card`) always closes the clause, so no
 * `or` between alternatives can be read as `or lower`.
 */
export function print(desc: Description, ctx: Pick<DescContext, 'setnames' | 'groups'>): string {
  return desc.anyOf.map((alt) => printAlternative(alt, ctx)).join(' or ');
}

function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

function echoValueSet(set: ValueSet<number>, nameOf: (bit: number) => string | undefined) {
  // Alphabetical reads better than the AST's bit order: "FIRE or WATER".
  const names = valuesOf(set)
    .map((bit) => nameOf(bit) ?? '?')
    .sort();
  if ('in' in set) return orList(names);
  if (names.length === 1) return `Not ${names[0]}`;
  return `Neither ${names.slice(0, -1).join(', ')} nor ${names.at(-1)}`;
}

function echoClause(clause: Clause, ctx: DescContext): string {
  const parts: string[] = [];
  if (clause.level) parts.push(`Level ${formatLevel(clause.level)}`);
  if (clause.atk !== undefined) parts.push(`ATK ${formatStat(clause.atk)}`);
  if (clause.def !== undefined) parts.push(`DEF ${formatStat(clause.def)}`);
  if (clause.attributes) parts.push(echoValueSet(clause.attributes, attributeName));
  if (clause.races) parts.push(echoValueSet(clause.races, raceName));
  for (const flag of MONSTER_FLAGS) {
    const want = clause.flags?.[flag];
    if (want !== undefined) parts.push(`${want ? '' : 'Non-'}${monsterFlagEntry(flag).name}`);
  }
  for (const code of clause.archetypes ?? []) {
    const name = ctx.setnames?.nameOf(code);
    parts.push(name === undefined ? `Archetype ${formatSetcode(code)}` : `"${name}"`);
  }
  const subkinds = orList((clause.stSubkinds ?? []).map((s) => stSubkindEntry(s).name));
  const kinds = orList((clause.kinds ?? []).map((kind) => kindEntry(kind).name));
  if (kinds !== '') parts.push(subkinds === '' ? kinds : `${subkinds} ${kinds}`);
  else parts.push(parts.length === 0 ? 'Any card' : 'Card');
  return parts.join(' · ');
}

function echoAlternative(alt: Alternative, ctx: DescContext): string {
  switch (alt.t) {
    case 'card': {
      const card = ctx.cards.get(alt.passcode);
      if (card === undefined) return `Unknown card #${alt.passcode}`;
      // Two cards can share a name; the passcode tells them apart.
      return ctx.cards.findByName(card.name).length > 1
        ? `${card.name} (#${alt.passcode})`
        : card.name;
    }
    case 'group':
      return ctx.groups.nameOf(alt.groupId) ?? 'Unknown group';
    case 'clause':
      return echoClause(alt.clause, ctx);
  }
}

/**
 * The human-facing readout shown next to an input (PRD "parse echo"):
 * `Level 4 · Monster`, `FIRE or WATER · Beast-Warrior · Monster`,
 * `Normal Spell`; a card or group reads back as its name. It says exactly
 * what the description constrains and nothing else — `level 4` echoes as
 * `Level 4 · Card`. Not parseable; `print` is the canonical text.
 */
export function echo(desc: Description, ctx: DescContext): string {
  return desc.anyOf.map((alt) => echoAlternative(alt, ctx)).join(', or ');
}
