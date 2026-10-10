/**
 * Open 激活协议的跨进程纯数据契约（`docs/M3_EDITOR_CORE_PLAN.md` §13，M3 T1b preflight 用户裁决 2 / 3）。
 *
 * 协议：`open-document` → main 签发 **pending** 候选能力并回复 `opened` → renderer 准备新会话（不提交）→
 * `activate-document` → main 把候选提升为 **active** 并吊销同窗口旧 active → renderer 收到 `{ ok: true }` 后才提交切换。
 * renderer 准备失败时发 `reject-document`。
 *
 * - 只有类型，没有运行时逻辑；不修改 T1a 的 `openContracts.ts`，只在其结果之外增加 `rejected`。
 * - 任何消息都不携带路径；`capabilityId` 是 main 签发的不透明串，renderer 只能原样交回。
 *
 * **跨进程激活不是原子事务**（T1c 恢复合同，fail closed）：
 * - `ActivateDocumentReply` 只表示 main 是否已把该能力设为 active，**不表示 renderer 已提交切换**；main 侧没有
 *   「renderer 已提交」这一状态。
 * - renderer 发出 `activate-document` 后若没有得到明确应答（invoke 抛错、不 settle、超时），结果视为**不确定**：
 *   main 可能已经吊销旧能力。此时 renderer **不得**继续用旧能力执行 Save，也不得提交新会话；可以以同一张票
 *   重发 `activate-document`：重复激活是幂等的——`{ ok: true }` 即确认已 active（可提交），`capability-invalid`
 *   即确认未生效或已失效（丢弃新会话；旧能力也不再被视为可用）。
 * - renderer 在已激活后放弃新会话时发 `reject-document`：main 吊销该能力，**不会**恢复被取代的旧能力。
 */

import type { OpenDocumentResult } from './openContracts';

/** `open-document` 的唯一合法输入：只允许经 main 的原生对话框选择文件。 */
export interface OpenDocumentRequest {
  readonly intent: 'dialog';
}

/**
 * `busy`：该窗口已有一个打开对话框在显示，本次请求被拒绝且不改变任何状态（不占用请求代次）。
 * `superseded`：本次请求在完成前已被同窗口更新的 Open 请求或页面重载取代；结果被丢弃，不签发能力。
 */
export type OpenRejectionReason = 'busy' | 'superseded';

export type OpenDocumentReply = OpenDocumentResult | { readonly kind: 'rejected'; readonly reason: OpenRejectionReason };

/** `activate-document` / `reject-document` 的输入：`capabilityId` 与 `documentId` 都来自同一次 `opened` 回复。 */
export interface DocumentActivationTicket {
  readonly capabilityId: string;
  readonly documentId: number;
}

/** 复用方案 §13.4 的能力错误码：`capability-invalid`（未知 / 已过期 / 已失效 / 跨窗口），`document-mismatch`（documentId 不一致）。 */
export type ActivationErrorCode = 'capability-invalid' | 'document-mismatch';

export type ActivateDocumentReply = { readonly ok: true } | { readonly ok: false; readonly code: ActivationErrorCode };

/** `reject-document` 恒为成功应答（幂等），不透露该能力是否存在。 */
export interface RejectDocumentReply {
  readonly ok: true;
}
