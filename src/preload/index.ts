import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/ipc';
import { IpcChannels } from '../shared/ipc';
import type { CardStatus } from '../shared/types';

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
  analyzeTemplate: (request) => ipcRenderer.invoke(IpcChannels.templateAnalyze, request),
};

contextBridge.exposeInMainWorld('api', api);
