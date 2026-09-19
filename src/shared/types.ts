import type { Description } from '../core/desc/ast';
import type { Span } from '../core/desc/lexer';
import type { Analysis } from '../core/model/analyze';
import type { TemplateGroup } from '../core/model/template';

// The payloads of the IPC contract (TDD §12). Everything here is a plain,
// structured-cloneable object, and everything imported is a TYPE: nothing from
// `src/core` may reach the renderer or the preload bundle through this file.

export type {
  Analysis,
  ClassAnalysis,
  ClassesAnalysis,
  CriterionAnalysis,
  GroupAnalysis,
  Issue,
  IssueCode,
  LimitAnalysis,
  LineAnalysis,
  NearMissAnalysis,
  ParsedText,
  RemainderAnalysis,
  RequirementAnalysis,
  Severity,
  TotalsAnalysis,
  WorkAnalysis,
} from '../core/model/analyze';
export type {
  Template,
  TemplateCard,
  TemplateCriterion,
  TemplateGroup,
  TemplateLine,
  TemplateRemainder,
} from '../core/model/template';
export type { Description, Span };

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  packaged: boolean;
}

/** `settings.json` (TDD §13). */
export interface Settings {
  version: 1;
  /** The EDOPro install; `null` until one is detected or chosen. */
  workdir: string | null;
  /** Include official pre-release cards in the population (TDD §4.2). */
  includePrerelease: boolean;
  /** The plateau's width as a probability: `0.005` is half a percentage point. */
  plateauDelta: number;
}

/** What `settings:set` takes: the fields to change. */
export type SettingsPatch = Partial<Omit<Settings, 'version'>>;

/** What the probe found in a directory (TDD §13). */
export interface WorkdirHealth {
  /** At least one non-empty card database: all this tool needs. */
  ok: boolean;
  path: string;
  /** Non-empty `.cdb` files, found by the loader's rules. */
  databases: number;
  /** `strings.conf` layers found. */
  stringsConf: number;
  /** Why the directory cannot be used; empty when `ok`. */
  problems: string[];
  /** Worth saying, but no obstacle: a missing `strings.conf`, an empty `cards.cdb`. */
  notes: string[];
}

export type CardState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The card index, as the renderer sees it: pushed on `cards:status` whenever
 * it changes, and invokable. The counts are those of `CardIndexStatus` (TDD
 * §4.4) and are zero unless `state` is `ready`.
 */
export interface CardStatus {
  /** `idle`: no install is set. `error`: the load failed, or found no database. */
  state: CardState;
  /** The install this status is about. */
  workdir: string | null;
  databases: number;
  skippedDatabases: number;
  cards: number;
  replacedRows: number;
  conflicts: number;
  /** Archetype names; `null` when the install has no `strings.conf` — archetype descriptions are then unavailable. */
  setnames: number | null;
  error?: string;
}

/** One row of the card picker. */
export interface CardHit {
  passcode: number;
  name: string;
  /** `Level 4 · WIND · Warrior · Effect Monster`, `Quick-Play Spell`. */
  typeline: string;
}

/** The fields a template file records of each named card (TDD §14 `cardSnapshot`). */
export interface CardSnapshot {
  type: number;
  attribute: number;
  race: number;
  level: number;
  atk: number;
  def: number;
  setcodes: number[];
}

export interface CardInfo extends CardHit {
  /** The passcode the 3-copy rule counts under (TDD §4.3). */
  limitCode: number;
  snapshot: CardSnapshot;
}

export interface CardSearchRequest {
  query: string;
  limit?: number;
}

/**
 * A request the renderer may fire faster than it is answered carries a
 * sequence number, and the response echoes it, so that a stale response can
 * be dropped (TDD §12).
 */
export interface Sequenced<T> {
  seq: number;
  payload: T;
}

export interface NotReady {
  ok: false;
  reason: 'not-ready';
  /** The card index's state: anything but `ready`. */
  state: CardState;
  message: string;
}

export interface InvalidRequest {
  ok: false;
  reason: 'invalid';
  message: string;
  /** Every structural problem found. */
  errors: string[];
}

export interface DescParseRequest {
  text: string;
  /** The template's groups, which `{group}` resolves through. */
  groups: TemplateGroup[];
}

export type DescParseResult =
  | {
      ok: true;
      desc: Description;
      /** Canonical text: what a template file stores. */
      canonical: string;
      /** What was understood, for the reader. */
      echo: string;
      /** Cards in the database that match. */
      count: number;
      /** Names of the first few. */
      samples: string[];
    }
  | { ok: false; reason: 'parse'; message: string; span: Span }
  | NotReady
  | InvalidRequest;

/**
 * `ok` says an `Analysis` was produced — not that the template can be run,
 * which is `analysis.ok`.
 */
export type AnalyzeTemplateResult = { ok: true; analysis: Analysis } | NotReady | InvalidRequest;
