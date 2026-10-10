import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type MuseDesktopApi, type OpenedScoreFile } from '../shared/ipc';

/**
 * 白名单 API（`docs/M3_EDITOR_CORE_PLAN.md` §13）：每个方法只调用一个固定通道。
 * 新 Open 协议只转发页面给出的票据字段（`capabilityId`、`documentId`），不接受路径、不主动确认；
 * 多余字段不会被转发，main 侧仍按不可信输入完整校验。
 */
const api: MuseDesktopApi = {
  openScore: () => ipcRenderer.invoke(IPC.openScore) as Promise<OpenedScoreFile>,
  openDocument: () => ipcRenderer.invoke(IPC.openDocument, { intent: 'dialog' }),
  activateDocument: (ticket) =>
    ipcRenderer.invoke(IPC.activateDocument, { capabilityId: ticket.capabilityId, documentId: ticket.documentId }),
  rejectDocument: (ticket) =>
    ipcRenderer.invoke(IPC.rejectDocument, { capabilityId: ticket.capabilityId, documentId: ticket.documentId }),
};

contextBridge.exposeInMainWorld('museDesktop', api);
