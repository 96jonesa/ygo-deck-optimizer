import type {
  AnalyzeTemplateResult,
  AppInfo,
  CardHit,
  CardInfo,
  CardStatus,
  CompleteNameRequest,
  CompleteNameResult,
  DescParseRequest,
  DescParseResult,
  RunControlResult,
  RunEvent,
  RunStartRequest,
  RunStartResult,
  Sequenced,
  Settings,
  SettingsPatch,
  Template,
  WorkdirHealth,
} from './types';

export type { AppInfo };

/**
 * The IPC contract (TDD §12), defined once: main registers a handler per
 * invoke channel — every entry here is one — and the preload implements
 * `RendererApi` over them. `template:open` / `template:save` and
 * `results:export` arrive with their slices.
 */
export const IpcChannels = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  workdirProbe: 'workdir:probe',
  pickDirectory: 'dialog:pickDirectory',
  /** Invoke AND main→renderer push: the same payload either way. */
  cardsStatus: 'cards:status',
  cardsReindex: 'cards:reindex',
  cardsSearch: 'cards:search',
  cardsGet: 'cards:get',
  descParse: 'desc:parse',
  descComplete: 'desc:complete',
  templateAnalyze: 'template:analyze',
  runStart: 'run:start',
  runCancel: 'run:cancel',
  runConfirm: 'run:confirm',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

/** Main→renderer pushes that are ONLY pushes: nothing to invoke, so no handler is registered for them. */
export const IpcEvents = {
  runEvent: 'run:event',
} as const;

/** The api exposed on window.api by the preload bridge. */
export interface RendererApi {
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<Settings>;
  /** Persists the change; a changed `workdir` or `includePrerelease` reloads the cards. */
  setSettings(patch: SettingsPatch): Promise<Settings>;
  probeWorkdir(dir: string): Promise<WorkdirHealth>;
  /** The system's folder dialog; `null` when it is cancelled. */
  pickDirectory(): Promise<string | null>;
  getCardStatus(): Promise<CardStatus>;
  /** Called on every change of the card index's status. Returns the unsubscribe. */
  onCardStatus(listener: (status: CardStatus) => void): () => void;
  /** Reload the cards from disk; the status follows by push. */
  reindexCards(): Promise<void>;
  searchCards(query: string, limit?: number): Promise<CardHit[]>;
  /** The cards that exist, in the order asked for; an unknown passcode is left out. */
  getCards(passcodes: number[]): Promise<CardInfo[]>;
  parseDescription(request: Sequenced<DescParseRequest>): Promise<Sequenced<DescParseResult>>;
  /**
   * The names that could go where the caret is (PRD §5.2). Which names those
   * are, and how each is written back, are decisions of the card index and the
   * setname table, so they are made here and not in the renderer (TDD §3).
   */
  completeName(request: Sequenced<CompleteNameRequest>): Promise<Sequenced<CompleteNameResult>>;
  /** The template is validated again in main: a structurally broken one comes back as `invalid`. */
  analyzeTemplate(request: Sequenced<Template>): Promise<Sequenced<AnalyzeTemplateResult>>;
  /**
   * Start searching the template, cancelling any run before it (one run at a
   * time, app-wide). What happens next arrives by `onRunEvent` under the
   * `runId` — `started` possibly BEFORE this resolves, so subscribe first.
   */
  startRun(request: RunStartRequest): Promise<RunStartResult>;
  /**
   * Graceful: the search stops at its next progress report and its partial
   * result arrives as the `cancelled` event. Otherwise the run is abandoned.
   * Resolves when the run has ended.
   */
  cancelRun(runId: number, opts?: { graceful?: boolean }): Promise<RunControlResult>;
  /** The user's yes to a `needs-confirmation` event: the run goes ahead. */
  confirmRun(runId: number): Promise<RunControlResult>;
  /** Called on every event of the active run. Returns the unsubscribe. */
  onRunEvent(listener: (event: RunEvent) => void): () => void;
}
