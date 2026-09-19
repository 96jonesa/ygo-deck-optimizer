import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/ipc';
import { IpcChannels } from '../shared/ipc';

const api: RendererApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.appInfo),
};

contextBridge.exposeInMainWorld('api', api);
