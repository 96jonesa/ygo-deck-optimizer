import type { DescContext } from '../../core/desc/context';
import { matcher } from '../../core/desc/evaluate';
import { parse } from '../../core/desc/parser';
import { echo, print } from '../../core/desc/print';
import { analyze, SAMPLE_SIZE } from '../../core/model/analyze';
import { groupLookupOf, groupMembersOf } from '../../core/model/compile';
import { type TemplateGroup, validateTemplate } from '../../core/model/template';
import type {
  AnalyzeTemplateResult,
  CardStatus,
  DescParseResult,
  InvalidRequest,
  NotReady,
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

export class TemplateService {
  constructor(private readonly source: CardSource) {}

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

    if (ready.memo.size > MEMO_LIMIT) ready.memo.clear();
    // TODO(M2b): pass the cost the worker calibrates at startup, for `work.estimatedMs`.
    const analysis = analyze(validated.template, {
      cards: ready.cards,
      setnames: ready.setnames,
      memo: ready.memo,
    });
    return { ok: true, analysis };
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
