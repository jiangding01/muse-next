import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import iconv from 'iconv-lite';
import { IPC, type OpenedScoreFile } from '../shared/ipc';

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: 'Muse Next',
    backgroundColor: '#f4f1e9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

ipcMain.handle(IPC.openScore, async (): Promise<OpenedScoreFile> => {
  const result = await dialog.showOpenDialog({
    title: 'Open Muse Score',
    properties: ['openFile'],
    filters: [
      { name: 'Muse score', extensions: ['jcx'] },
      { name: 'Text files', extensions: ['txt', 'abc', 'tab'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });

  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) return { canceled: true };

  const bytes = await fs.readFile(filePath);
  const decoded = decodeLegacyText(bytes);
  return {
    canceled: false,
    path: filePath,
    content: decoded.content,
    encoding: decoded.encoding,
  };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function decodeLegacyText(bytes: Buffer): {
  content: string;
  encoding: 'utf8' | 'gb18030';
} {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { content: decoder.decode(bytes), encoding: 'utf8' };
  } catch {
    return { content: iconv.decode(bytes, 'gb18030'), encoding: 'gb18030' };
  }
}
