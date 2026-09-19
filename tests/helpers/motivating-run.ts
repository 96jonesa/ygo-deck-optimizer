import type { SqlJsStatic } from 'sql.js';
import { compileProblem, resolveTemplate } from '../../src/core/model/compile';
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

/** The motivating example's result as the renderer receives it: searched for real, then cloned as IPC would. */
export function motivatingResult(SQL: SqlJsStatic): RunResult {
  const result = realResult(motivatingRequest(SQL, 1));
  if (result.status !== 'done') throw new Error(`expected a whole result, got ${result.status}`);
  return structuredClone({ ...result, limits: { topK: 200, plateauCap: 500 } });
}
