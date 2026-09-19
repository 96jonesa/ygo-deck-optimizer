import { IpcChannels } from '../shared/ipc';
import type { AppInfo, CardStatus } from '../shared/types';
import { autodetectWorkdir, probeWorkdir } from './edopro/probe';
import { type IpcMainLike, registerIpc } from './ipc';
import { type CardLoader, CardService } from './services/cards';
import { TemplateService } from './services/templates';
import { SettingsStore } from './store/settings';

// The main process minus Electron (TDD §3): what `index.ts` wires Electron
// into. Everything Electron provides comes in through `MainAppDeps`, so the
// startup sequence — IPC once, first-run detection, the initial load, the
// status pushes — runs under vitest as it runs in the app.

export interface MainAppDeps {
  ipcMain: IpcMainLike;
  /** `app.getPath('userData')`: where `settings.json` lives. */
  userDataDir: string;
  /** Where an install conventionally lives on this platform, tried on first run. */
  candidates: readonly string[];
  appInfo(): AppInfo;
  loadCards: CardLoader;
  /** Open one more app window. */
  createWindow(): void;
  /** Send to every open window. */
  broadcast(channel: string, payload: unknown): void;
  /** The system's folder dialog; `null` when it is cancelled. */
  pickDirectory(): Promise<string | null>;
  /** One line per change of the card status; absent unless debugging. */
  log?: ((line: string) => void) | undefined;
}

function statusLine(status: CardStatus): string {
  const head = `[cards] ${status.state} workdir=${status.workdir}`;
  if (status.state === 'error') return `${head} error=${status.error}`;
  if (status.state !== 'ready') return head;
  return `${head} databases=${status.databases} skipped=${status.skippedDatabases} cards=${status.cards} replacedRows=${status.replacedRows} conflicts=${status.conflicts} setnames=${status.setnames}`;
}

export class MainApp {
  readonly settings: SettingsStore;
  readonly cards: CardService;
  readonly templates: TemplateService;

  constructor(private readonly deps: MainAppDeps) {
    this.settings = new SettingsStore(deps.userDataDir);
    // Pushed, never polled (TDD §3): every change goes to every open window.
    this.cards = new CardService(deps.loadCards, (status) => {
      deps.log?.(statusLine(status));
      deps.broadcast(IpcChannels.cardsStatus, status);
    });
    this.templates = new TemplateService(this.cards);
  }

  /**
   * Call once, when Electron is ready. Registers the IPC handlers — here and
   * nowhere else, so that a second window cannot register them again — opens
   * the first window, and loads the cards; on first run (no workdir stored)
   * the conventional locations are tried first, and one that probes ok is
   * saved. Resolves when the initial load has settled; the window does not
   * wait for it, and learns of it by push.
   */
  start(): Promise<void> {
    const { deps, settings, cards, templates } = this;
    registerIpc(deps.ipcMain, {
      appInfo: deps.appInfo,
      settings,
      cards,
      templates,
      probe: probeWorkdir,
      pickDirectory: deps.pickDirectory,
    });
    this.openWindow();

    let { workdir, includePrerelease } = settings.get();
    if (workdir === null) {
      const found = autodetectWorkdir(deps.candidates, probeWorkdir);
      if (found !== null) {
        workdir = found.path;
        try {
          settings.set({ workdir });
        } catch {
          // An unwritable settings folder costs the detection next time, not the cards now.
        }
      }
    }
    return cards.reload(workdir, { includePrerelease });
  }

  /** One more window, e.g. on macOS `activate`. Registers nothing. */
  openWindow(): void {
    this.deps.createWindow();
  }
}
