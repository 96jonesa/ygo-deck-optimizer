import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { type IpcDeps, registerIpc } from '../../src/main/ipc';
import { type CardLoader, CardService } from '../../src/main/services/cards';
import { TemplateService } from '../../src/main/services/templates';
import { SettingsStore } from '../../src/main/store/settings';
import { IpcChannels } from '../../src/shared/ipc';
import type { AppInfo, CardStatus, WorkdirHealth } from '../../src/shared/types';
import { ControllableLoader, immediateLoader, loadedCards } from '../helpers/card-loader';
import { FakeIpcMain } from '../helpers/fake-ipc-main';
import { CODE } from '../helpers/fixture-cards';
import { motivatingTemplate } from '../helpers/motivating';
import { tempDirs } from '../helpers/workdir';

const SQL = await initSqlJs();
const temp = tempDirs('ygo-ipc-');

const APP_INFO: AppInfo = {
  version: '1.2.3',
  electron: '44.0.0',
  node: '22.0.0',
  chrome: '140.0.0',
  packaged: false,
};

function healthOf(dir: string): WorkdirHealth {
  return { ok: true, path: dir, databases: 2, stringsConf: 1, problems: [], notes: [] };
}

/** Real services over a temporary settings folder, behind a fake `ipcMain`. */
function harness(load: CardLoader = immediateLoader(() => loadedCards(SQL))) {
  const ipcMain = new FakeIpcMain();
  const userData = temp.dir();
  const settings = new SettingsStore(userData);
  const pushed: CardStatus[] = [];
  const cards = new CardService(load, (status) => pushed.push(status));
  const probed: string[] = [];
  const picks: (string | null)[] = [];
  const deps: IpcDeps = {
    appInfo: () => APP_INFO,
    settings,
    cards,
    templates: new TemplateService(cards),
    probe: (dir) => {
      probed.push(dir);
      return healthOf(dir);
    },
    pickDirectory: async () => picks.shift() ?? null,
  };
  registerIpc(ipcMain, deps);
  return { ipcMain, userData, settings, cards, pushed, probed, picks, deps };
}

describe('registerIpc', () => {
  it('registers a handler for every invoke channel of the contract, each exactly once', () => {
    const { ipcMain } = harness();
    expect([...ipcMain.registered].sort()).toEqual(Object.values(IpcChannels).sort());
  });

  it('cannot be run twice on one ipcMain — which is why it is run once, at app start', () => {
    const { ipcMain, deps } = harness();
    expect(() => registerIpc(ipcMain, deps)).toThrow('second handler');
  });

  describe('app:info', () => {
    it('returns what the app says of itself', async () => {
      expect(await harness().ipcMain.invoke(IpcChannels.appInfo)).toEqual(APP_INFO);
    });
  });

  describe('settings:get', () => {
    it('returns the stored settings', async () => {
      const { ipcMain, settings } = harness();
      settings.set({ workdir: '/edopro' });
      expect(await ipcMain.invoke(IpcChannels.settingsGet)).toEqual(settings.get());
    });
  });

  describe('settings:set', () => {
    it('persists the patch and returns the settings that result', async () => {
      const { ipcMain, userData } = harness();
      const result = await ipcMain.invoke(IpcChannels.settingsSet, { plateauDelta: 0.01 });
      expect(result).toEqual({
        version: 1,
        workdir: null,
        includePrerelease: true,
        plateauDelta: 0.01,
      });
      expect(new SettingsStore(userData).get()).toEqual(result);
    });

    it('reloads the cards when the workdir changed', async () => {
      const loader = new ControllableLoader();
      const { ipcMain } = harness(loader.load);
      await ipcMain.invoke(IpcChannels.settingsSet, { workdir: '/edopro' });
      expect(loader.calls).toHaveLength(1);
      expect(loader.call(0)).toMatchObject({
        workdir: '/edopro',
        opts: { includePrerelease: true },
      });
    });

    it('reloads the cards when the pre-release setting changed', async () => {
      const loader = new ControllableLoader();
      const { ipcMain, settings, cards } = harness(loader.load);
      settings.set({ workdir: '/edopro' });
      const first = cards.reload('/edopro', { includePrerelease: true });
      loader.call(0).resolve(loadedCards(SQL));
      await first;

      await ipcMain.invoke(IpcChannels.settingsSet, { includePrerelease: false });
      expect(loader.calls).toHaveLength(2);
      expect(loader.call(1)).toMatchObject({
        workdir: '/edopro',
        opts: { includePrerelease: false },
      });
    });

    it('does NOT reload when nothing the cards depend on changed', async () => {
      const loader = new ControllableLoader();
      const { ipcMain, settings, cards, pushed } = harness(loader.load);
      settings.set({ workdir: '/edopro' });
      // In `error`, the card service itself would retry a reload: the handler must not ask.
      const first = cards.reload('/edopro', { includePrerelease: true });
      loader.call(0).reject(new Error('not mounted'));
      await first;
      const before = pushed.length;

      await ipcMain.invoke(IpcChannels.settingsSet, { plateauDelta: 0.02 });
      await ipcMain.invoke(IpcChannels.settingsSet, { workdir: '/edopro' });
      await ipcMain.invoke(IpcChannels.settingsSet, { includePrerelease: true });
      expect(loader.calls).toHaveLength(1);
      expect(pushed).toHaveLength(before);
    });

    it('goes idle when the workdir is cleared', async () => {
      const { ipcMain, cards } = harness();
      await ipcMain.invoke(IpcChannels.settingsSet, { workdir: '/edopro' });
      await ipcMain.invoke(IpcChannels.settingsSet, { workdir: null });
      expect(cards.status().state).toBe('idle');
    });

    it('persists BEFORE it reloads: the load sees the new settings on disk', async () => {
      let onDisk: string | null | undefined;
      let userDataDir = '';
      const { ipcMain, userData } = harness(async () => {
        onDisk = new SettingsStore(userDataDir).get().workdir;
        return loadedCards(SQL);
      });
      userDataDir = userData;
      await ipcMain.invoke(IpcChannels.settingsSet, { workdir: '/edopro' });
      expect(onDisk).toBe('/edopro');
    });

    it('resolves without waiting for the reload: the status follows by push', async () => {
      const loader = new ControllableLoader();
      const { ipcMain, cards } = harness(loader.load);
      await ipcMain.invoke(IpcChannels.settingsSet, { workdir: '/edopro' });
      expect(cards.status().state).toBe('loading');
    });

    it('changes nothing for a patch that is not an object', async () => {
      const { ipcMain, settings } = harness();
      const before = settings.get();
      for (const junk of [null, undefined, 'workdir', 7, [{ workdir: '/x' }]])
        expect(await ipcMain.invoke(IpcChannels.settingsSet, junk)).toEqual(before);
    });
  });

  describe('workdir:probe', () => {
    it('probes the path it is given', async () => {
      const { ipcMain, probed } = harness();
      expect(await ipcMain.invoke(IpcChannels.workdirProbe, '/edopro')).toEqual(
        healthOf('/edopro'),
      );
      expect(probed).toEqual(['/edopro']);
    });

    it('probes the empty path for anything that is not text', async () => {
      const { ipcMain, probed } = harness();
      await ipcMain.invoke(IpcChannels.workdirProbe, { path: '/edopro' });
      await ipcMain.invoke(IpcChannels.workdirProbe);
      expect(probed).toEqual(['', '']);
    });
  });

  describe('dialog:pickDirectory', () => {
    it('returns the folder chosen, or null when the dialog is cancelled', async () => {
      const { ipcMain, picks } = harness();
      picks.push('/chosen');
      expect(await ipcMain.invoke(IpcChannels.pickDirectory)).toBe('/chosen');
      expect(await ipcMain.invoke(IpcChannels.pickDirectory)).toBeNull();
    });
  });

  describe('cards:status', () => {
    it('returns the card service’s status', async () => {
      const { ipcMain, cards } = harness();
      expect(await ipcMain.invoke(IpcChannels.cardsStatus)).toEqual(cards.status());
      await cards.reload('/edopro', { includePrerelease: true });
      expect(await ipcMain.invoke(IpcChannels.cardsStatus)).toMatchObject({
        state: 'ready',
        workdir: '/edopro',
      });
    });
  });

  describe('cards:reindex', () => {
    it('starts a load and resolves at once, with nothing: the status follows by push', async () => {
      const loader = new ControllableLoader();
      const { ipcMain, cards, pushed } = harness(loader.load);
      const first = cards.reload('/edopro', { includePrerelease: true });
      loader.call(0).resolve(loadedCards(SQL));
      await first;

      expect(await ipcMain.invoke(IpcChannels.cardsReindex)).toBeUndefined();
      expect(loader.calls).toHaveLength(2);
      expect(pushed.at(-1)?.state).toBe('loading');
    });
  });

  describe('cards:search', () => {
    it('searches by name, up to the limit', async () => {
      const { ipcMain, cards } = harness();
      await cards.reload('/edopro', { includePrerelease: true });
      expect(
        await ipcMain.invoke(IpcChannels.cardsSearch, { query: 'synthetic', limit: 2 }),
      ).toEqual(cards.search('synthetic', 2));
      expect(await ipcMain.invoke(IpcChannels.cardsSearch, { query: 'synthetic' })).toEqual(
        cards.search('synthetic'),
      );
    });

    it('finds nothing for a malformed request', async () => {
      const { ipcMain, cards } = harness();
      await cards.reload('/edopro', { includePrerelease: true });
      for (const junk of [undefined, null, 'synthetic', { query: 7 }, { limit: 3 }])
        expect(await ipcMain.invoke(IpcChannels.cardsSearch, junk)).toEqual([]);
      expect(
        await ipcMain.invoke(IpcChannels.cardsSearch, { query: 'synthetic', limit: 'all' }),
      ).toEqual(cards.search('synthetic'));
    });
  });

  describe('cards:get', () => {
    it('returns the cards asked for, ignoring anything that is not a passcode', async () => {
      const { ipcMain, cards } = harness();
      await cards.reload('/edopro', { includePrerelease: true });
      expect(
        await ipcMain.invoke(IpcChannels.cardsGet, [CODE.harpy, 'x', null, 1.5, CODE.sea]),
      ).toEqual(cards.get([CODE.harpy, CODE.sea]));
      expect(await ipcMain.invoke(IpcChannels.cardsGet, CODE.harpy)).toEqual([]);
    });
  });

  describe('desc:parse', () => {
    it('echoes the request’s sequence number beside the result', async () => {
      const { ipcMain, cards, deps } = harness();
      await cards.reload('/edopro', { includePrerelease: true });
      const response = await ipcMain.invoke(IpcChannels.descParse, {
        seq: 41,
        payload: { text: 'level 8 monster', groups: [] },
      });
      expect(response).toEqual({
        seq: 41,
        payload: deps.templates.parseDescription('level 8 monster', []),
      });
      expect(response).toMatchObject({ payload: { ok: true, echo: 'Level 8 · Monster' } });
    });

    it('echoes it on every kind of answer: a parse error, not-ready, invalid', async () => {
      const { ipcMain, cards } = harness();
      const request = (seq: number, payload: unknown) =>
        ipcMain.invoke(IpcChannels.descParse, { seq, payload });
      expect(await request(1, { text: 'monster', groups: [] })).toMatchObject({
        seq: 1,
        payload: { reason: 'not-ready' },
      });
      await cards.reload('/edopro', { includePrerelease: true });
      expect(await request(2, { text: 'monstr', groups: [] })).toMatchObject({
        seq: 2,
        payload: { reason: 'parse' },
      });
      expect(await request(3, null)).toMatchObject({ seq: 3, payload: { reason: 'invalid' } });
    });

    it('answers a request with no sequence number under -1, which no request carries', async () => {
      const { ipcMain, cards } = harness();
      await cards.reload('/edopro', { includePrerelease: true });
      expect(await ipcMain.invoke(IpcChannels.descParse, 'monster')).toMatchObject({
        seq: -1,
        payload: { reason: 'invalid' },
      });
    });
  });

  describe('template:analyze', () => {
    it('echoes the request’s sequence number beside the Analysis', async () => {
      const { ipcMain, cards, deps } = harness();
      await cards.reload('/edopro', { includePrerelease: true });
      const template = motivatingTemplate();
      const response = await ipcMain.invoke(IpcChannels.templateAnalyze, {
        seq: 7,
        payload: template,
      });
      expect(response).toEqual({ seq: 7, payload: deps.templates.analyzeTemplate(template) });
      expect(response).toMatchObject({ payload: { ok: true } });
    });

    it('answers a broken template with `invalid`, under its sequence number', async () => {
      const { ipcMain, cards } = harness();
      await cards.reload('/edopro', { includePrerelease: true });
      expect(
        await ipcMain.invoke(IpcChannels.templateAnalyze, { seq: 8, payload: { version: 1 } }),
      ).toMatchObject({ seq: 8, payload: { ok: false, reason: 'invalid' } });
    });

    it('answers not-ready under its sequence number while the cards load', async () => {
      const { ipcMain } = harness(new ControllableLoader().load);
      await ipcMain.invoke(IpcChannels.settingsSet, { workdir: '/edopro' });
      expect(
        await ipcMain.invoke(IpcChannels.templateAnalyze, {
          seq: 9,
          payload: motivatingTemplate(),
        }),
      ).toMatchObject({ seq: 9, payload: { reason: 'not-ready', state: 'loading' } });
    });
  });
});
