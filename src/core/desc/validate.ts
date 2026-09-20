import {
  ATTRIBUTE_VOCABULARY,
  KINDS,
  type Kind,
  MONSTER_FLAGS,
  type MonsterFlag,
  RACE_VOCABULARY,
  ST_SUBKINDS,
  type StSubkind,
} from '../cards/vocabulary';
import {
  type Attribute,
  type Clause,
  canonicalize,
  type Description,
  LEVEL_MAX,
  LEVEL_MIN,
  type Race,
  SETCODE_MAX,
  type Stat,
  type ValueSet,
} from './ast';

// Checking a description AST that came from outside (TDD §14). The stored AST
// is what the engine judges, and it arrives from a template file or over IPC as
// `unknown`: the parser can no longer be relied on to have built it. Everything
// the box model and `evaluate` assume of a `Description` is asserted here, once,
// so that `implies` never meets a `level: ['four']`.
//
// Purely structural, like `canonicalize`: no game rule is applied and nothing
// is resolved against a card database. The clause invariants the TEXT grammar
// keeps beyond the types (`stSubkinds` coming with its kinds, and the rest of
// the list in `ast.ts`) are not asserted — they are properties of the image of
// `parse`, not of the model, and an AST that breaks one still names a set of
// cards the engine can reason about soundly.

export type ValidateDescriptionResult =
  | { ok: true; desc: Description }
  | { ok: false; errors: string[] };

const ATTRIBUTE_BITS: readonly number[] = ATTRIBUTE_VOCABULARY.map((entry) => entry.bit);
const RACE_BITS: readonly number[] = RACE_VOCABULARY.map((entry) => entry.bit);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Collects every problem — a half-read AST is never handed on, so there is no reason to stop early. */
class DescValidator {
  readonly errors: string[] = [];

  fail(message: string): void {
    this.errors.push(message);
  }

  /** A list of words from a closed vocabulary, e.g. `kinds`, `stSubkinds`. */
  words<T extends string>(
    where: string,
    field: string,
    value: unknown,
    allowed: readonly T[],
    what: string,
  ): T[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.fail(`${where}: \`${field}\` must be a list, not ${show(value)}`);
      return undefined;
    }
    const out: T[] = [];
    value.forEach((word, i) => {
      if (typeof word === 'string' && (allowed as readonly string[]).includes(word))
        out.push(word as T);
      else
        this.fail(
          `${where}: \`${field}[${i}]\` is ${show(word)}; the ${what} are ${allowed.join(', ')}`,
        );
    });
    return out;
  }

  /** A list of whole numbers, each within `[min, max]`. */
  numbers(
    where: string,
    field: string,
    value: unknown,
    min: number,
    max: number,
    what: string,
  ): number[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.fail(`${where}: \`${field}\` must be a list, not ${show(value)}`);
      return undefined;
    }
    const out: number[] = [];
    value.forEach((n, i) => {
      if (isWhole(n) && n >= min && n <= max) out.push(n);
      else this.fail(`${where}: \`${field}[${i}]\` is ${show(n)}; ${what} is ${min} to ${max}`);
    });
    return out;
  }

  /** A list of bit values from a vocabulary table: an Attribute or an official Type. */
  bits(where: string, field: string, value: unknown, allowed: readonly number[]): number[] {
    const out: number[] = [];
    if (!Array.isArray(value)) {
      this.fail(`${where}: \`${field}\` must be a list, not ${show(value)}`);
      return out;
    }
    value.forEach((bit, i) => {
      if (isWhole(bit) && allowed.includes(bit)) out.push(bit);
      else this.fail(`${where}: \`${field}[${i}]\` is ${show(bit)}, which is no such bit`);
    });
    return out;
  }

  valueSet<T extends number>(
    where: string,
    field: string,
    value: unknown,
    allowed: readonly number[],
  ): ValueSet<T> | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      this.fail(`${where}: \`${field}\` must be { in } or { notIn }, not ${show(value)}`);
      return undefined;
    }
    const positive = value.in !== undefined;
    const negative = value.notIn !== undefined;
    if (positive === negative) {
      this.fail(
        positive
          ? `${where}: \`${field}\` is either { in } or { notIn }, never both`
          : `${where}: \`${field}\` must say \`in\` or \`notIn\``,
      );
      return undefined;
    }
    return positive
      ? ({ in: this.bits(where, `${field}.in`, value.in, allowed) } as ValueSet<T>)
      : ({ notIn: this.bits(where, `${field}.notIn`, value.notIn, allowed) } as ValueSet<T>);
  }

  stat(where: string, field: 'atk' | 'def', value: unknown): Stat | undefined {
    if (value === undefined) return undefined;
    if (value === '?') return '?';
    if (!isObject(value)) {
      this.fail(`${where}: \`${field}\` must be "?" or { min, max }, not ${show(value)}`);
      return undefined;
    }
    const { min, max } = value;
    const unbounded = max === null || max === undefined;
    if (!isWhole(min) || min < 0 || (!unbounded && !isWhole(max))) {
      this.fail(`${where}: \`${field}\`: ${show(min)} to ${show(max)} is not a range`);
      return undefined;
    }
    if (!unbounded && (max as number) < min) {
      this.fail(`${where}: \`${field}\`: ${min} to ${max} is not a range`);
      return undefined;
    }
    return { min, max: unbounded ? null : (max as number) };
  }

  flags(where: string, value: unknown): Partial<Record<MonsterFlag, boolean>> | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      this.fail(`${where}: \`flags\` must be an object, not ${show(value)}`);
      return undefined;
    }
    const out: Partial<Record<MonsterFlag, boolean>> = {};
    for (const [flag, want] of Object.entries(value)) {
      if (!(MONSTER_FLAGS as readonly string[]).includes(flag))
        this.fail(`${where}: \`flags\` has no ${show(flag)}; they are ${MONSTER_FLAGS.join(', ')}`);
      else if (typeof want !== 'boolean')
        this.fail(`${where}: \`flags.${flag}\` must be true or false, not ${show(want)}`);
      else out[flag as MonsterFlag] = want;
    }
    return out;
  }

  clause(where: string, value: unknown): Clause | undefined {
    if (!isObject(value)) {
      this.fail(`${where}: \`clause\` must be an object, not ${show(value)}`);
      return undefined;
    }
    const at = `${where}.clause`;
    const clause: Clause = {};
    const kinds = this.words<Kind>(at, 'kinds', value.kinds, KINDS, 'kinds');
    if (kinds !== undefined) clause.kinds = kinds;
    const flags = this.flags(at, value.flags);
    if (flags !== undefined) clause.flags = flags;
    const stSubkinds = this.words<StSubkind>(
      at,
      'stSubkinds',
      value.stSubkinds,
      ST_SUBKINDS,
      'sub-kinds',
    );
    if (stSubkinds !== undefined) clause.stSubkinds = stSubkinds;
    const attributes = this.valueSet<Attribute>(at, 'attributes', value.attributes, ATTRIBUTE_BITS);
    if (attributes !== undefined) clause.attributes = attributes;
    const races = this.valueSet<Race>(at, 'races', value.races, RACE_BITS);
    if (races !== undefined) clause.races = races;
    const level = this.numbers(at, 'level', value.level, LEVEL_MIN, LEVEL_MAX, 'a Level');
    if (level !== undefined) clause.level = level;
    const atk = this.stat(at, 'atk', value.atk);
    if (atk !== undefined) clause.atk = atk;
    const def = this.stat(at, 'def', value.def);
    if (def !== undefined) clause.def = def;
    const archetypes = this.numbers(
      at,
      'archetypes',
      value.archetypes,
      1,
      SETCODE_MAX,
      'a setcode',
    );
    if (archetypes !== undefined) clause.archetypes = archetypes;
    return clause;
  }
}

/**
 * A `Description` read out of a template file or an IPC payload (TDD §14),
 * every problem reported. What comes back is the CANONICAL form, so that two
 * descriptions that agree stringify alike — which is how `resolveTemplate`
 * keys its match-matrix columns and how a stored AST is compared with a fresh
 * parse of the text beside it. Fields the AST has no place for are dropped,
 * not carried: `canonicalize` rebuilds every object from the fields it knows.
 *
 * `where` heads each message — `lines[2] ("l3"): \`desc\`` — so the person who
 * wrote the file can find the thing being complained about.
 */
export function validateDescription(value: unknown, where: string): ValidateDescriptionResult {
  const v = new DescValidator();
  if (!isObject(value))
    return { ok: false, errors: [`${where}: must be { anyOf: [...] }, not ${show(value)}`] };
  if (!Array.isArray(value.anyOf))
    return { ok: false, errors: [`${where}: \`anyOf\` must be a list, not ${show(value.anyOf)}`] };
  if (value.anyOf.length === 0)
    return { ok: false, errors: [`${where}: \`anyOf\` is empty; a description matches something`] };

  const anyOf = value.anyOf.map((alt, i) => {
    const at = `${where}.anyOf[${i}]`;
    if (!isObject(alt)) {
      v.fail(`${at}: must be an object, not ${show(alt)}`);
      return undefined;
    }
    switch (alt.t) {
      case 'card': {
        if (!isWhole(alt.passcode) || alt.passcode <= 0) {
          v.fail(`${at}: \`passcode\` must be a whole number above 0, not ${show(alt.passcode)}`);
          return undefined;
        }
        return { t: 'card' as const, passcode: alt.passcode };
      }
      case 'group': {
        if (typeof alt.groupId !== 'string' || alt.groupId === '') {
          v.fail(`${at}: \`groupId\` must be non-empty text, not ${show(alt.groupId)}`);
          return undefined;
        }
        return { t: 'group' as const, groupId: alt.groupId };
      }
      case 'clause': {
        const clause = v.clause(at, alt.clause);
        return clause === undefined ? undefined : { t: 'clause' as const, clause };
      }
      default:
        v.fail(`${at}: \`t\` must be "card", "group" or "clause", not ${show(alt.t)}`);
        return undefined;
    }
  });

  if (v.errors.length > 0) return { ok: false, errors: v.errors };
  return { ok: true, desc: canonicalize({ anyOf: anyOf as Description['anyOf'] }) };
}
