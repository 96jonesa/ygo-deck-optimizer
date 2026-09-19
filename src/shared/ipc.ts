import type {
  AnalyzeTemplateResult,
  AppInfo,
  CardHit,
  CardInfo,
  CardStatus,
  DescParseRequest,
  DescParseResult,
  Sequenced,
  Settings,
  SettingsPatch,
  Template,
  WorkdirHealth,
} from './types';

export type { AppInfo };

/**
 * The IPC contract (TDD §12), defined once: main registers a handler per
 * invoke channel, the preload implements `RendererApi` over them. `run:*`,
 * `template:open` / `template:save` and `results:export` arrive with their slices.
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
  templateAnalyze: 'template:analyze',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

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
  /** The template is validated again in main: a structurally broken one comes back as `invalid`. */
  analyzeTemplate(request: Sequenced<Template>): Promise<Sequenced<AnalyzeTemplateResult>>;
}
