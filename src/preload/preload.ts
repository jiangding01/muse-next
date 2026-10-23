import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type MuseDesktopApi } from '../shared/ipc';
import { parseMenuCommandMessage } from '../shared/menuContracts';

/**
 * 白名单 API（`docs/M3_EDITOR_CORE_PLAN.md` §13）：每个方法只调用一个固定通道。
 * 新 Open 协议只转发页面给出的票据字段（`capabilityId`、`documentId`），不接受路径、不主动确认；
 * 多余字段不会被转发，main 侧仍按不可信输入完整校验。
 * `onMenuCommand`（M3 T3b）：唯一一处监听 main → renderer 的通道；消息先经白名单校验与归一化，页面只拿到
 * `{ command, source }`，拿不到 IPC event。
 */
const api: MuseDesktopApi = {
  openDocument: () => ipcRenderer.invoke(IPC.openDocument, { intent: 'dialog' }),
  activateDocument: (ticket) =>
    ipcRenderer.invoke(IPC.activateDocument, { capabilityId: ticket.capabilityId, documentId: ticket.documentId }),
  rejectDocument: (ticket) =>
    ipcRenderer.invoke(IPC.rejectDocument, { capabilityId: ticket.capabilityId, documentId: ticket.documentId }),
  onMenuCommand: (listener) => {
    if (typeof listener !== 'function') return () => undefined;
    const handler = (_event: unknown, payload: unknown): void => {
      const message = parseMenuCommandMessage(payload);
      if (message !== null) listener(message);
    };
    ipcRenderer.on(IPC.menuCommand, handler);
    return () => {
      ipcRenderer.removeListener(IPC.menuCommand, handler);
    };
  },
};

contextBridge.exposeInMainWorld('museDesktop', api);
