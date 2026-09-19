import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { MainApp, type MainAppDeps } from '../../src/main/app';
import { installLoader } from '../../src/main/services/cards';
import { SettingsStore } from '../../src/main/store/settings';
import { IpcChannels, IpcEvents } from '../../src/shared/ipc';
import type { CardStatus, RunEvent } from '../../src/shared/types';
import { ControllableLoader, loadedCards } from '../helpers/card-loader';
import { SETNAMES, STRINGS_CONF } from '../helpers/desc-context';
import { FakeIpcMain } from '../helpers/fake-ipc-main';
import { FAKE_COST, FakeWorkers } from '../helpers/fake-worker';
import { buildCdb, FIXTURE_ROWS, POPULATION } from '../helpers/fixture-cards';
import { motivatingCdb, motivatingTemplate } from '../helpers/motivating';
import { tempDirs } from '../helpers/workdir';

const SQL = await initSqlJs();
const temp = tempDirs('ygo-app-');

function install(): string {
  return temp.workdir({
    'cards.cdb': buildCdb(SQL, FIXTURE_ROWS),
    'config/strings.conf': STRINGS_CONF,
  });
}

/** An install that also holds the cards the motivating example names, so that it can be run. */
function runnableInstall(): string {
  return temp.workdir({
    'cards.cdb': motivatingCdb(SQL),
    'config/strings.conf': STRINGS_CONF,
  });
}

/** A `MainApp` over a fake `ipcMain`, recording its windows, its pushes and its log. */
function harness(overrides: Partial<MainAppDeps> = {}) {
  const ipcMain = new FakeIpcMain();
  const userDataDir = temp.dir();
  const sent: { channel: string; payload: unknown }[] = [];
  const log: string[] = [];
  const workers = new FakeWorkers();
  let windows = 0;
  const app = new MainApp({
    ipcMain,
    userDataDir,
    candidates: [],
    appInfo: () => ({ version: '0', electron: '0', node: '0', chrome: '0', packaged: false }),
    loadCards: installLoader(async () => SQL),
    spawnWorker: workers.spawn,
    createWindow: () => {
      windows++;
    },
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    pickDirectory: async () => null,
    log: (line) => log.push(line),
    ...overrides,
  });
  const on = (channel: string) =>
    sent.filter((message) => message.channel === channel).map((message) => message.payload);
  const statuses = () => on(IpcChannels.cardsStatus) as CardStatus[];
  const runEvents = () => on(IpcEvents.runEvent) as RunEvent[];
  return {
    app,
    ipcMain,
    userDataDir,
    sent,
    statuses,
    runEvents,
    workers,
    log,
    windows: () => windows,
  };
}

describe('MainApp', () => {
  describe('IPC registration', () => {
    it('happens once, at start — opening a second and a third window registers nothing', async () => {
      const { app, ipcMain, windows } = harness();
      await app.start();
      const registered = [...ipcMain.registered];
      expect([...registered].sort()).toEqual(Object.values(IpcChannels).sort());

      // The fake throws on a second handler for a channel, as Electron does.
      expect(() => {
        app.openWindow();
        app.openWindow();
      }).not.toThrow();
      expect(windows()).toBe(3);
      expect(ipcMain.registered).toEqual(registered);
    });

    it('is in place before the first window opens, so the renderer’s first invoke is answered', async () => {
      const ipcMain = new FakeIpcMain();
      let registeredAtOpen = -1;
      const { app } = harness({
        ipcMain,
        createWindow: () => {
          registeredAtOpen = ipcMain.registered.length;
        },
      });
      await app.start();
      expect(registeredAtOpen).toBe(Object.values(IpcChannels).length);
    });
  });

  describe('first run', () => {
    it('auto-detects the install among the candidates, saves it, and loads it', async () => {
      const found = install();
      const { app, userDataDir, statuses } = harness({ candidates: [temp.dir(), found] });
      await app.start();
      expect(new SettingsStore(userDataDir).get().workdir).toBe(found);
      expect(statuses().map((status) => status.state)).toEqual(['loading', 'ready']);
      expect(app.cards.status()).toMatchObject({
        state: 'ready',
        workdir: found,
        cards: POPULATION.length,
      });
    });

    it('stays idle, saving nothing and loading nothing, when no candidate is an install', async () => {
      const loader = new ControllableLoader();
      const { app, userDataDir, sent } = harness({
        candidates: [temp.dir(), '/no/such/folder'],
        loadCards: loader.load,
      });
      await app.start();
      expect(app.cards.status().state).toBe('idle');
      expect(new SettingsStore(userDataDir).get().workdir).toBeNull();
      expect(loader.calls).toEqual([]);
      expect(sent).toEqual([]);
    });
  });

  describe('a later run', () => {
    it('loads the stored workdir under the stored options, and detects nothing', async () => {
      const loader = new ControllableLoader();
      const { app, userDataDir } = harness({ candidates: [install()], loadCards: loader.load });
      new SettingsStore(userDataDir).set({ workdir: '/stored', includePrerelease: false });
      const started = app.start();
      expect(loader.calls).toHaveLength(1);
      expect(loader.call(0)).toMatchObject({
        workdir: '/stored',
        opts: { includePrerelease: false },
      });
      loader.call(0).resolve(loadedCards(SQL));
      await started;
      expect(app.cards.status()).toMatchObject({ state: 'ready', workdir: '/stored' });
    });

    it('reports a stored workdir that is gone as an error, rather than quietly use another', async () => {
      const gone = temp.dir();
      const { app, userDataDir } = harness({ candidates: [install()] });
      new SettingsStore(userDataDir).set({ workdir: gone });
      await app.start();
      expect(app.cards.status()).toMatchObject({ state: 'error', workdir: gone });
      expect(new SettingsStore(userDataDir).get().workdir).toBe(gone);
    });
  });

  describe('status pushes', () => {
    it('broadcasts every change on cards:status, and nothing else', async () => {
      const { app, sent } = harness({ candidates: [install()] });
      await app.start();
      await app.cards.reindex();
      expect(sent.map((message) => message.channel)).toEqual(
        Array(4).fill(IpcChannels.cardsStatus),
      );
      expect(sent.at(-1)?.payload).toEqual(app.cards.status());
    });

    it('follow a settings:set from the renderer: pick a folder, and the index is pushed ready', async () => {
      const found = install();
      const { app, ipcMain, statuses } = harness();
      await app.start();
      expect(await ipcMain.invoke(IpcChannels.cardsStatus)).toMatchObject({ state: 'idle' });

      await ipcMain.invoke(IpcChannels.settingsSet, { workdir: found });
      await app.cards.reload(found, { includePrerelease: true }); // joins the load under way
      expect(statuses().map((status) => status.state)).toEqual(['loading', 'ready']);
      expect(await ipcMain.invoke(IpcChannels.cardsSearch, { query: 'synthetic harpy' })).toEqual([
        {
          passcode: 90000150,
          name: 'Synthetic Harpy',
          typeline: 'Level 4 · WIND · Winged Beast · Normal Monster',
        },
      ]);
    });

    it('are logged, one line each, when a log is given — and need none', async () => {
      const found = install();
      const { app, log } = harness({ candidates: [found] });
      await app.start();
      expect(log).toEqual([
        `[cards] loading workdir=${found}`,
        `[cards] ready workdir=${found} databases=1 skipped=0 cards=${POPULATION.length} replacedRows=0 conflicts=0 setnames=${SETNAMES.size}`,
      ]);

      const quiet = harness({ candidates: [found], log: undefined });
      await expect(quiet.app.start()).resolves.toBeUndefined();
    });

    it('log the reason for an error', async () => {
      const loader = new ControllableLoader();
      const { app, userDataDir, log } = harness({ loadCards: loader.load });
      new SettingsStore(userDataDir).set({ workdir: '/stored' });
      const started = app.start();
      loader.call(0).reject(new Error('disk on fire'));
      await started;
      expect(log.at(-1)).toBe('[cards] error workdir=/stored error=disk on fire');
    });
  });

  describe('start', () => {
    it('opens the first window without waiting for the cards to load', async () => {
      const loader = new ControllableLoader();
      const { app, userDataDir, windows } = harness({ loadCards: loader.load });
      new SettingsStore(userDataDir).set({ workdir: '/stored' });
      const started = app.start();
      expect(windows()).toBe(1);
      expect(app.cards.status().state).toBe('loading');
      loader.call(0).resolve(loadedCards(SQL));
      await started;
    });
  });

  describe('runs', () => {
    async function started(overrides: Partial<MainAppDeps> = {}) {
      const made = harness({ candidates: [runnableInstall()], ...overrides });
      await made.app.start();
      const start = async (options?: unknown) => {
        const result = await made.ipcMain.invoke(IpcChannels.runStart, {
          template: motivatingTemplate(),
          options,
        });
        return (result as { runId: number }).runId;
      };
      return { ...made, start };
    }

    it('spawn no worker at startup: the first run does', async () => {
      const { workers, start } = await started();
      expect(workers.spawned).toHaveLength(0);
      await start();
      expect(workers.spawned).toHaveLength(1);
    });

    it('are broadcast, event by event, on run:event', async () => {
      const { workers, runEvents, start } = await started();
      const runId = await start();
      workers.worker(0).answer(0);
      expect(runEvents().map((event) => `${event.runId}:${event.type}`)).toEqual([
        `${runId}:started`,
        `${runId}:progress`,
        `${runId}:result`,
      ]);
      expect(runEvents().at(-1)).toMatchObject({
        result: { best: { blend: { num: 46_185, den: 658_008 } } },
      });
    });

    it('are logged, one line an event, when a log is given', async () => {
      const { workers, log, start, ipcMain } = await started();
      const first = await start({ confirmThresholdMs: 0 });
      workers.worker(0).answer(0);
      await ipcMain.invoke(IpcChannels.runConfirm, first);
      workers.worker(0).answer(1);
      const second = await start();
      await ipcMain.invoke(IpcChannels.runCancel, { runId: second });
      const third = await start();
      workers.worker(1).crash(new Error('boom'));

      const lines = log.filter((line) => line.startsWith('[run]'));
      expect(lines.map((line) => line.replace(/Ms=[0-9.]+/g, 'Ms=N'))).toEqual([
        `[run] ${first} started total=128 estimatedMs=N`,
        `[run] ${first} needs-confirmation reason=estimate total=128 estimatedMs=N thresholdMs=N`,
        `[run] ${first} progress 128/128 elapsedMs=N etaMs=N`,
        `[run] ${first} result done=128/128 best=46185/658008 plateau=3 elapsedMs=N`,
        `[run] ${second} started total=128 estimatedMs=N`,
        `[run] ${second} cancelled abandoned`,
        `[run] ${third} started total=128 estimatedMs=N`,
        `[run] ${third} error boom`,
      ]);
    });

    it('log what a graceful stop kept', async () => {
      const { workers, log, start, ipcMain } = await started();
      const runId = await start();
      const cancelling = ipcMain.invoke(IpcChannels.runCancel, { runId, graceful: true });
      const whole = workers.worker(0).request(0);
      workers.worker(0).answer(0);
      await cancelling;
      // The search of 128 vectors was over before it looked at the flag: a plain result.
      expect(whole.runId).toBe(runId);
      expect(log.at(-1)).toMatch(/^\[run\] \d+ result done=128\/128 /);
    });

    it('need no log', async () => {
      const { workers, runEvents, start } = await started({ log: undefined });
      await start();
      workers.worker(0).answer(0);
      expect(runEvents().at(-1)?.type).toBe('result');
    });

    it('take the plateau’s width from the settings', async () => {
      const { app, workers, start } = await started();
      app.settings.set({ plateauDelta: 0.02 });
      await start();
      expect(workers.worker(0).request(0).options.plateauDelta).toEqual({ num: 1, den: 50 });
    });

    it('calibrate the analysis: once a worker is ready, a template is estimated at its cost', async () => {
      const { ipcMain, workers, start } = await started();
      const costOf = async () => {
        const response = (await ipcMain.invoke(IpcChannels.templateAnalyze, {
          seq: 1,
          payload: motivatingTemplate(),
        })) as { payload: { analysis: { work: { cost: unknown } } } };
        return response.payload.analysis.work.cost;
      };
      expect(await costOf()).not.toEqual(FAKE_COST);
      await start();
      workers.worker(0).ready();
      expect(await costOf()).toEqual(FAKE_COST);
    });
  });
});
