import type {
  ActivateDocumentReply,
  DocumentActivationTicket,
  OpenDocumentReply,
  RejectDocumentReply,
} from './activationContracts';
import type { MenuCommandMessage } from './menuContracts';
import type {
  RequestSaveTargetReply,
  RequestSaveTargetRequest,
  SaveAsDocumentRequest,
  SaveDocumentReply,
  SaveDocumentRequest,
} from './saveContracts';

export const IPC = {
  /** M3 T1b：main 原生对话框打开文档，签发 pending 候选能力（`docs/M3_EDITOR_CORE_PLAN.md` §13.4）。 */
  openDocument: 'muse:open-document',
  /** M3 T1b：renderer 确认接受候选，main 将其设为 active。 */
  activateDocument: 'muse:activate-document',
  /** M3 T1b：renderer 放弃候选或已激活的能力。 */
  rejectDocument: 'muse:reject-document',
  /** M3 T4：Save As 阶段 1——main 原生保存对话框，签发一次性 save-target（`docs/M3_EDITOR_CORE_PLAN.md` §13.4）。 */
  requestSaveTarget: 'muse:request-save-target',
  /** M3 T4：普通 Save（active 能力）或 Save As 阶段 2（save-target）。 */
  saveDocument: 'muse:save-document',
  /** M3 T3b：main → renderer 的菜单 / 快捷键命令（只发给所属窗口；preload 校验后转发）。 */
  menuCommand: 'muse:menu-command',
} as const;

/**
 * preload 暴露给页面的白名单 API。新 Open 协议的方法都不接受路径：文件只能由 main 的原生对话框选择；
 * `activateDocument` / `rejectDocument` 只转发 main 签发的票据，preload 不会主动确认任何候选。
 */
export interface MuseDesktopApi {
  openDocument(): Promise<OpenDocumentReply>;
  activateDocument(ticket: DocumentActivationTicket): Promise<ActivateDocumentReply>;
  rejectDocument(ticket: DocumentActivationTicket): Promise<RejectDocumentReply>;
  /** M3 T4：Save As 阶段 1；写入位置只能由 main 的保存对话框选择。 */
  requestSaveTarget(request: RequestSaveTargetRequest): Promise<RequestSaveTargetReply>;
  /** M3 T4：普通 Save 或 Save As 阶段 2；不接受路径。 */
  saveDocument(request: SaveDocumentRequest | SaveAsDocumentRequest): Promise<SaveDocumentReply>;
  /** M3 T3b：订阅菜单命令；listener 只收到校验通过的 `{ command, source }`，不接触 IPC event。返回注销函数。 */
  onMenuCommand(listener: (message: MenuCommandMessage) => void): () => void;
}
