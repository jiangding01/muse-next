import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import iconv from 'iconv-lite';
import { createNodeReadOnlyFileSystem } from './document/fileSystemPort';
import { resolvePageEntry } from './ipc/pageIdentity';
import { registerOpenIpc } from './ipc/registerOpenIpc';
import { createOpenPathChooser, wireOpenIpcWindow } from './ipc/wireOpenIpcWindow';
import { matchesPageIdentity } from './open/ipcValidation';
import { IPC, type OpenedScoreFile } from '../shared/ipc';

/** 应用页面的加载地址与可信页面身份：只由 main 配置构造（M3 T1b-2a）。 */
const pageEntry = resolvePageEntry({
  devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
  indexFilePath: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
  platform: process.platform,
});

/** M3 Open 协议（新 IPC，产品 UI 在 T1c 切换前仍走旧通道）。进程内只注册一次。 */
const openIpc = registerOpenIpc({
  ipc: ipcMain,
  windowForSender: (sender) => BrowserWindow.fromWebContents(sender),
  pageIdentity: pageEntry.identity,
  chooseOpenPath: createOpenPathChooser((parent: BrowserWindow, options) => dialog.showOpenDialog(parent, options)),
  fs: createNodeReadOnlyFileSystem(),
  platform: process.platform,
  now: () => performance.now(),
  issueToken: () => randomUUID(),
  schedule: (delayMs, task) => {
    setTimeout(task, delayMs).unref();
  },
});

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

  // Open 协议的窗口事件接线与真实窗口 smoke 共用同一份实现（M3 T1b-2a′）。
  wireOpenIpcWindow(openIpc, mainWindow);
  const contents = mainWindow.webContents;
  // 诊断：实际页面地址是否与配置的可信身份一致。只记录，不改变任何信任判断。
  contents.on('did-finish-load', () => {
    if (!matchesPageIdentity(contents.getURL(), pageEntry.identity)) {
      console.warn('[muse] loaded page does not match the configured page identity; Open requests will be rejected');
    }
  });

  void mainWindow.loadURL(pageEntry.loadUrl);
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
