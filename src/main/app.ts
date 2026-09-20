import { IpcChannels, IpcEvents } from '../shared/ipc';
import type { AppInfo, CardStatus, RunEvent } from '../shared/types';
import { autodetectWorkdir, probeWorkdir } from './edopro/probe';
import { type IpcMainLike, registerIpc } from './ipc';
import { type CardLoader, CardService } from './services/cards';
import { DeckService } from './services/decks';
import { type FileDialogs, FileService } from './services/files';
import { RunService, type WorkerLike } from './services/runs';
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
  /** A new optimizer thread (TDD §3); called by the first run, not at startup. */
  spawnWorker(): WorkerLike;
  /** Open one more app window. */
  createWindow(): void;
  /** Send to every open window. */
  broadcast(channel: string, payload: unknown): void;
  /** The system's folder dialog; `null` when it is cancelled. */
  pickDirectory(): Promise<string | null>;
  /** The system's file dialogs, for templates, decks and exports (M2g). */
  dialogs: FileDialogs;
  /** One line per change of the card status and per run event; absent unless debugging. */
  log?: ((line: string) => void) | undefined;
}

function statusLine(status: CardStatus): string {
  const head = `[cards] ${status.state} workdir=${status.workdir}`;
  if (status.state === 'error') return `${head} error=${status.error}`;
  if (status.state !== 'ready') return head;
  return `${head} databases=${status.databases} skipped=${status.skippedDatabases} cards=${status.cards} replacedRows=${status.replacedRows} conflicts=${status.conflicts} setnames=${status.setnames}`;
}

function runLine(event: RunEvent): string {
  const head = `[run] ${event.runId} ${event.type}`;
  switch (event.type) {
    case 'started':
      return `${head} total=${event.total} estimatedMs=${event.estimatedMs}`;
    case 'progress': {
      const { done, total, elapsedMs, etaMs } = event.progress;
      return `${head} ${done}/${total} elapsedMs=${elapsedMs} etaMs=${etaMs}`;
    }
    case 'needs-confirmation': {
      const { reason, total, estimatedMs, thresholdMs } = event.confirmation;
      return `${head} reason=${reason} total=${total} estimatedMs=${estimatedMs} thresholdMs=${thresholdMs}`;
    }
    case 'error':
      return `${head} ${event.message}`;
    default: {
      // `result`, or `cancelled` with what a graceful stop kept.
      if (event.result === null) return `${head} abandoned`;
      const { done, total, best, plateau, elapsedMs } = event.result;
      return `${head} done=${done}/${total} best=${best.blend.num}/${best.blend.den} plateau=${plateau.size} elapsedMs=${elapsedMs}`;
    }
  }
}

export class MainApp {
  readonly settings: SettingsStore;
  readonly cards: CardService;
  readonly templates: TemplateService;
  readonly runs: RunService;
  readonly files: FileService;
  readonly decks: DeckService;

  constructor(private readonly deps: MainAppDeps) {
    this.settings = new SettingsStore(deps.userDataDir);
    // Pushed, never polled (TDD §3): every change goes to every open window.
    this.cards = new CardService(deps.loadCards, (status) => {
      deps.log?.(statusLine(status));
      deps.broadcast(IpcChannels.cardsStatus, status);
    });
    // The analysis estimates at the cost the optimizer worker calibrates (TDD §11.3), once one has.
    this.templates = new TemplateService(this.cards, () => this.runs.cost());
    this.runs = new RunService({
      templates: this.templates,
      spawn: deps.spawnWorker,
      // One run at a time, app-wide: its events go to every window, like the card status.
      emit: (event) => {
        deps.log?.(runLine(event));
        deps.broadcast(IpcEvents.runEvent, event);
      },
      plateauDelta: () => this.settings.get().plateauDelta,
    });
    // The export reads the run service's own copy of the result, not one that
    // has been to the renderer and back (TDD §3).
    this.files = new FileService({
      cards: this.cards,
      dialogs: deps.dialogs,
      runs: { result: (runId) => this.runs.result(runId) },
    });
    this.decks = new DeckService({
      cards: this.cards,
      workdir: () => this.settings.get().workdir,
      pickFile: () =>
        deps.dialogs.openFile({
          title: 'Open a deck',
          filters: [
            { name: 'EDOPro deck', extensions: ['ydk'] },
            { name: 'All files', extensions: ['*'] },
          ],
        }),
    });
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
    const { deps, settings, cards, templates, files, decks, runs } = this;
    registerIpc(deps.ipcMain, {
      appInfo: deps.appInfo,
      settings,
      cards,
      templates,
      files,
      decks,
      runs,
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
