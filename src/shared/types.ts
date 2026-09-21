import type { Description } from '../core/desc/ast';
import type { CompletionSite, NameKind } from '../core/desc/completion';
import type { Span } from '../core/desc/lexer';
import type { Analysis } from '../core/model/analyze';
import type { CardSnapshot, Template, TemplateGroup } from '../core/model/template';
import type { OptimizeProgress, OptimizeResult, Rational } from '../core/opt/optimizer';
import type { Count } from '../core/util/count';
import type { WorkerResult } from '../worker/protocol';

// The payloads of the IPC contract (TDD §12). Everything here is a plain,
// structured-cloneable object, and everything imported is a TYPE: nothing from
// `src/core` may reach the renderer or the preload bundle through this file.

export type {
  Analysis,
  Appearance,
  ClassAnalysis,
  ClassesAnalysis,
  CostModel,
  CriterionAnalysis,
  GroupAnalysis,
  IgnoredLine,
  Issue,
  IssueCode,
  LimitAnalysis,
  LineAnalysis,
  NearMissAnalysis,
  ParsedText,
  RemainderAnalysis,
  RequirementAnalysis,
  Severity,
  SubsumedAlternative,
  TotalsAnalysis,
  WorkAnalysis,
} from '../core/model/analyze';
export type { ExpandedClass } from '../core/model/compile';
export type { DrawSpec } from '../core/model/problem';
export type { IntRange } from '../core/model/ranges';
export type {
  CardSnapshot,
  Template,
  TemplateCard,
  TemplateCriterion,
  TemplateGroup,
  TemplateLine,
  TemplateRemainder,
} from '../core/model/template';
export type {
  CriterionScore,
  IrrelevantLine,
  LineSweep,
  OptimizeProgress,
  PlateauResult,
  RankedVector,
  Rational,
  ScoredVector,
  SweepCell,
} from '../core/opt/optimizer';
export type { BlendPart, BlendScore, Fraction } from '../core/prob/scorer';
export type { Count } from '../core/util/count';
export type { LineRatio, RunExtras, RunLine } from '../worker/protocol';
export type { CompletionSite, Description, NameKind, Span };

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

/**
 * What `desc:complete` is asked: the field's whole text and where the caret
 * is in it. The caret is what decides everything — which of the three
 * delimited names is being typed, and what span a pick replaces — so it
 * travels with the text rather than being guessed from it.
 */
export interface CompleteNameRequest {
  text: string;
  /** The caret's offset into `text`. */
  caret: number;
  /** The template's groups, which `{group}` completes against. */
  groups: TemplateGroup[];
}

/** One row of the inline completion popup. */
export interface CompletionOption {
  /** The name, as the row reads it. */
  label: string;
  /** What tells one row from another: a typeline, a setcode, a card count. */
  detail: string;
  /** The text that replaces the site's `[start, end)` — always something that resolves back to this row. */
  insert: string;
  /** Unique within one list: the row's key. */
  key: string;
  /** Another row reads the same, so the detail is what tells them apart. */
  ambiguous: boolean;
}

/**
 * `site` is `null` when the caret is not inside a name, which is the usual
 * answer and the one that closes the popup. A site with no options is not the
 * same thing: the name is being typed and nothing matches it yet.
 */
export type CompleteNameResult =
  | { ok: true; site: CompletionSite | null; options: CompletionOption[] }
  | NotReady
  | InvalidRequest;

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

// ---------------------------------------------------------------------------
// Runs (TDD §3, §12)
// ---------------------------------------------------------------------------

/** The most plateau vectors a run keeps unless asked for more: the core's own cap of 10,000 is 2–3 MB over IPC. */
export const RUN_PLATEAU_CAP_DEFAULT = 500;
/** The most the renderer may ask for: the core's default. */
export const RUN_PLATEAU_CAP_MAX = 10_000;
export const RUN_TOP_K_DEFAULT = 200;
export const RUN_TOP_K_MAX = 1000;

/** What the renderer may say about a run; everything has a default. */
export interface RunOptions {
  /** Rows of the ranked table. Default 200, at most 1,000. */
  topK?: number;
  /** Plateau vectors kept. Default 500, at most 10,000; the plateau's SIZE stays exact either way. */
  plateauCap?: number;
  /** The plateau's width as an exact fraction of 1. Default: the `plateauDelta` setting. */
  plateauDelta?: Rational;
  /** An estimate over this asks first (`needs-confirmation`). Default 60,000. */
  confirmThresholdMs?: number;
  /** The least time between two progress events. Default 100. */
  progressIntervalMs?: number;
  /** Run without asking, whatever the estimate. */
  force?: boolean;
}

export interface RunStartRequest {
  template: Template;
  options?: RunOptions;
}

/** The template has errors, so nothing was started; the analysis says where. */
export interface TemplateErrors {
  ok: false;
  reason: 'template-errors';
  analysis: Analysis;
}

export type RunStartResult =
  | { ok: true; runId: number }
  | NotReady
  | InvalidRequest
  | TemplateErrors;

/** `not-active`: the run is over, was superseded, or never was — or, for a confirmation, is not waiting for one. */
export type RunControlResult = { ok: true } | { ok: false; reason: 'not-active' | 'invalid' };

export interface RunCancelRequest {
  runId: number;
  /** Stop at the next progress report and keep the partial result; otherwise abandon the run. Default false. */
  graceful?: boolean;
}

/**
 * One `at most n× q` the run's criteria carried, as PRD §6.3's footnote needs
 * it. Pinned to the RUN rather than read back off the analysis: a result stays
 * on screen while the template is edited, and a caveat about a number has to
 * be true of the number it sits under.
 */
export interface RunLimit {
  /** The limit's canonical description: `#89631139`, `trap`. */
  text: string;
  /** The counts it appears under, ascending; `0` is `no trap`. */
  counts: number[];
  /** Lines that might hold matching cards and are NOT counted, labelled as the run labels them. */
  blind: { label: string; min: number; max: number }[];
  /** What those lines hold together; `null` when every line is specific enough. */
  blindRange: { min: number; max: number } | null;
}

/** A limit the engine left out of the scoring because it holds of every hand. */
export interface RunDroppedLimit {
  text: string;
  n: number;
  reason: 'counts-nothing' | 'never-binds';
}

/** A search that scored something — all of it, or (`partial`) what it got to — with the caps it ran under. */
export type RunResult = Extract<WorkerResult, { status: 'done' | 'cancelled' }> & {
  /** What the run service held the result to, so that it can cross IPC: see `plateau.truncated`. */
  limits: { topK: number; plateauCap: number };
  /** What the run's CRITERIA limited (PRD §6.3) — not to be confused with `limits`, which are the caps. */
  criterionLimits: RunLimit[];
  /** Limits the engine left out because they hold of every hand; one entry per flat alternative reached. */
  droppedLimits: RunDroppedLimit[];
};

/** Why a run waits to be confirmed: `optimize`'s refusal, without its status. */
export type RunConfirmation = Omit<
  Extract<OptimizeResult, { status: 'needs-confirmation' }>,
  'status'
>;

/**
 * Pushed on `run:event`. A run is `started`, reports `progress`, may stop once
 * at `needs-confirmation` (until `run:confirm`), and ends in EXACTLY ONE of
 * `result` (the whole search), `cancelled` or `error`. One run is active at a
 * time; an event of any other run is never sent.
 */
export type RunEvent =
  | {
      runId: number;
      type: 'started';
      /** Class vectors to score, and the estimate, as the analysis has them. */
      total: Count | null;
      estimatedMs: number | null;
    }
  | { runId: number; type: 'progress'; progress: OptimizeProgress }
  | { runId: number; type: 'needs-confirmation'; confirmation: RunConfirmation }
  | { runId: number; type: 'result'; result: RunResult }
  /** `result` is what a graceful stop had scored; `null` when the run was abandoned. */
  | { runId: number; type: 'cancelled'; result: RunResult | null }
  | { runId: number; type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Files: decks in, templates in and out, results out (TDD §12, §14)
// ---------------------------------------------------------------------------

/** A dialog the USER cancelled: not a failure, and nothing to say about it. */
export interface Cancelled {
  ok: false;
  reason: 'cancelled';
}

/** A file that could not be read or written, with the reason the OS gave. */
export interface FileFailure {
  ok: false;
  reason: 'read' | 'write';
  message: string;
}

/**
 * The decks in the user's EDOPro `deck/` folder, by the name shown there.
 * Names, not paths: the renderer never receives a filesystem path it could
 * hand back (TDD §3), and `deck:import` takes a name from this list.
 */
export type DeckListResult = { ok: true; decks: string[] } | NotReady | FileFailure;

/** `name` is one of `deck:list`'s; leaving it out opens a file dialog instead. */
export interface DeckImportRequest {
  name?: string;
}

/** What the import saw, for the line that says what happened. */
export interface DeckSummary {
  /** The deck's own name, or the file's when it came from the dialog. */
  name: string;
  /** Entries in `#main`, before any clamping. */
  mainSize: number;
  /** Distinct cards, which is how many lines it became. */
  distinct: number;
}

export type DeckImportResult =
  | { ok: true; template: Template; deck: DeckSummary; warnings: string[] }
  | Cancelled
  | FileFailure
  | NotReady
  | InvalidRequest;

export type TemplateOpenResult =
  | {
      ok: true;
      template: Template;
      /** Where it came from, to show; the renderer is never given a path to WRITE. */
      path: string;
      /** What this install's card data says about the cards the file recorded (TDD §14). */
      notices: string[];
    }
  | Cancelled
  | FileFailure
  | NotReady
  | InvalidRequest;

export type TemplateSaveResult =
  | { ok: true; path: string; warnings: string[] }
  | Cancelled
  | FileFailure
  | NotReady
  | InvalidRequest;

/** CSV is the ranked table, for a spreadsheet; JSON is the whole result. */
export type ExportFormat = 'csv' | 'json';

export interface ResultsExportRequest {
  runId: number;
  format: ExportFormat;
}

export type ResultsExportResult =
  | { ok: true; path: string }
  | Cancelled
  | FileFailure
  /** The run is not the last one to have finished: there is nothing to export. */
  | { ok: false; reason: 'no-run'; message: string }
  | InvalidRequest;
