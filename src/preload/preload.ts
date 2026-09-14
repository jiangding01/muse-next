import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type MuseDesktopApi, type OpenedScoreFile } from '../shared/ipc';

const api: MuseDesktopApi = {
  openScore: () => ipcRenderer.invoke(IPC.openScore) as Promise<OpenedScoreFile>,
};

contextBridge.exposeInMainWorld('museDesktop', api);
