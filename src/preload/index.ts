import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/ipc';
import { IpcChannels, IpcEvents } from '../shared/ipc';
import type { CardStatus, RunEvent } from '../shared/types';

const api: RendererApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.appInfo),
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IpcChannels.settingsSet, patch),
  probeWorkdir: (dir) => ipcRenderer.invoke(IpcChannels.workdirProbe, dir),
  pickDirectory: () => ipcRenderer.invoke(IpcChannels.pickDirectory),
  getCardStatus: () => ipcRenderer.invoke(IpcChannels.cardsStatus),
  onCardStatus: (listener) => {
    // The renderer is handed the payload only, never the event (and its `sender`).
    const forward = (_event: IpcRendererEvent, status: CardStatus) => listener(status);
    ipcRenderer.on(IpcChannels.cardsStatus, forward);
    return () => {
      ipcRenderer.removeListener(IpcChannels.cardsStatus, forward);
    };
  },
  reindexCards: () => ipcRenderer.invoke(IpcChannels.cardsReindex),
  searchCards: (query, limit) => ipcRenderer.invoke(IpcChannels.cardsSearch, { query, limit }),
  getCards: (passcodes) => ipcRenderer.invoke(IpcChannels.cardsGet, passcodes),
  parseDescription: (request) => ipcRenderer.invoke(IpcChannels.descParse, request),
  completeName: (request) => ipcRenderer.invoke(IpcChannels.descComplete, request),
  analyzeTemplate: (request) => ipcRenderer.invoke(IpcChannels.templateAnalyze, request),
  openTemplate: () => ipcRenderer.invoke(IpcChannels.templateOpen),
  saveTemplate: (template) => ipcRenderer.invoke(IpcChannels.templateSave, template),
  listDecks: () => ipcRenderer.invoke(IpcChannels.deckList),
  importDeck: (request) => ipcRenderer.invoke(IpcChannels.deckImport, request ?? {}),
  exportResults: (request) => ipcRenderer.invoke(IpcChannels.resultsExport, request),
  startRun: (request) => ipcRenderer.invoke(IpcChannels.runStart, request),
  cancelRun: (runId, opts) =>
    ipcRenderer.invoke(IpcChannels.runCancel, { runId, graceful: opts?.graceful === true }),
  confirmRun: (runId) => ipcRenderer.invoke(IpcChannels.runConfirm, runId),
  onRunEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, event: RunEvent) => listener(event);
    ipcRenderer.on(IpcEvents.runEvent, forward);
    return () => {
      ipcRenderer.removeListener(IpcEvents.runEvent, forward);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
