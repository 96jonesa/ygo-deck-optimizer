import type { SqlJsStatic } from 'sql.js';
import { CardIndex } from '../../src/core/cards/index';
import type { CardLoader, CardLoadOptions, LoadedCards } from '../../src/main/services/cards';
import { SETNAMES } from './desc-context';
import { buildCdb, FIXTURE_ROWS, type FixtureRow } from './fixture-cards';

/** What a loader would hand back for an install holding `rows`. */
export function loadedCards(
  SQL: SqlJsStatic,
  rows: readonly FixtureRow[] = FIXTURE_ROWS,
  setnames: LoadedCards['setnames'] = SETNAMES,
): LoadedCards {
  return { cards: CardIndex.fromDatabases(SQL, [{ bytes: buildCdb(SQL, rows) }]), setnames };
}

interface PendingLoad {
  workdir: string;
  opts: CardLoadOptions;
  resolve(loaded: LoadedCards): void;
  reject(failure: unknown): void;
}

/**
 * A `CardLoader` whose loads finish when the test says so, in the order the
 * test says so — which is what it takes to stage a race.
 */
export class ControllableLoader {
  readonly calls: PendingLoad[] = [];

  readonly load: CardLoader = (workdir, opts) =>
    new Promise<LoadedCards>((resolve, reject) => {
      this.calls.push({ workdir, opts, resolve, reject });
    });

  /** The `n`th load started, from zero. */
  call(n: number): PendingLoad {
    const call = this.calls[n];
    if (call === undefined) throw new Error(`load ${n} was never started`);
    return call;
  }
}

/** A `CardLoader` that answers at once with whatever `answer` says of the workdir. */
export function immediateLoader(answer: (workdir: string) => LoadedCards): CardLoader {
  return async (workdir) => answer(workdir);
}
