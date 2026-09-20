import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
  session,
  shell,
} from 'electron';
import initSqlJs from 'sql.js';
import { MainApp } from './app';
import { contentSecurityPolicy } from './csp';
import { candidateWorkdirs } from './edopro/probe';
import { installLoader } from './services/cards';
import type { FileDialogs } from './services/files';
import { spawnOptimizerWorker } from './worker-spawn';

// The Electron adapter: everything else in src/main takes what it needs by
// injection (TDD §3) and is tested without Electron; this file only wires.

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

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(channel, payload);
}

async function showOpen(options: OpenDialogOptions): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow();
  const result = await (parent === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(parent, options));
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function pickDirectory(): Promise<string | null> {
  return showOpen({ title: 'Choose your EDOPro folder', properties: ['openDirectory'] });
}

/** The two file dialogs the template and export services take by injection (TDD §3). */
const dialogs: FileDialogs = {
  openFile: ({ title, filters, defaultPath }) =>
    showOpen({ title, filters, properties: ['openFile'], ...(defaultPath ? { defaultPath } : {}) }),
  saveFile: async ({ title, filters, defaultPath }) => {
    const options: SaveDialogOptions = {
      title,
      filters,
      ...(defaultPath ? { defaultPath } : {}),
    };
    const parent = BrowserWindow.getFocusedWindow();
    const result = await (parent === null
      ? dialog.showSaveDialog(options)
      : dialog.showSaveDialog(parent, options));
    return result.canceled ? null : (result.filePath ?? null);
  },
};

const main = new MainApp({
  ipcMain,
  userDataDir: app.getPath('userData'),
  candidates: candidateWorkdirs(process.platform, app.getPath('home')),
  appInfo: () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    chrome: process.versions.chrome ?? '',
    packaged: app.isPackaged,
  }),
  // sql.js stays unbundled in main (TDD §2), so a bare `initSqlJs()` finds its wasm.
  loadCards: installLoader(() => initSqlJs()),
  spawnWorker: spawnOptimizerWorker,
  createWindow,
  broadcast,
  pickDirectory,
  dialogs,
  // `YGO_DEBUG=1`: one stderr line per change of the card status and per run event.
  log: process.env.YGO_DEBUG ? (line) => process.stderr.write(`${line}\n`) : undefined,
});

void app.whenReady().then(() => {
  applyContentSecurityPolicy();
  // IPC handlers are registered in here — once — never per window.
  void main.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) main.openWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
