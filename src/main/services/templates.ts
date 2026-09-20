import {
  archetypeInsert,
  type CompletionSite,
  cardInsert,
  completionSiteAt,
  groupInsert,
} from '../../core/desc/completion';
import type { DescContext } from '../../core/desc/context';
import { matcher } from '../../core/desc/evaluate';
import { parse } from '../../core/desc/parser';
import { echo, formatSetcode, print } from '../../core/desc/print';
import { type Analysis, analyze, type CostModel, SAMPLE_SIZE } from '../../core/model/analyze';
import {
  compileProblem,
  groupLookupOf,
  groupMembersOf,
  handSizesForMode,
  type ResolvedTemplate,
  resolveTemplate,
} from '../../core/model/compile';
import {
  countsFor,
  modeOf,
  partsOfMode,
  type Template,
  type TemplateGroup,
  validateTemplate,
} from '../../core/model/template';
import type { BreakdownCriterion, Compiled } from '../../core/opt/optimizer';
import { normalize } from '../../core/util/normalize';
import type {
  AnalyzeTemplateResult,
  CardStatus,
  CompleteNameResult,
  CompletionOption,
  DescParseResult,
  InvalidRequest,
  NotReady,
  RunDroppedLimit,
  RunLimit,
  TemplateErrors,
} from '../../shared/types';
import type { ReadyCards } from './cards';
import { typeline } from './typeline';

// Parse and analyze, in main and synchronous (TDD §3): microseconds to
// milliseconds, so no worker. Node-free and Electron-free; the card service
// is reached through the narrow interface below.

/** The slice of `CardService` this service uses. */
export interface CardSource {
  ready(): ReadyCards | null;
  status(): CardStatus;
}

/**
 * Entries the match memo may hold before it is emptied. An entry is a count
 * and five names; every distinct description ever typed adds one, so a bound
 * is what keeps a day-long session flat. An analysis refills what it needs.
 */
export const MEMO_LIMIT = 5000;

/** What the template editor calls the computed line, so the results call it the same thing. */
export const REMAINDER_LABEL = 'Unspecified cards';

/** Rows the completion popup offers at most: the card picker's own limit. */
export const COMPLETION_LIMIT = 20;

/**
 * The template's groups whose name `prefix` matches — prefix hits first, then
 * substring hits, each in template order. An EMPTY prefix matches every group,
 * unlike the card and archetype searches, which answer nothing: a template's
 * groups are a handful of names the user invented themselves, so `{` on its
 * own is how they are recalled, while 12,000 cards are not a list.
 *
 * A group whose name holds the closing brace is left out rather than offered:
 * the grammar cannot carry it, so no text would insert it.
 */
function groupOptions(
  groups: readonly TemplateGroup[],
  prefix: string,
  limit: number,
): CompletionOption[] {
  const needle = normalize(prefix);
  const prefixed: TemplateGroup[] = [];
  const inside: TemplateGroup[] = [];
  for (const group of groups) {
    const at = normalize(group.name).indexOf(needle);
    if (at === 0) prefixed.push(group);
    else if (at > 0) inside.push(group);
  }
  const seen = new Map<string, number>();
  for (const group of groups)
    seen.set(normalize(group.name), (seen.get(normalize(group.name)) ?? 0) + 1);
  const options: CompletionOption[] = [];
  for (const group of [...prefixed, ...inside]) {
    const insert = groupInsert(group.name);
    if (insert === null) continue;
    options.push({
      label: group.name,
      detail: `${group.cards.length} card${group.cards.length === 1 ? '' : 's'}`,
      insert,
      key: group.id,
      // `{name}` has no way to say WHICH of two same-named groups is meant.
      ambiguous: (seen.get(normalize(group.name)) ?? 0) > 1,
    });
  }
  return options.slice(0, limit);
}

/**
 * What each line is CALLED on screen, by line id: the answer to "how many
 * copies of X?" has to name X, and an internal id like `line3` does not
 * (PRD §5.6).
 *
 * A picker-chosen line is its card's name. A description line is **the text
 * the user typed**, not the canonical form — `resolveTemplate` rewrites a
 * `[Name]` as `#89631139`, which nobody would recognise — and not the echo,
 * which is the tool's reading rather than their words. The remainder is what
 * the editor calls it. A line with nothing to say keeps its id, so a label is
 * never blank.
 *
 * Read off the template that was COMPILED for the run, so a result keeps the
 * names it was produced with however the editor moves on afterwards.
 */
export function lineLabels(template: Template, resolved: ResolvedTemplate): Record<string, string> {
  const own = new Map<string, string>();
  for (const line of template.lines)
    own.set(line.id, ('card' in line ? line.card.name : line.text).trim());
  const labels: Record<string, string> = {};
  for (const line of resolved.lines) {
    const label = line.isRemainder ? REMAINDER_LABEL : (own.get(line.id) ?? '');
    labels[line.id] = label === '' ? line.id : label;
  }
  return labels;
}

/**
 * What the run's criteria limited, for PRD §6.3's footnote — the counts each
 * limit appears under, and the under-specified lines it cannot see, named the
 * way the results name every other line.
 *
 * Attached to the RESULT rather than looked up later: the footnote says what
 * a number does and does not account for, so it has to be the number's own,
 * however the template has moved on by the time anyone reads it.
 */
export function runLimits(analysis: Analysis, labels: Record<string, string>): RunLimit[] {
  return analysis.limits.map((limit) => ({
    text: limit.text,
    counts: [...new Set(limit.appearsIn.map((appearance) => appearance.n))].sort((a, b) => a - b),
    blind: limit.ignored.map(({ line, min, max }) => ({
      label: labels[line] ?? line,
      min,
      max,
    })),
    blindRange: limit.ignoredRange === null ? null : { ...limit.ignoredRange },
  }));
}

/** The limits the engine left out because they hold of every hand, pinned to the run the same way. */
export function runDroppedLimits(analysis: Analysis): RunDroppedLimit[] {
  return (analysis.classes?.droppedLimits ?? []).map(({ text, n, reason }) => ({
    text,
    n,
    reason,
  }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What is wrong with `value` as a template's `groups`; empty when nothing is. */
function groupErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return ['`groups` must be a list'];
  const errors: string[] = [];
  value.forEach((group, i) => {
    if (!isObject(group) || typeof group.id !== 'string' || typeof group.name !== 'string')
      errors.push(`groups[${i}] must be { id, name, cards }`);
    else if (
      !Array.isArray(group.cards) ||
      !group.cards.every((card) => isObject(card) && Number.isInteger(card.passcode))
    )
      errors.push(`groups[${i}]: \`cards\` must be a list of { passcode, name }`);
  });
  return errors;
}

function invalid(message: string, errors: string[]): InvalidRequest {
  return { ok: false, reason: 'invalid', message, errors };
}

/**
 * A template as a run needs it (TDD §3): compiled to plain numbers — no card
 * data, so it can be posted to the worker as it is, and a card reload after
 * this point cannot change what is searched.
 */
export type CompileTemplateResult =
  | {
      ok: true;
      analysis: Analysis;
      compiled: Compiled;
      /** The template's criteria, for the per-criterion breakdown. */
      criteria: BreakdownCriterion[];
      /** What each line is called on screen, by line id: `lineLabels`. */
      labels: Record<string, string>;
      /** What the criteria limited, for the honesty footnote: `runLimits`. */
      criterionLimits: RunLimit[];
      /** Limits left out for holding of every hand: `runDroppedLimits`. */
      droppedLimits: RunDroppedLimit[];
    }
  | NotReady
  | InvalidRequest
  | TemplateErrors;

export class TemplateService {
  /**
   * `cost` is asked on every analysis: what a score costs on this machine,
   * once the optimizer worker has calibrated (TDD §11.3). Until it has —
   * `undefined` — `analyze` estimates at its benchmarked default.
   */
  constructor(
    private readonly source: CardSource,
    private readonly cost: () => CostModel | undefined = () => undefined,
  ) {}

  /**
   * One description, as the editor shows it beside the input (PRD §5.2): the
   * AST, its canonical text, the echo, and what the database says of it.
   * `text` and `groups` come from the renderer, so they are checked, and
   * nothing here throws: every outcome is a value.
   */
  parseDescription(text: unknown, groups: unknown): DescParseResult {
    const ready = this.source.ready();
    if (ready === null) return this.notReady();
    if (typeof text !== 'string') return invalid('a description is text', ['`text` must be text']);
    const errors = groupErrors(groups);
    if (errors.length > 0) return invalid('the groups are not well-formed', errors);
    const templateGroups = groups as TemplateGroup[];

    const ctx: DescContext = {
      cards: ready.cards,
      setnames: ready.setnames,
      groups: groupLookupOf(templateGroups),
    };
    const parsed = parse(text, ctx);
    if (!parsed.ok)
      return { ok: false, reason: 'parse', message: parsed.message, span: parsed.span };

    // One pass over the database for both the count and the samples.
    const matches = matcher(parsed.desc, groupMembersOf(templateGroups));
    const samples: string[] = [];
    const count = ready.cards.count((card) => {
      if (!matches(card)) return false;
      if (samples.length < SAMPLE_SIZE) samples.push(card.name);
      return true;
    });
    return {
      ok: true,
      desc: parsed.desc,
      canonical: print(parsed.desc, ctx),
      echo: echo(parsed.desc, ctx),
      count,
      samples,
    };
  }

  /**
   * The names that could go where the caret is (PRD §5.2). Three things are
   * decided here rather than in the renderer (TDD §3): whether the caret is
   * inside a name at all — `completionSiteAt` reads that off the lexer —
   * which names match what has been typed, and how each is written back.
   *
   * That last one is the rule the whole feature rests on: **every option
   * inserts text that resolves to the row that was picked.** A card name two
   * records share goes in as its passcode, an archetype name that names two
   * setcodes carries its code, and a group name the grammar cannot carry is
   * not offered at all. Nothing here can be picked into a parse error.
   */
  completeName(text: unknown, caret: unknown, groups: unknown): CompleteNameResult {
    const ready = this.source.ready();
    if (ready === null) return this.notReady();
    if (typeof text !== 'string') return invalid('a description is text', ['`text` must be text']);
    if (!Number.isInteger(caret))
      return invalid('the caret is an offset into the text', ['`caret` must be a whole number']);
    const errors = groupErrors(groups);
    if (errors.length > 0) return invalid('the groups are not well-formed', errors);

    const site = completionSiteAt(text, caret as number);
    if (site === null) return { ok: true, site: null, options: [] };
    return { ok: true, site, options: this.optionsFor(site, ready, groups as TemplateGroup[]) };
  }

  /**
   * The Analysis of a template (TDD §9), over the card service's index and
   * its match memo. The template comes from the renderer as JSON, so it is
   * validated structurally first; one that is not a template at all comes
   * back as `invalid`. `analyze` itself never throws.
   */
  analyzeTemplate(template: unknown): AnalyzeTemplateResult {
    const ready = this.source.ready();
    if (ready === null) return this.notReady();
    const validated = validateTemplate(template);
    if (!validated.ok) return invalid('this is not a well-formed template', validated.errors);

    return { ok: true, analysis: this.analysisOf(validated.template, ready) };
  }

  /**
   * What `run:start` hands the worker: the template validated, analyzed,
   * resolved and compiled, here in main where the card index is (TDD §3). A
   * template the analysis finds an error in is not compiled; the analysis
   * comes back instead, since it says where. Never throws.
   */
  compileTemplate(template: unknown): CompileTemplateResult {
    const ready = this.source.ready();
    if (ready === null) return this.notReady();
    const validated = validateTemplate(template);
    if (!validated.ok) return invalid('this is not a well-formed template', validated.errors);

    const analysis = this.analysisOf(validated.template, ready);
    if (!analysis.ok) return { ok: false, reason: 'template-errors', analysis };
    // Neither fails for a template the analysis passed; if one does, it is said, not thrown.
    const resolved = resolveTemplate(validated.template, ready);
    if (!resolved.ok) return invalid('the template does not resolve', resolved.errors);
    // The mode is the whole of what the three runs differ by (PRD §5.5):
    // which hands are scored, and which criteria each of them is judged
    // against. The classes are the union's either way.
    const mode = modeOf(validated.template);
    const handSizes = handSizesForMode(resolved.resolved, mode);
    const compiled = compileProblem(resolved.resolved, { handSizes });
    if (!compiled.ok) return invalid('the template does not compile', compiled.errors);
    const parts = partsOfMode(mode);
    // Only the criteria this run judges. One for the other hand is not scored
    // at 0 and shown — it is not part of this run at all, and a row of zeroes
    // beside the ones that were judged would read as a result rather than an
    // absence. It is the criteria editor that still shows it, dimmed.
    const criteria = resolved.resolved.criteria.flatMap(
      ({ id, name, when, weight, alternatives }) => {
        const mine = parts.map((part) => countsFor(when, part));
        if (!mine.some(Boolean)) return [];
        const out: BreakdownCriterion = { id, alternatives, parts: mine, weight };
        if (name !== undefined) out.name = name;
        return [out];
      },
    );
    const labels = lineLabels(validated.template, resolved.resolved);
    return {
      ok: true,
      analysis,
      compiled,
      criteria,
      labels,
      criterionLimits: runLimits(analysis, labels),
      droppedLimits: runDroppedLimits(analysis),
    };
  }

  /** The rows for one site. The typed text is trimmed here; the SITE keeps it as typed. */
  private optionsFor(
    site: CompletionSite,
    ready: ReadyCards,
    groups: readonly TemplateGroup[],
  ): CompletionOption[] {
    const prefix = site.prefix.trim();
    switch (site.kind) {
      case 'card':
        return ready.cards.search(prefix, COMPLETION_LIMIT).map((card) => {
          const unique = ready.cards.findByName(card.name).length === 1;
          return {
            label: card.name,
            detail: typeline(card),
            insert: cardInsert(card.name, card.code, unique),
            key: `#${card.code}`,
            ambiguous: !unique,
          };
        });
      case 'archetype':
        // No `strings.conf`, no names: archetypes are then written by code only (TDD §4.5).
        return (ready.setnames?.search(prefix, COMPLETION_LIMIT) ?? []).map(
          ({ code, name, ambiguous }) => ({
            label: name,
            detail: formatSetcode(code),
            insert: archetypeInsert(name, code, !ambiguous),
            key: `${formatSetcode(code)}:${name}`,
            ambiguous,
          }),
        );
      case 'group':
        return groupOptions(groups, prefix, COMPLETION_LIMIT);
    }
  }

  private analysisOf(template: Template, ready: ReadyCards): Analysis {
    if (ready.memo.size > MEMO_LIMIT) ready.memo.clear();
    const cost = this.cost();
    return analyze(
      template,
      { cards: ready.cards, setnames: ready.setnames, memo: ready.memo },
      cost === undefined ? {} : { cost },
    );
  }

  private notReady(): NotReady {
    const { state, error } = this.source.status();
    const message =
      state === 'loading'
        ? 'the card data is still loading'
        : state === 'error'
          ? `the card data failed to load: ${error ?? 'unknown error'}`
          : 'no EDOPro folder is set, so there is no card data yet';
    return { ok: false, reason: 'not-ready', state, message };
  }
}
