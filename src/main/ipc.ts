import { IpcChannels } from '../shared/ipc';
import type {
  AnalyzeTemplateResult,
  AppInfo,
  CardHit,
  CardInfo,
  CardStatus,
  DescParseResult,
  Sequenced,
  Settings,
  SettingsPatch,
  WorkdirHealth,
} from '../shared/types';
import type { CardLoadOptions } from './services/cards';

// The main side of the IPC contract (TDD §12): thin handlers over the
// services. No Electron import — `ipcMain` comes in as the one method used, so
// the whole contract is exercised under vitest with a fake.

/** The slice of Electron's `ipcMain` used here; `ipcMain` satisfies it. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** What the handlers delegate to. `SettingsStore`, `CardService` and `TemplateService` satisfy it. */
export interface IpcDeps {
  appInfo(): AppInfo;
  settings: { get(): Settings; set(patch: SettingsPatch): Settings };
  cards: {
    status(): CardStatus;
    reload(workdir: string | null, opts: CardLoadOptions): Promise<void>;
    reindex(): Promise<void>;
    search(query: string, limit?: number): CardHit[];
    get(passcodes: readonly number[]): CardInfo[];
  };
  templates: {
    parseDescription(text: unknown, groups: unknown): DescParseResult;
    analyzeTemplate(template: unknown): AnalyzeTemplateResult;
  };
  probe(dir: string): WorkdirHealth;
  /** The system's folder dialog; `null` when it is cancelled. */
  pickDirectory(): Promise<string | null>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Answer `request` under its own sequence number (TDD §12), so the renderer
 * can drop an answer that a newer request has overtaken. A request without
 * one is answered under -1, which no request carries.
 */
function sequenced<T>(request: unknown, answer: (payload: unknown) => T): Sequenced<T> {
  const { seq, payload } = isObject(request) ? request : {};
  return { seq: typeof seq === 'number' ? seq : -1, payload: answer(payload) };
}

/**
 * Register every invoke handler of the contract. Call it ONCE, at app start,
 * never per window: `ipcMain.handle` throws on a channel that already has a
 * handler, which is how the sibling's per-window registration would fail on
 * its second window (TDD §3). Arguments come from the renderer, so each
 * handler checks what it is given before it delegates.
 */
export function registerIpc(ipcMain: IpcMainLike, deps: IpcDeps): void {
  const { settings, cards, templates } = deps;

  ipcMain.handle(IpcChannels.appInfo, () => deps.appInfo());

  ipcMain.handle(IpcChannels.settingsGet, () => settings.get());

  ipcMain.handle(IpcChannels.settingsSet, (_event, patch) => {
    const before = settings.get();
    // Persist first: a load that starts now must find the new settings on disk.
    const after = settings.set(isObject(patch) ? patch : {});
    if (after.workdir !== before.workdir || after.includePrerelease !== before.includePrerelease)
      void cards.reload(after.workdir, { includePrerelease: after.includePrerelease });
    return after;
  });

  ipcMain.handle(IpcChannels.workdirProbe, (_event, dir) =>
    deps.probe(typeof dir === 'string' ? dir : ''),
  );

  ipcMain.handle(IpcChannels.pickDirectory, () => deps.pickDirectory());

  ipcMain.handle(IpcChannels.cardsStatus, () => cards.status());

  // Not awaited: the status follows by push.
  ipcMain.handle(IpcChannels.cardsReindex, () => {
    void cards.reindex();
  });

  ipcMain.handle(IpcChannels.cardsSearch, (_event, request) => {
    if (!isObject(request) || typeof request.query !== 'string') return [];
    return cards.search(
      request.query,
      typeof request.limit === 'number' ? request.limit : undefined,
    );
  });

  ipcMain.handle(IpcChannels.cardsGet, (_event, passcodes) =>
    cards.get(
      Array.isArray(passcodes)
        ? passcodes.filter((passcode): passcode is number => Number.isInteger(passcode))
        : [],
    ),
  );

  ipcMain.handle(IpcChannels.descParse, (_event, request) =>
    sequenced(request, (payload) => {
      const { text, groups } = isObject(payload) ? payload : {};
      return templates.parseDescription(text, groups);
    }),
  );

  ipcMain.handle(IpcChannels.templateAnalyze, (_event, request) =>
    sequenced(request, (payload) => templates.analyzeTemplate(payload)),
  );
}
