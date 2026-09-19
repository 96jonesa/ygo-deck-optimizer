import {
  ATTRIBUTE_VOCABULARY,
  attributeName,
  KIND_VOCABULARY,
  KINDS,
  type Kind,
  kindEntry,
  MONSTER_FLAG_VOCABULARY,
  type MonsterFlag,
  monsterFlagEntry,
  RACE_VOCABULARY,
  raceName,
  ST_SUBKIND_VOCABULARY,
  type StSubkind,
  stSubkindEntry,
} from '../cards/vocabulary';
import { normalize } from '../util/normalize';
import {
  type Alternative,
  type Clause,
  canonicalize,
  type Description,
  LEVEL_MAX,
  LEVEL_MIN,
  SETCODE_MAX,
  type Stat,
  type ValueSet,
} from './ast';
import type { DescContext } from './context';
import { lex, type Span, type Token } from './lexer';
import { formatArchetype, formatSetcode } from './print';

export type { DescContext, Span };

export type ParseResult =
  | { ok: true; desc: Description }
  | { ok: false; message: string; span: Span };

/** Parentheses only group, so real input nests once or twice; the cap keeps the stack bounded. */
const MAX_DEPTH = 32;

const EXAMPLES =
  'such as `level 4 monster`, `FIRE/WATER Warrior`, `quick-play spell`, `"Archetype"`, [Card Name] or {group}';
const DELIMITER_HINT =
  'card names go in [brackets], archetype names in "quotes" and group names in {braces}';

/** Internal control flow only: `parse` catches it and never lets it escape. */
class Failure {
  constructor(
    readonly message: string,
    readonly span: Span,
  ) {}
}

type TokenOf<T extends Token['t']> = Extract<Token, { t: T }>;

interface Spanned<T> {
  value: T;
  span: Span;
}

/** What one clause has said so far; `span`s are kept to point at a repeat or a conflict. */
interface ClauseState {
  kindWord?: Spanned<Kind[]>;
  flags: Map<MonsterFlag, Spanned<boolean>>;
  /** Positive `normal` / `ritual`, waiting for the rest of the clause to say what they mean. */
  contextual: TokenOf<'contextual'>[];
  negatedContextual: Spanned<MonsterFlag>[];
  stSubkinds?: Spanned<StSubkind[]>;
  attribute?: Spanned<ValueSet<number>>;
  race?: Spanned<ValueSet<number>>;
  level?: Spanned<number[]>;
  atk?: Spanned<Stat>;
  def?: Spanned<Stat>;
  archetypes: number[];
}

const DIMENSION = {
  attribute: { title: 'Attribute', a: 'an Attribute', nameOf: attributeName },
  race: { title: 'Type', a: 'a Type', nameOf: raceName },
} as const;

function subkindNames(kind: Kind): string {
  return ST_SUBKIND_VOCABULARY.filter((entry) => (entry.kinds as readonly Kind[]).includes(kind))
    .map((entry) => entry.subkind)
    .join(', ');
}

/** Words offered as "did you mean", in their canonical spelling. */
const SUGGESTIONS: readonly string[] = [
  ...KIND_VOCABULARY.map((entry) => entry.kind),
  'card',
  'level',
  'ATK',
  'DEF',
  ...new Set([
    ...MONSTER_FLAG_VOCABULARY.map((entry) => entry.flag as string),
    ...ST_SUBKIND_VOCABULARY.map((entry) => entry.subkind as string),
  ]),
  ...ATTRIBUTE_VOCABULARY.map((entry) => entry.name),
  ...RACE_VOCABULARY.map((entry) => entry.name),
];

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

/** Vocabulary within one edit of a short word, or two of a longer one; nearest first. */
function nearestWords(word: string): string[] {
  const key = normalize(word);
  const budget = key.length <= 4 ? 1 : 2;
  return SUGGESTIONS.map((candidate) => ({
    candidate,
    distance: editDistance(key, normalize(candidate).replaceAll(/[-\s]/g, '')),
  }))
    .filter(({ distance }) => distance <= budget)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    /** Where "something is missing" points once the tokens run out. */
    private readonly end: Span,
    private readonly ctx: DescContext,
  ) {}

  parseAll(): Description {
    const anyOf = this.description(0);
    const extra = this.peek();
    // `description` stops only at the end or at a `)`.
    if (extra !== undefined) throw new Failure('this `)` has no matching `(`', extra.span);
    return { anyOf };
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private peekPunct(ch: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.t === 'punct' && token.ch === ch;
  }

  /** Where "something is missing" points: the next token, or the end of the text. */
  private here(): Span {
    return this.peek()?.span ?? this.end;
  }

  private endsAlternative(token: Token | undefined): boolean {
    return token === undefined || token.t === 'or' || (token.t === 'punct' && token.ch === ')');
  }

  private description(depth: number): Alternative[] {
    const alternatives = this.alternative(depth);
    while (this.peek()?.t === 'or') {
      this.next();
      if (this.endsAlternative(this.peek()))
        throw new Failure(`expected a description after \`or\`, ${EXAMPLES}`, this.here());
      alternatives.push(...this.alternative(depth));
    }
    return alternatives;
  }

  private alternative(depth: number): Alternative[] {
    const token = this.peek();
    if (token === undefined || this.endsAlternative(token))
      throw new Failure(`expected a description, ${EXAMPLES}`, this.here());

    if (token.t === 'punct' && token.ch === '(') {
      if (depth >= MAX_DEPTH) throw new Failure('too many nested parentheses', token.span);
      this.next();
      const inner = this.description(depth + 1);
      if (!this.peekPunct(')')) throw new Failure('this `(` is never closed', token.span);
      this.next();
      if (!this.endsAlternative(this.peek()))
        throw new Failure(
          'parentheses group whole descriptions: expected `or` or the end after `)`',
          this.here(),
        );
      return inner;
    }

    if (token.t === 'cardName' || token.t === 'passcode' || token.t === 'group') {
      this.next();
      const alternative = this.reference(token);
      const after = this.peek();
      if (after !== undefined && !this.endsAlternative(after)) throw this.notCombinable(token);
      return [alternative];
    }
    return [{ t: 'clause', clause: this.clause() }];
  }

  private notCombinable(reference: Token): Failure {
    const what = reference.t === 'group' ? 'a group' : 'a card';
    return new Failure(
      `${what} reference is a whole alternative and cannot be combined with other words; write \`or\` between alternatives`,
      reference.span,
    );
  }

  private reference(token: TokenOf<'cardName' | 'passcode' | 'group'>): Alternative {
    switch (token.t) {
      case 'passcode':
        if (this.ctx.cards.get(token.value) === undefined)
          throw new Failure(`no card has the passcode #${token.value}`, token.span);
        return { t: 'card', passcode: token.value };
      case 'cardName':
        return { t: 'card', passcode: this.cardNamed(token) };
      case 'group': {
        if (token.text === '') throw new Failure('a group name cannot be empty', token.span);
        const groupId = this.ctx.groups.idOf(token.text);
        if (groupId !== undefined) return { t: 'group', groupId };
        const names = this.ctx.groups.names?.() ?? [];
        const known =
          names.length === 0 ? '' : `; groups: ${names.map((name) => `{${name}}`).join(', ')}`;
        throw new Failure(`no group is named "${token.text}"${known}`, token.span);
      }
    }
  }

  private cardNamed(token: TokenOf<'cardName'>): number {
    if (token.text === '') throw new Failure('a card name cannot be empty', token.span);
    const hits = this.ctx.cards.findByName(token.text);
    if (hits.length === 1) return hits[0]!.code;
    if (hits.length > 1) {
      const passcodes = hits.map((card) => `#${card.code}`).join(', ');
      throw new Failure(
        `"${token.text}" names ${hits.length} different cards; write the passcode instead: ${passcodes}`,
        token.span,
      );
    }
    const near = this.ctx.cards.search?.(token.text, 3) ?? [];
    const hint =
      near.length === 0 ? '' : `; did you mean ${near.map((card) => `[${card.name}]`).join(', ')}?`;
    throw new Failure(`no card is named "${token.text}"${hint}`, token.span);
  }

  private clause(): Clause {
    const state: ClauseState = {
      flags: new Map(),
      contextual: [],
      negatedContextual: [],
      archetypes: [],
    };
    // `alternative` has checked that there is at least one token to read.
    for (let token = this.peek(); !this.endsAlternative(token); token = this.peek())
      this.qualifier(token!, state);
    return this.resolve(state);
  }

  private qualifier(token: Token, state: ClauseState): void {
    switch (token.t) {
      case 'kind':
      case 'cardWord':
        this.kindWord(state);
        break;
      case 'non':
        this.negated(state);
        break;
      case 'flag':
        this.next();
        this.setFlag(state, token.flag, true, token.span);
        break;
      case 'contextual':
      case 'subkind':
        this.subkindList(state);
        break;
      case 'attribute':
      case 'race':
        this.valueList(state, false, token.span.start);
        break;
      case 'level':
        this.levelSpec(state);
        break;
      case 'stat':
        this.statAfterKeyword(state);
        break;
      case 'int':
        this.statBeforeKeyword(state);
        break;
      case 'quoted':
        this.archetype(state);
        break;
      case 'cardName':
      case 'passcode':
      case 'group':
        throw this.notCombinable(token);
      case 'bound':
        throw new Failure(
          'this must follow a number, as in `level 4 or lower` or `ATK 1500 or less`',
          token.span,
        );
      case 'hex':
        throw new Failure(
          'a hex code belongs after an archetype name, as in "Warrior":0x2066',
          token.span,
        );
      case 'word': {
        const near = nearestWords(token.text);
        const hint = near.length === 0 ? '' : `did you mean ${near.join(', ')}? Otherwise, `;
        throw new Failure(`unknown word "${token.text}"; ${hint}${DELIMITER_HINT}`, token.span);
      }
      case 'punct':
        if (token.ch === '(')
          throw new Failure(
            'parentheses group whole descriptions; write `or` before `(`',
            token.span,
          );
        if (token.ch === '?')
          throw new Failure('`?` is a value of ATK or DEF: write `ATK ?`', token.span);
        throw new Failure(
          `unexpected \`${token.ch}\`; expected a qualifier, a kind word (monster, spell, trap, card) or \`or\``,
          token.span,
        );
      case 'or':
        // `or` ends a clause, so `clause` never hands one over.
        break;
    }
  }

  private kindWord(state: ClauseState): void {
    const first = this.next() as TokenOf<'kind' | 'cardWord'>;
    const kinds: Kind[] = [];
    let end = first.span.end;
    if (first.t === 'kind') {
      kinds.push(first.kind);
      while (this.peekPunct('/')) {
        this.next();
        const kind = this.peek();
        if (kind?.t !== 'kind')
          throw new Failure('expected monster, spell or trap after `/`', this.here());
        this.next();
        kinds.push(kind.kind);
        end = kind.span.end;
      }
      // `spell card`, `spell/trap cards`.
      if (this.peek()?.t === 'cardWord') end = this.next().span.end;
    }
    const span = { start: first.span.start, end };
    if (state.kindWord !== undefined)
      throw new Failure(
        'the kind is given twice in this clause; write `spell/trap` for either',
        span,
      );
    state.kindWord = { value: kinds, span };
  }

  private setFlag(state: ClauseState, flag: MonsterFlag, want: boolean, span: Span): void {
    const earlier = state.flags.get(flag);
    if (earlier !== undefined && earlier.value !== want)
      throw new Failure(`\`${flag}\` and \`non-${flag}\` contradict each other`, span);
    state.flags.set(flag, { value: want, span });
  }

  private negated(state: ClauseState): void {
    const non = this.next();
    const token = this.peek();
    switch (token?.t) {
      case 'flag':
        this.next();
        this.setFlag(state, token.flag, false, { start: non.span.start, end: token.span.end });
        break;
      case 'contextual': {
        this.next();
        const span = { start: non.span.start, end: token.span.end };
        if (this.peekPunct('/'))
          throw new Failure('`non-` negates one monster flag at a time, not a `/` list', span);
        state.negatedContextual.push({ value: token.flag, span });
        break;
      }
      case 'subkind':
        throw new Failure(
          `\`non-\` cannot negate a Spell/Trap sub-kind; list the sub-kinds you do want, as in \`${subkindNames('trap').replaceAll(', ', '/')} trap\``,
          { start: non.span.start, end: token.span.end },
        );
      case 'attribute':
      case 'race':
        this.valueList(state, true, non.span.start);
        break;
      default:
        throw new Failure(
          '`non-` must be followed by a monster flag, an Attribute or a Type, as in `non-tuner`, `non-FIRE` or `non-Warrior/Dragon`',
          token?.span ?? non.span,
        );
    }
  }

  private valueList(state: ClauseState, negated: boolean, start: number): void {
    const first = this.next() as TokenOf<'attribute' | 'race'>;
    const dimension = DIMENSION[first.t];
    const bits = [first.bit];
    let end = first.span.end;
    while (this.peekPunct('/')) {
      this.next();
      const value = this.peek();
      if (value?.t === 'non')
        throw new Failure('`non-` covers the whole list: write `non-FIRE/WATER`', value.span);
      if ((value?.t === 'attribute' || value?.t === 'race') && value.t !== first.t)
        throw new Failure(
          `a \`/\` list stays within one dimension: ${dimension.nameOf(first.bit)} is ${dimension.a} and ${DIMENSION[value.t].nameOf(value.bit)} is ${DIMENSION[value.t].a}; write them side by side`,
          value.span,
        );
      if (value?.t !== first.t)
        throw new Failure(`expected ${dimension.a} after \`/\``, this.here());
      this.next();
      bits.push(value.bit);
      end = value.span.end;
    }

    const span = { start, end };
    const earlier = state[first.t];
    if (earlier === undefined) {
      state[first.t] = { value: negated ? { notIn: bits } : { in: bits }, span };
    } else if (negated && 'notIn' in earlier.value) {
      // `non-LIGHT non-DARK` excludes both.
      earlier.value.notIn.push(...bits);
    } else if (!negated && 'in' in earlier.value) {
      const either = [...earlier.value.in, ...bits].map(dimension.nameOf).join('/');
      throw new Failure(
        `${dimension.title} is given twice in this clause; write \`${either}\` for any of them`,
        span,
      );
    } else {
      throw new Failure(
        `this clause both requires and excludes ${dimension.title}s; keep one of the two`,
        span,
      );
    }
  }

  private subkindList(state: ClauseState): void {
    const first = this.next() as TokenOf<'contextual' | 'subkind'>;
    const items = [first];
    while (this.peekPunct('/')) {
      this.next();
      const item = this.peek();
      if (item?.t !== 'contextual' && item?.t !== 'subkind')
        throw new Failure(
          `expected a Spell/Trap sub-kind after \`/\`: ${ST_SUBKIND_VOCABULARY.map((entry) => entry.subkind).join(', ')}`,
          this.here(),
        );
      this.next();
      items.push(item);
    }
    // Alone, `normal` and `ritual` may still be monster flags; in a list they cannot.
    if (items.length === 1 && first.t === 'contextual') state.contextual.push(first);
    else
      this.addSubkinds(
        state,
        items.map((item) => item.subkind),
        { start: first.span.start, end: items.at(-1)!.span.end },
      );
  }

  private addSubkinds(state: ClauseState, subkinds: StSubkind[], span: Span): void {
    if (state.stSubkinds !== undefined) {
      const either = [...state.stSubkinds.value, ...subkinds].join('/');
      throw new Failure(
        `the sub-kind is given twice in this clause; write \`${either}\` for any of them`,
        span,
      );
    }
    state.stSubkinds = { value: subkinds, span };
  }

  private expectInt(message: string): TokenOf<'int'> {
    const token = this.peek();
    if (token?.t !== 'int') throw new Failure(message, this.here());
    this.next();
    return token;
  }

  private levelSpec(state: ClauseState): void {
    const keyword = this.next();
    const level = (what: string): number => {
      const token = this.expectInt(`expected ${what}, as in \`level 4\``);
      if (token.value < LEVEL_MIN || token.value > LEVEL_MAX)
        throw new Failure(`levels run from ${LEVEL_MIN} to ${LEVEL_MAX}`, token.span);
      return token.value;
    };
    const range = (low: number, high: number) =>
      Array.from({ length: high - low + 1 }, (_, i) => low + i);

    const first = level('a level after `level`');
    let values = [first];
    const after = this.peek();
    if (after?.t === 'bound') {
      this.next();
      values = after.dir === 'down' ? range(LEVEL_MIN, first) : range(first, LEVEL_MAX);
    } else if (this.peekPunct('-')) {
      this.next();
      const last = level('the upper level after `-`');
      if (last < first)
        throw new Failure(`a level range runs low to high: write \`level ${last}-${first}\``, {
          start: keyword.span.start,
          end: this.tokens[this.pos - 1]!.span.end,
        });
      values = range(first, last);
    } else {
      while (this.peekPunct('/')) {
        this.next();
        values.push(level('a level after `/`'));
      }
    }

    const span = { start: keyword.span.start, end: this.tokens[this.pos - 1]!.span.end };
    if (state.level !== undefined)
      throw new Failure(
        'the level is given twice in this clause; write `level 3/4` for either',
        span,
      );
    state.level = { value: values, span };
  }

  /** `INT`, `INT or less`, `INT or more`, `INT-INT`. */
  private statRange(): Stat {
    const first = this.next() as TokenOf<'int'>;
    const after = this.peek();
    if (after?.t === 'bound') {
      this.next();
      return after.dir === 'down' ? { min: 0, max: first.value } : { min: first.value, max: null };
    }
    if (!this.peekPunct('-')) return { min: first.value, max: first.value };
    this.next();
    const last = this.expectInt('expected the upper value after `-`, as in `ATK 1000-2000`');
    if (last.value < first.value)
      throw new Failure(`a range runs low to high: write \`${last.value}-${first.value}\``, {
        start: first.span.start,
        end: last.span.end,
      });
    return { min: first.value, max: last.value };
  }

  private setStat(state: ClauseState, stat: 'atk' | 'def', value: Stat, span: Span): void {
    if (state[stat] !== undefined)
      throw new Failure(`${stat.toUpperCase()} is given twice in this clause`, span);
    state[stat] = { value, span };
  }

  private statAfterKeyword(state: ClauseState): void {
    const keyword = this.next() as TokenOf<'stat'>;
    const name = keyword.stat.toUpperCase();
    let value: Stat;
    if (this.peekPunct('?')) {
      this.next();
      value = '?';
    } else if (this.peek()?.t === 'int') {
      value = this.statRange();
    } else {
      throw new Failure(
        `expected a number or \`?\` after ${name}, as in \`${name} 1500\`, \`${name} 1500 or less\` or \`${name} ?\``,
        this.here(),
      );
    }
    const end = this.tokens[this.pos - 1]!.span.end;
    this.setStat(state, keyword.stat, value, { start: keyword.span.start, end });
  }

  private statBeforeKeyword(state: ClauseState): void {
    const first = this.peek()!;
    const value = this.statRange();
    const keyword = this.peek();
    if (keyword?.t !== 'stat')
      throw new Failure(
        'a number needs its keyword: write `level 4`, `ATK 1500` or `1500 ATK`',
        first.span,
      );
    this.next();
    this.setStat(state, keyword.stat, value, { start: first.span.start, end: keyword.span.end });
  }

  private archetype(state: ClauseState): void {
    const quoted = this.next() as TokenOf<'quoted'>;
    let suffix: TokenOf<'hex'> | undefined;
    if (this.peekPunct(':')) {
      this.next();
      const hex = this.peek();
      if (hex?.t !== 'hex')
        throw new Failure('expected a hex setcode after `:`, as in "Warrior":0x2066', this.here());
      this.next();
      suffix = hex;
    }
    const span = { start: quoted.span.start, end: (suffix ?? quoted).span.end };
    state.archetypes.push(this.setcode(quoted.text, suffix, span));
  }

  private setcode(name: string, suffix: TokenOf<'hex'> | undefined, span: Span): number {
    if (name === '') throw new Failure('an archetype name cannot be empty', span);
    const table = this.ctx.setnames;
    /** `"Warrior":0x66`, spelled as the table spells the alternate that matched. */
    const candidate = (code: number) => {
      const spelled = table?.alternatesOf(code).find((alt) => normalize(alt) === normalize(name));
      return formatArchetype(spelled ?? name, code);
    };

    if (suffix === undefined) {
      if (table === null)
        throw new Failure(
          'archetype names are unavailable (no strings.conf found); write "Name":0xCODE',
          span,
        );
      const codes = table.lookup(name);
      if (codes.length === 1) return codes[0]!;
      if (codes.length === 0) throw new Failure(`no archetype is named "${name}"`, span);
      throw new Failure(
        `"${name}" names ${codes.length} archetypes; pick one: ${codes.map(candidate).join(', ')}`,
        span,
      );
    }

    const code = suffix.value;
    if (code < 1 || code > SETCODE_MAX)
      throw new Failure(`a setcode is between 0x1 and ${formatSetcode(SETCODE_MAX)}`, suffix.span);
    // `"?"` is how `print` writes a code it has no name for; with no table the code stands alone.
    if (name === '?' || table === null) return code;
    const codes = table.lookup(name);
    if (codes.includes(code)) return code;
    if (codes.length > 0)
      throw new Failure(
        `"${name}" is ${codes.map(candidate).join(' or ')}, not ${formatSetcode(code)}`,
        span,
      );
    const actual = table.nameOf(code);
    throw new Failure(
      actual === undefined
        ? `no archetype is named "${name}"`
        : `${formatSetcode(code)} is ${formatArchetype(actual, code)}, not "${name}"`,
      span,
    );
  }

  /** Decide what `normal` and `ritual` meant, imply kinds from sub-kinds, and build the clause. */
  private resolve(state: ClauseState): Clause {
    const kinds = state.kindWord?.value ?? [];
    const hasMonster = kinds.includes('monster');
    const hasSpellTrap = kinds.some((kind) => kind !== 'monster');
    // Only a POSITIVE monster-only constraint says "monster": a Spell is a non-tuner too.
    const monsterOnly =
      state.level !== undefined ||
      state.atk !== undefined ||
      state.def !== undefined ||
      (state.attribute !== undefined && 'in' in state.attribute.value) ||
      (state.race !== undefined && 'in' in state.race.value) ||
      [...state.flags.values()].some((flag) => flag.value);

    for (const word of state.contextual) {
      const name = word.flag;
      if (hasMonster && hasSpellTrap)
        throw new Failure(
          `\`${name}\` means one thing for a monster and another for a Spell or Trap; write them as separate alternatives, as in \`${name} monster or ${name} spell\``,
          word.span,
        );
      if (hasSpellTrap) this.addSubkinds(state, [word.subkind], word.span);
      else if (hasMonster || monsterOnly) this.setFlag(state, word.flag, true, word.span);
      else throw new Failure(`${name} what? write ${this.contextualChoices(word)}`, word.span);
    }
    for (const { value: flag, span } of state.negatedContextual) {
      if (hasSpellTrap && !hasMonster)
        throw new Failure(
          `\`non-${flag}\` excludes ${monsterFlagEntry(flag).name} MONSTERS, so every Spell and Trap already satisfies it; to exclude a sub-kind, list the ones you do want, as in \`quick-play/continuous spell\``,
          span,
        );
      this.setFlag(state, flag, false, span);
    }

    const clause: Clause = {};
    if (kinds.length > 0) clause.kinds = kinds;
    if (state.stSubkinds !== undefined) {
      const { value: subkinds, span } = state.stSubkinds;
      if (hasMonster)
        throw new Failure(
          `\`${subkinds.join('/')}\` is a Spell/Trap sub-kind and cannot describe a monster`,
          span,
        );
      const existsFor = (subkind: StSubkind): readonly Kind[] => stSubkindEntry(subkind).kinds;
      if (kinds.length === 0) {
        // `quick-play` implies Spell, `counter` implies Trap, `continuous` means either.
        clause.kinds = KINDS.filter((kind) => subkinds.some((s) => existsFor(s).includes(kind)));
      } else {
        const missing = subkinds.find((s) => !existsFor(s).some((kind) => kinds.includes(kind)));
        if (missing !== undefined)
          throw new Failure(
            `there is no ${stSubkindEntry(missing).name} ${kinds.map((kind) => kindEntry(kind).name).join(' or ')}; ${kinds.map((kind) => `${kind} sub-kinds are ${subkindNames(kind)}`).join('; ')}`,
            span,
          );
      }
      clause.stSubkinds = subkinds;
    }
    if (state.flags.size > 0)
      clause.flags = Object.fromEntries([...state.flags].map(([flag, { value }]) => [flag, value]));
    if (state.attribute) clause.attributes = state.attribute.value;
    if (state.race) clause.races = state.race.value;
    if (state.level) clause.level = state.level.value;
    if (state.atk) clause.atk = state.atk.value;
    if (state.def) clause.def = state.def.value;
    if (state.archetypes.length > 0) clause.archetypes = state.archetypes;
    return clause;
  }

  private contextualChoices(word: TokenOf<'contextual'>): string {
    const kinds = ['monster', ...stSubkindEntry(word.subkind).kinds];
    const phrases = kinds.map((kind) => `\`${word.flag} ${kind}\``);
    return `${phrases.slice(0, -1).join(', ')} or ${phrases.at(-1)}`;
  }
}

/**
 * Parse description text into a canonical AST (TDD §5). Never throws: every
 * problem comes back as a message for the user — what was expected, and the
 * candidates where there are any — with the span of `text` it is about.
 *
 * The AST records what was written. No game rule is applied (`level 4` does
 * not become a monster; that is normalization's job, TDD §6.1) beyond what it
 * takes to read the contextual words: `normal` and `ritual` become a monster
 * flag or a Spell/Trap sub-kind, and a sub-kind written without a kind word
 * brings the kinds it exists for.
 */
export function parse(text: string, ctx: DescContext): ParseResult {
  const lexed = lex(text);
  if (!lexed.ok) return lexed;
  return parseTokens(lexed.tokens, { start: text.length, end: text.length }, ctx);
}

/**
 * `parse` for a description that is part of a longer text (a criterion, TDD
 * §7.1): `tokens` are the description's own, with spans into the whole text,
 * and `end` is what follows them there — the span an error about something
 * missing after the last token points at.
 */
export function parseTokens(tokens: readonly Token[], end: Span, ctx: DescContext): ParseResult {
  try {
    return { ok: true, desc: canonicalize(new Parser(tokens, end, ctx).parseAll()) };
  } catch (failure) {
    if (failure instanceof Failure)
      return { ok: false, message: failure.message, span: failure.span };
    throw failure;
  }
}
