import { normalize } from '../util/normalize';
import { type CardRecord, isMainDeckEligible, isOfficialScope } from './record';

/**
 * The slice of sql.js that `CardIndex` uses. `src/core` never imports or
 * initialises sql.js (TDD §16); the caller injects the instance, and sql.js's
 * own `SqlJsStatic` satisfies this structurally.
 */
export interface SqlDatabase {
  exec(sql: string): { values: unknown[][] }[];
  close(): void;
}

export interface SqlEngine {
  Database: new (data: Uint8Array) => SqlDatabase;
}

/** One `.cdb` file's contents, in load order. */
export interface CardDatabaseSource {
  bytes: Uint8Array;
  /**
   * Name of the EDOPro repository (`repositories/<name>/`) the file came from;
   * undefined for `cards.cdb` and `expansions/`.
   */
  repository?: string;
}

export interface CardIndexOptions {
  /** Include `SCOPE_PRERELEASE` cards (TDD §4.2). Default `true`. */
  includePrerelease?: boolean;
}

export interface CardIndexStatus {
  /** Databases that opened and answered the row query. */
  databases: number;
  /** Databases that failed to open or query, and were skipped. */
  skippedDatabases: number;
  /** Records in the index, after alias collapse and the population filter. */
  cards: number;
  /**
   * Ids whose row was replaced by a later database with different decoded
   * fields. Informational: a delta repository updating base rows is how an
   * install is meant to work, so hundreds of these are expected and healthy.
   */
  replacedRows: number;
  /**
   * Ids on whose decoded row two DIFFERENT repositories disagree (TDD §4.4).
   * The one case worth alarming about: EDOPro loads repositories in its
   * `configs.json` order and we load them in sorted path order, so only here
   * can the two end up with different cards.
   */
  conflicts: number;
}

/**
 * No 64-bit value may reach JavaScript (TDD §4.1): `setcode`, `race` and
 * `type` are unpacked here, where integers are 64-bit. Every other column is
 * masked to its low 32 bits as well — EDOPro reads them through
 * `static_cast<uint32_t>` / `sqlite3_column_int` (`gframe/data_manager.cpp:120-153`),
 * so a stray wide value in a malformed row is truncated rather than rounded.
 * The last column is the sign bit of the 32-bit `level` the client reads.
 */
const ROW_QUERY = `
SELECT d.id & 0xffffffff, d.ot & 0xffffffff, d.alias & 0xffffffff, d.type & 0xffffffff,
       d.atk & 0xffffffff, d.def & 0xffffffff,
       d.level & 0xff, (d.level >> 24) & 0xff, (d.level >> 16) & 0xff,
       d.race & 0xffffffff, (d.race >> 32) & 0xffffffff, d.attribute & 0xffffffff,
       d.setcode & 0xffff, (d.setcode >> 16) & 0xffff, (d.setcode >> 32) & 0xffff, (d.setcode >> 48) & 0xffff,
       t.name, (d.level >> 31) & 1
FROM datas d JOIN texts t ON t.id = d.id`;

/** `CardDataC::CARD_ARTWORK_VERSIONS_OFFSET`, `gframe/data_manager.h:74` (edopro@30935e8). */
const CARD_ARTWORK_VERSIONS_OFFSET = 10;

/** A decoded `datas`⋈`texts` row, before alias handling and the population filter. */
interface Row {
  id: number;
  ot: number;
  alias: number;
  type: number;
  atk: number;
  def: number;
  level: number;
  lscale: number;
  rscale: number;
  race: number;
  raceHi: number;
  attribute: number;
  /** The row's own codes; the record's come from the alias target. */
  setcodes: number[];
  name: string;
}

interface Entry {
  card: CardRecord;
  normalized: string;
}

function uint32(value: unknown): number {
  return typeof value === 'number' ? value >>> 0 : 0;
}

function int32(value: unknown): number {
  return typeof value === 'number' ? value | 0 : 0;
}

function decodeRow(v: unknown[]): Row {
  const level = uint32(v[6]);
  return {
    id: uint32(v[0]),
    ot: uint32(v[1]),
    alias: uint32(v[2]),
    type: uint32(v[3]),
    atk: int32(v[4]),
    def: int32(v[5]),
    // A negative raw level means -(level & 0xff) (`gframe/data_manager.cpp:146-149`).
    level: uint32(v[17]) !== 0 ? -level : level,
    lscale: uint32(v[7]),
    rscale: uint32(v[8]),
    race: uint32(v[9]),
    raceHi: uint32(v[10]),
    attribute: uint32(v[11]),
    // Zero slots are skipped, not terminators.
    setcodes: [uint32(v[12]), uint32(v[13]), uint32(v[14]), uint32(v[15])].filter((c) => c !== 0),
    name: typeof v[16] === 'string' ? v[16] : '',
  };
}

function sameStats(a: Row, b: Row): boolean {
  return (
    a.type === b.type &&
    a.atk === b.atk &&
    a.def === b.def &&
    a.level === b.level &&
    a.lscale === b.lscale &&
    a.rscale === b.rscale &&
    a.race === b.race &&
    a.raceHi === b.raceHi &&
    a.attribute === b.attribute
  );
}

function sameRow(a: Row, b: Row): boolean {
  return (
    a.ot === b.ot &&
    a.alias === b.alias &&
    a.name === b.name &&
    sameStats(a, b) &&
    a.setcodes.length === b.setcodes.length &&
    a.setcodes.every((code, i) => code === b.setcodes[i])
  );
}

/**
 * Alternate artwork (TDD §4.3): within EDOPro's ±10 window, or — for the far
 * reprints the window misses — the same name with identical stats. A
 * same-name-different-card alias fails the stats test and a "treated as"
 * alias fails the name test, so both stay distinct records.
 */
function isAlternateArtwork(row: Row, target: Row): boolean {
  if (Math.abs(row.id - target.id) < CARD_ARTWORK_VERSIONS_OFFSET) return true;
  return normalize(row.name) === normalize(target.name) && sameStats(row, target);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Alphabetical by normalized name: the order prefix ranges are searched in. */
function byName(a: Entry, b: Entry): number {
  return compareText(a.normalized, b.normalized) || a.card.code - b.card.code;
}

/** Search ranking within a match class: shorter names first, then alphabetical. */
function byRank(a: Entry, b: Entry): number {
  return a.card.name.length - b.card.name.length || byName(a, b);
}

/** True when `name` has a word boundary at `at` — the end of the name, or a
 * character that is not a letter or digit. */
function endsWord(name: string, at: number): boolean {
  const next = name[at];
  return next === undefined || !/[\p{L}\p{N}]/u.test(next);
}

/**
 * Ranking within the prefix class. A query that ends on a word boundary beats
 * one that cuts a word in half, and only then do shorter names win.
 *
 * Length alone is not enough, and neither is alphabetical order: `ash` has to
 * find Ash Blossom & Joyous Spring rather than the shorter Ashoka Pillar,
 * while `pot` has to find Pot of Greed rather than the alphabetically earlier
 * Pot of Acquisitiveness. A whole typed word separates the two cases.
 */
function byPrefixRank(needle: string): (a: Entry, b: Entry) => number {
  return (a, b) => {
    const aWord = endsWord(a.normalized, needle.length);
    if (aWord !== endsWord(b.normalized, needle.length)) return aWord ? -1 : 1;
    return byRank(a, b);
  };
}

/** First index in `entries` (sorted by `byName`) for which `pred` is false. */
function partitionPoint(entries: readonly Entry[], pred: (entry: Entry) => boolean): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(entries[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * In-memory index of the Main Deck card population (TDD §4), built from the
 * raw bytes of EDOPro's `.cdb` files. The filesystem walk lives in the caller.
 */
export class CardIndex {
  private readonly byCode = new Map<number, CardRecord>();
  /** Sorted by `byName`; also the iteration order of `all()`. */
  private readonly alphabetical: Entry[];
  /** Sorted by `byRank`, so a substring scan can stop at `limit`. */
  private readonly ranked: Entry[];

  private constructor(
    cards: CardRecord[],
    private readonly counts: Omit<CardIndexStatus, 'cards'>,
  ) {
    const entries = cards.map((card) => ({ card, normalized: normalize(card.name) }));
    for (const card of cards) this.byCode.set(card.code, card);
    this.alphabetical = [...entries].sort(byName);
    this.ranked = [...entries].sort(byRank);
  }

  static empty(): CardIndex {
    return new CardIndex([], {
      databases: 0,
      skippedDatabases: 0,
      replacedRows: 0,
      conflicts: 0,
    });
  }

  /**
   * Merge `sources` in load order — later rows REPLACE earlier rows with the
   * same id (TDD §4.4) — then apply alias handling and the population filter.
   * A database that fails to open or query is skipped: "load what parses".
   *
   * Two counts describe the merge. `replacedRows` is every id whose row a
   * later database changed. `conflicts` is the subset that depends on the
   * order repositories load in: within one repository the last row for an id
   * is that repository's row, and an id is a conflict when two repositories'
   * rows for it differ — the merged row is then whichever loads last. A base
   * or `expansions/` row overridden by a repository is not a conflict (those
   * always load first), nor is a repository overriding itself.
   *
   * Alternate artwork is collapsed on the merged raw rows BEFORE the
   * population filter. The two orders differ only when a reprint passes the
   * filter and its target does not (no such row exists in BabelCDB@47fc046);
   * deciding first keeps "this row is the same card as its target" a fact
   * about the data rather than about a setting, so toggling pre-release cards
   * can never make a reprint surface as a card in its own right.
   */
  static fromDatabases(
    SQL: SqlEngine,
    sources: CardDatabaseSource[],
    opts: CardIndexOptions = {},
  ): CardIndex {
    const includePrerelease = opts.includePrerelease ?? true;
    const rows = new Map<number, Row>();
    const replaced = new Set<number>();
    /** id → repository → that repository's (last) row for the id. */
    const byRepository = new Map<number, Map<string, Row>>();
    let loaded = 0;
    let skipped = 0;

    for (const { bytes, repository } of sources) {
      let db: SqlDatabase | null = null;
      let decoded: Row[];
      try {
        db = new SQL.Database(bytes);
        decoded = (db.exec(ROW_QUERY)[0]?.values ?? []).map(decodeRow);
      } catch {
        skipped++;
        continue;
      } finally {
        db?.close();
      }
      loaded++;
      for (const row of decoded) {
        const earlier = rows.get(row.id);
        if (earlier !== undefined && !sameRow(earlier, row)) replaced.add(row.id);
        rows.set(row.id, row);
        if (repository === undefined) continue;
        const claims = byRepository.get(row.id);
        if (claims === undefined) byRepository.set(row.id, new Map([[repository, row]]));
        else claims.set(repository, row);
      }
    }

    let conflicts = 0;
    for (const claims of byRepository.values()) {
      const [first, ...rest] = claims.values();
      if (rest.some((row) => !sameRow(first!, row))) conflicts++;
    }

    const cards: CardRecord[] = [];
    for (const row of rows.values()) {
      // An alias whose target is missing keeps the row under its own code.
      const target = row.alias !== 0 && row.alias !== row.id ? rows.get(row.alias) : undefined;
      if (target !== undefined && isAlternateArtwork(row, target)) continue;
      if (!isMainDeckEligible(row.type) || !isOfficialScope(row.ot, includePrerelease)) continue;
      cards.push({
        code: row.id,
        name: row.name,
        limitCode: target !== undefined ? target.id : row.id,
        ot: row.ot,
        type: row.type,
        atk: row.atk,
        def: row.def,
        level: row.level,
        lscale: row.lscale,
        rscale: row.rscale,
        race: row.race,
        raceHi: row.raceHi,
        attribute: row.attribute,
        // Read from the alias target, one hop, as client and core both do
        // (`gframe/deck_con.cpp:1325-1331`, `ocgcore/card.cpp:333`).
        setcodes: [...(target ?? row).setcodes],
      });
    }
    return new CardIndex(cards, {
      databases: loaded,
      skippedDatabases: skipped,
      replacedRows: replaced.size,
      conflicts,
    });
  }

  get status(): CardIndexStatus {
    return { ...this.counts, cards: this.byCode.size };
  }

  get(code: number): CardRecord | undefined {
    return this.byCode.get(code);
  }

  /**
   * Every record whose whole name equals `name` after normalization, by code.
   * Names are not unique — "Black Luster Soldier" is two cards (TDD §4.3) — so
   * a `[Card Name]` reference that gets several back is an error, not a pick.
   */
  findByName(name: string): CardRecord[] {
    const needle = normalize(name.trim());
    const hits: CardRecord[] = [];
    const start = partitionPoint(this.alphabetical, (e) => e.normalized < needle);
    for (let i = start; this.alphabetical[i]?.normalized === needle; i++)
      hits.push(this.alphabetical[i]!.card);
    return hits;
  }

  /** Every record, alphabetical by normalized name (ties by code). */
  *all(): IterableIterator<CardRecord> {
    for (const entry of this.alphabetical) yield entry.card;
  }

  /**
   * How many records satisfy `pred`. For a description, pass
   * `matcher(desc, groups)` from `core/desc/evaluate` (TDD §5.3): `core/desc`
   * builds on `core/cards`, so the index takes a predicate rather than import it.
   */
  count(pred: (card: CardRecord) => boolean): number {
    let n = 0;
    for (const card of this.all()) if (pred(card)) n++;
    return n;
  }

  /** The first `n` matching records in `all()` order. */
  sample(pred: (card: CardRecord) => boolean, n: number): CardRecord[] {
    const out: CardRecord[] = [];
    for (const card of this.all()) {
      if (out.length >= n) break;
      if (pred(card)) out.push(card);
    }
    return out;
  }

  /**
   * Diacritic- and case-insensitive name search. Prefix matches rank above
   * substring matches; within each, shorter names first, then alphabetical.
   * Prefix hits are a binary-searched range of the alphabetical array; the
   * substring scan walks the ranked array and stops once `limit` is reached.
   */
  search(query: string, limit = 20): CardRecord[] {
    const needle = normalize(query.trim());
    if (needle === '' || limit <= 0) return [];

    const start = partitionPoint(this.alphabetical, (e) => e.normalized < needle);
    const end = partitionPoint(
      this.alphabetical,
      (e) => e.normalized < needle || e.normalized.startsWith(needle),
    );
    const hits = this.alphabetical.slice(start, end).sort(byPrefixRank(needle)).slice(0, limit);

    for (const entry of this.ranked) {
      if (hits.length >= limit) break;
      if (entry.normalized.indexOf(needle) > 0) hits.push(entry);
    }
    return hits.map((entry) => entry.card);
  }
}
