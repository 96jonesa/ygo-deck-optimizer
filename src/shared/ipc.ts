import type {
  AnalyzeTemplateResult,
  AppInfo,
  CardHit,
  CardInfo,
  CardStatus,
  CompleteNameRequest,
  CompleteNameResult,
  DeckImportRequest,
  DeckImportResult,
  DeckListResult,
  DescParseRequest,
  DescParseResult,
  ResultsExportRequest,
  ResultsExportResult,
  RunControlResult,
  RunEvent,
  RunStartRequest,
  RunStartResult,
  Sequenced,
  Settings,
  SettingsPatch,
  Template,
  TemplateOpenResult,
  TemplateSaveResult,
  WorkdirHealth,
} from './types';

export type { AppInfo };

/**
 * The IPC contract (TDD §12), defined once: main registers a handler per
 * invoke channel — every entry here is one — and the preload implements
 * `RendererApi` over them.
 *
 * `deck:list` and `deck:import` are not in §12's table: `.ydk` import was
 * folded into this slice, and listing the install's decks by name is what
 * keeps a file dialog off the common path.
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
  templateOpen: 'template:open',
  templateSave: 'template:save',
  deckList: 'deck:list',
  deckImport: 'deck:import',
  resultsExport: 'results:export',
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
   * Choose a template file and read it (TDD §14). The dialog, the read and the
   * validation all happen in main; what comes back is a `Template` the editor
   * can hold, plus what this install's card data says about the cards the file
   * recorded.
   */
  openTemplate(): Promise<TemplateOpenResult>;
  /**
   * Choose a destination and write the template there, with the authoritative
   * AST beside every text and a snapshot of every named card. The renderer
   * hands over the template and never a path.
   */
  saveTemplate(template: Template): Promise<TemplateSaveResult>;
  /** The decks in the install's `deck/` folder, by name; the folder is main's to know. */
  listDecks(): Promise<DeckListResult>;
  /**
   * Read a `.ydk` decklist as a template: one line per distinct card at the
   * count the deck holds (PRD §9). `name` is one of `listDecks`'s; without one,
   * a file dialog opens, for a deck kept outside the install.
   */
  importDeck(request?: DeckImportRequest): Promise<DeckImportResult>;
  /** Write a finished run to a file the user chooses; exact fractions, never percentages. */
  exportResults(request: ResultsExportRequest): Promise<ResultsExportResult>;
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
