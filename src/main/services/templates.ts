import type { DescContext } from '../../core/desc/context';
import { matcher } from '../../core/desc/evaluate';
import { parse } from '../../core/desc/parser';
import { echo, print } from '../../core/desc/print';
import { type Analysis, analyze, type CostModel, SAMPLE_SIZE } from '../../core/model/analyze';
import {
  compileProblem,
  groupLookupOf,
  groupMembersOf,
  resolveTemplate,
} from '../../core/model/compile';
import { type Template, type TemplateGroup, validateTemplate } from '../../core/model/template';
import type { BreakdownCriterion, Compiled } from '../../core/opt/optimizer';
import type {
  AnalyzeTemplateResult,
  CardStatus,
  DescParseResult,
  InvalidRequest,
  NotReady,
  TemplateErrors,
} from '../../shared/types';
import type { ReadyCards } from './cards';

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
    const compiled = compileProblem(resolved.resolved);
    if (!compiled.ok) return invalid('the template does not compile', compiled.errors);
    const criteria = resolved.resolved.criteria.map(
      ({ id, name, alternatives }): BreakdownCriterion =>
        name === undefined ? { id, alternatives } : { id, name, alternatives },
    );
    return { ok: true, analysis, compiled, criteria };
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
