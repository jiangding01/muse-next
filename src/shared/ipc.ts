import type {
  ActivateDocumentReply,
  DocumentActivationTicket,
  OpenDocumentReply,
  RejectDocumentReply,
} from './activationContracts';

export const IPC = {
  /** 旧 Open 通道（M3 前的过渡实现）：T1c 切换 UI 时与旧 decoder、旧 renderer Open 路径一并删除。 */
  openScore: 'muse:open-score',
  /** M3 T1b：main 原生对话框打开文档，签发 pending 候选能力（`docs/M3_EDITOR_CORE_PLAN.md` §13.4）。 */
  openDocument: 'muse:open-document',
  /** M3 T1b：renderer 确认接受候选，main 将其设为 active。 */
  activateDocument: 'muse:activate-document',
  /** M3 T1b：renderer 放弃候选或已激活的能力。 */
  rejectDocument: 'muse:reject-document',
} as const;

/** 旧 Open 通道的结果（T1c 删除）。 */
export interface OpenedScoreFile {
  canceled: boolean;
  path?: string;
  content?: string;
  encoding?: 'utf8' | 'gb18030';
}

/**
 * preload 暴露给页面的白名单 API。新 Open 协议的方法都不接受路径：文件只能由 main 的原生对话框选择；
 * `activateDocument` / `rejectDocument` 只转发 main 签发的票据，preload 不会主动确认任何候选。
 */
export interface MuseDesktopApi {
  /** 旧通道（T1c 删除）。 */
  openScore(): Promise<OpenedScoreFile>;
  openDocument(): Promise<OpenDocumentReply>;
  activateDocument(ticket: DocumentActivationTicket): Promise<ActivateDocumentReply>;
  rejectDocument(ticket: DocumentActivationTicket): Promise<RejectDocumentReply>;
}
