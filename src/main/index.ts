import path from 'node:path';
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import type { AppInfo } from '../shared/ipc';
import { IpcChannels } from '../shared/ipc';
import { contentSecurityPolicy } from './csp';

/** Registered once at startup, never per window: a second window must not re-register handlers. */
function registerIpc(): void {
  ipcMain.handle(
    IpcChannels.appInfo,
    (): AppInfo => ({
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node,
      chrome: process.versions.chrome ?? '',
      packaged: app.isPackaged,
    }),
  );
}

function applyContentSecurityPolicy(): void {
  const policy = contentSecurityPolicy(app.isPackaged);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
    });
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1150,
    height: 780,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links open in the browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  applyContentSecurityPolicy();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
