import type { SqlJsStatic } from 'sql.js';
import { analyze } from '../../src/core/model/analyze';
import { compileProblem, handSizesForMode, resolveTemplate } from '../../src/core/model/compile';
import {
  type CriterionWhen,
  countsFor,
  handSizeForMode,
  partsOfMode,
  type RunMode,
  type Template,
} from '../../src/core/model/template';
import { lineLabels, runDroppedLimits, runLimits } from '../../src/main/services/templates';
import type { RunResult } from '../../src/shared/types';
import type { RunRequest, WorkerRunOptions } from '../../src/worker/protocol';
import { realResult } from './fake-worker';
import { motivatingContext, motivatingTemplate } from './motivating';
import { cancelFlag } from './wide-compiled';

/**
 * The motivating example in a given MODE, its criteria tagged as `whens` says
 * — by criterion id, anything unnamed staying `both`. `modeOf` reads the mode
 * off the template, so it is set there and not carried beside it.
 */
export function motivatingIn(
  mode: RunMode,
  whens: Readonly<Record<string, CriterionWhen>> = {},
): Template {
  const template = motivatingTemplate();
  return {
    ...template,
    mode,
    hand: { size: handSizeForMode(mode) },
    criteria: template.criteria.map((criterion) => {
      const when = whens[criterion.id];
      return when === undefined ? criterion : { ...criterion, when };
    }),
  };
}

/** The motivating example, compiled against the fixture cards: what main would send the worker. */
export function motivatingRequest(
  SQL: SqlJsStatic,
  runId: number,
  options: WorkerRunOptions = {},
  template: Template = motivatingTemplate(),
): RunRequest {
  const resolved = resolveTemplate(template, motivatingContext(SQL));
  if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
  const mode = template.mode ?? (template.hand.size === 6 ? 'second' : 'first');
  const parts = partsOfMode(mode);
  const compiled = compileProblem(resolved.resolved, {
    handSizes: handSizesForMode(resolved.resolved, mode),
  });
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  const criteria = resolved.resolved.criteria.map(({ id, name, when, alternatives }) => ({
    id,
    ...(name === undefined ? {} : { name }),
    alternatives,
    parts: parts.map((part) => countsFor(when, part)),
  }));
  return { type: 'run', runId, compiled, criteria, options, cancelFlag: cancelFlag() };
}

/**
 * The motivating example's result as the renderer receives it: searched for
 * real, decorated the way `RunService` decorates one — the caps and the line
 * NAMES, which the worker cannot know — then cloned as IPC would clone it.
 */
export function motivatingResult(
  SQL: SqlJsStatic,
  template: Template = motivatingTemplate(),
): RunResult {
  const context = motivatingContext(SQL);
  const resolved = resolveTemplate(template, context);
  if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
  const labels = lineLabels(template, resolved.resolved);
  const analysis = analyze(template, context);
  const result = realResult(motivatingRequest(SQL, 1, {}, template));
  if (result.status !== 'done') throw new Error(`expected a whole result, got ${result.status}`);
  return structuredClone({
    ...result,
    limits: { topK: 200, plateauCap: 500 },
    criterionLimits: runLimits(analysis, labels),
    droppedLimits: runDroppedLimits(analysis),
    lines: result.lines.map((line) => ({ ...line, label: labels[line.id] ?? line.id })),
  });
}
