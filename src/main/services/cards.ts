import type { CardIndex, SqlEngine } from '../../core/cards/index';
import type { CardRecord } from '../../core/cards/record';
import type { SetnameTable } from '../../core/cards/setnames';
import type { MatchSummary } from '../../core/model/analyze';
import type { CardHit, CardInfo, CardState, CardStatus } from '../../shared/types';
import { CARD_DATABASE_LOCATIONS, loadCardIndex, loadSetnames } from '../edopro/loader';
import { typeline } from './typeline';

// The card service (TDD §3): main's one holder of the card index. Node only —
// the loader and the status listener are injected, so nothing here imports
// Electron and the race below is tested with a loader the test controls.

/** What a load depends on besides the folder: change one and the index is stale. */
export interface CardLoadOptions {
  includePrerelease: boolean;
}

export interface LoadedCards {
  cards: CardIndex;
  /** `null` when the install has no `strings.conf` (TDD §4.5). */
  setnames: SetnameTable | null;
}

export type CardLoader = (workdir: string, opts: CardLoadOptions) => Promise<LoadedCards>;

/** The index while it is `ready`, with the match memo that is only valid for it. */
export interface ReadyCards extends LoadedCards {
  /** `analyze`'s caller-owned memo (TDD §9): kept while the index stays, fresh after every load. */
  memo: Map<string, MatchSummary>;
}

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;

/**
 * A `CardLoader` over a real install: the loader's filesystem walk and an
 * sql.js that is initialised on first use, then shared. A failed
 * initialisation is not remembered, so the next load tries again.
 */
export function installLoader(initSql: () => Promise<SqlEngine>): CardLoader {
  let engine: Promise<SqlEngine> | null = null;
  return async (workdir, opts) => {
    engine ??= initSql();
    let SQL: SqlEngine;
    try {
      SQL = await engine;
    } catch (failure) {
      engine = null;
      throw failure;
    }
    return { cards: loadCardIndex(workdir, SQL, opts), setnames: loadSetnames(workdir) };
  };
}

function hitOf(card: CardRecord): CardHit {
  return { passcode: card.code, name: card.name, typeline: typeline(card) };
}

interface Target extends CardLoadOptions {
  workdir: string | null;
}

/**
 * Owns the `CardIndex`, the setname table and the analysis match memo, behind
 * a small state machine: `idle` (no folder) → `loading` → `ready` | `error`.
 * Every change of state is handed to `onStatus` — the status is pushed, never
 * polled (TDD §3) — and the index can be had only while `ready`.
 *
 * Loads can overlap: sql.js initialises asynchronously, and a setting can
 * change while a load is under way. Each load is numbered, and a load that
 * is no longer the latest when it finishes is dropped whole — its cards, its
 * failure and its status — so a slow stale load never clobbers a newer one.
 */
export class CardService {
  private state: CardState = 'idle';
  private target: Target = { workdir: null, includePrerelease: true };
  private loaded: ReadyCards | null = null;
  private readonly memo = new Map<string, MatchSummary>();
  private error: string | undefined;
  /** The number of the latest load started; a load that finishes under another number is stale. */
  private generation = 0;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly load: CardLoader,
    private readonly onStatus: (status: CardStatus) => void,
  ) {}

  status(): CardStatus {
    const counts = this.loaded?.cards.status;
    const status: CardStatus = {
      state: this.state,
      workdir: this.target.workdir,
      databases: counts?.databases ?? 0,
      skippedDatabases: counts?.skippedDatabases ?? 0,
      cards: counts?.cards ?? 0,
      replacedRows: counts?.replacedRows ?? 0,
      conflicts: counts?.conflicts ?? 0,
      setnames: this.loaded?.setnames?.size ?? null,
    };
    if (this.error !== undefined) status.error = this.error;
    return status;
  }

  /** The index, its setnames and its memo — or `null` in any state but `ready`. */
  ready(): ReadyCards | null {
    return this.loaded;
  }

  /**
   * Make the index that of `workdir` under `opts`. Nothing happens when that
   * is what it already is — `ready`, same folder, same options — and a load
   * of the same thing already under way is joined rather than repeated; an
   * `error` is retried. `workdir: null` is "no install": `idle`. The promise
   * settles when this load has, applied or dropped, and never rejects: a
   * failure is a state.
   */
  reload(workdir: string | null, opts: CardLoadOptions, force = false): Promise<void> {
    const { includePrerelease } = opts;
    const unchanged =
      workdir === this.target.workdir && includePrerelease === this.target.includePrerelease;
    if (unchanged && !force) {
      if (this.state === 'ready' || this.state === 'idle') return Promise.resolve();
      if (this.state === 'loading') return this.inFlight;
    }

    const generation = ++this.generation;
    this.target = { workdir, includePrerelease };
    this.loaded = null;
    this.error = undefined;
    if (workdir === null) {
      this.enter('idle');
      return Promise.resolve();
    }
    this.enter('loading');
    this.inFlight = this.run(generation, workdir, { includePrerelease });
    return this.inFlight;
  }

  /** Read the same folder again, although nothing here changed: the files may have. */
  reindex(): Promise<void> {
    const { workdir, includePrerelease } = this.target;
    if (workdir === null) return Promise.resolve();
    return this.reload(workdir, { includePrerelease }, true);
  }

  /** Name search for the picker; empty while there is no index. */
  search(query: string, limit: number = SEARCH_LIMIT_DEFAULT): CardHit[] {
    const bounded = Number.isFinite(limit)
      ? Math.min(Math.trunc(limit), SEARCH_LIMIT_MAX)
      : SEARCH_LIMIT_DEFAULT;
    return (this.loaded?.cards.search(query, bounded) ?? []).map(hitOf);
  }

  /** The cards that exist, in the order asked for; an unknown passcode is left out. */
  get(passcodes: readonly number[]): CardInfo[] {
    const found: CardInfo[] = [];
    for (const passcode of passcodes) {
      const card = this.loaded?.cards.get(passcode);
      if (card === undefined) continue;
      found.push({
        ...hitOf(card),
        limitCode: card.limitCode,
        snapshot: {
          type: card.type,
          attribute: card.attribute,
          race: card.race,
          level: card.level,
          atk: card.atk,
          def: card.def,
          setcodes: [...card.setcodes],
        },
      });
    }
    return found;
  }

  private async run(generation: number, workdir: string, opts: CardLoadOptions): Promise<void> {
    let loaded: LoadedCards;
    try {
      loaded = await this.load(workdir, opts);
    } catch (failure) {
      if (generation !== this.generation) return;
      this.error = failure instanceof Error ? failure.message : String(failure);
      this.enter('error');
      return;
    }
    if (generation !== this.generation) return;
    if (loaded.cards.status.databases === 0) {
      this.error = `no card database under ${workdir}: expected ${CARD_DATABASE_LOCATIONS}`;
      this.enter('error');
      return;
    }
    // What the memo remembers is about the cards that were just replaced.
    this.memo.clear();
    this.loaded = { ...loaded, memo: this.memo };
    this.enter('ready');
  }

  private enter(state: CardState): void {
    this.state = state;
    this.onStatus(this.status());
  }
}
