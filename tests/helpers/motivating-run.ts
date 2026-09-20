import type { SqlJsStatic } from 'sql.js';
import { analyze } from '../../src/core/model/analyze';
import { compileProblem, resolveTemplate } from '../../src/core/model/compile';
import { lineLabels, runDroppedLimits, runLimits } from '../../src/main/services/templates';
import type { RunResult } from '../../src/shared/types';
import type { RunRequest, WorkerRunOptions } from '../../src/worker/protocol';
import { realResult } from './fake-worker';
import { motivatingContext, motivatingTemplate } from './motivating';
import { cancelFlag } from './wide-compiled';

/** The motivating example, compiled against the fixture cards: what main would send the worker. */
export function motivatingRequest(
  SQL: SqlJsStatic,
  runId: number,
  options: WorkerRunOptions = {},
): RunRequest {
  const resolved = resolveTemplate(motivatingTemplate(), motivatingContext(SQL));
  if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
  const compiled = compileProblem(resolved.resolved);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  const criteria = resolved.resolved.criteria.map(({ id, name, alternatives }) => ({
    id,
    ...(name === undefined ? {} : { name }),
    alternatives,
  }));
  return { type: 'run', runId, compiled, criteria, options, cancelFlag: cancelFlag() };
}

/**
 * The motivating example's result as the renderer receives it: searched for
 * real, decorated the way `RunService` decorates one — the caps and the line
 * NAMES, which the worker cannot know — then cloned as IPC would clone it.
 */
export function motivatingResult(SQL: SqlJsStatic): RunResult {
  const template = motivatingTemplate();
  const context = motivatingContext(SQL);
  const resolved = resolveTemplate(template, context);
  if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
  const labels = lineLabels(template, resolved.resolved);
  const analysis = analyze(template, context);
  const result = realResult(motivatingRequest(SQL, 1));
  if (result.status !== 'done') throw new Error(`expected a whole result, got ${result.status}`);
  return structuredClone({
    ...result,
    limits: { topK: 200, plateauCap: 500 },
    criterionLimits: runLimits(analysis, labels),
    droppedLimits: runDroppedLimits(analysis),
    lines: result.lines.map((line) => ({ ...line, label: labels[line.id] ?? line.id })),
  });
}
