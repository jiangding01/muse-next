/**
 * 保存的跨进程纯数据契约（`docs/M3_EDITOR_CORE_PLAN.md` §12、§13.4，M3 T4 B1；Gate A R15）。
 *
 * - 只有类型，没有运行时逻辑；类型依赖只来自 shared 与 parse façade（shared 架构守卫）。
 * - B1 定义错误码与结果三态；B2 定义两条通道（`muse:request-save-target` / `muse:save-document`）的请求与应答。
 * - `message` 由 main 固定生成，不透传原始 fs 错误文本或路径（§13.4）。
 * - 任何请求都不携带路径：Save 的写入位置只能是 main 已授权的能力；Save As 的写入位置只能是 main 对话框中用户的选择
 *   （阶段 1 授予的一次性 save-target）。`sourceCapabilityId`（R19）只供 main 做等值核对，不授予任何权限。
 */

import type { JcxEncoding } from '../formats/jcxParse';
import type { DocumentActivationTicket } from './activationContracts';
import type { ByteBom, EncodingRoundTrip } from './documentContracts';

/**
 * 保存失败的分类（R15 终表）：§13.4 原有的能力类 4 个与保存类 9 个、复用 Open 类 2 个、T4 新增 5 个。
 */
export type SaveErrorCode =
  // §13.4 能力与请求
  | 'capability-invalid'
  | 'document-mismatch'
  | 'encoding-mismatch'
  | 'request-timeout'
  // §13.4 保存
  | 'unsafe-overwrite-refused'
  | 'encoding-verification-failed'
  | 'unencodable-character'
  | 'file-modified-on-disk'
  | 'permission-denied'
  | 'disk-full'
  | 'not-found'
  | 'target-busy'
  | 'same-file-encoding-change-refused'
  // 复用 Open 类
  | 'file-too-large'
  | 'not-a-regular-file'
  // T4 新增
  | 'busy'
  | 'identity-unknown'
  | 'write-failed'
  | 'atomic-create-unsupported'
  | 'source-mismatch';

export interface SaveError {
  readonly code: SaveErrorCode;
  readonly message: string;
}

/**
 * 保存结果三态（r1 ERRATA §5.1）。提交点 = `rename`（已存在目标）或 `link`（初始不存在目标）成功返回。
 *
 * - `not-committed`：目标零改动；
 * - `committed-unconfirmed`：目标已写入本次字节，但提交后的复核（窗口代次 / 记录）未通过；
 * - `saved`：已提交且提交后复核通过。
 */
export type SaveCommitOutcome = 'not-committed' | 'committed-unconfirmed' | 'saved';

/** `request-save-target`（Save As 阶段 1）的输入：键集合恰为这三个（r1.2 ERRATA §3）。 */
export interface RequestSaveTargetRequest {
  /** 对话框的建议文件名；main 只取其 basename 并清洗（Q-B2-9）。 */
  readonly suggestedName: string;
  readonly encoding: JcxEncoding;
  /** renderer 会话当前持有的文件能力 token（demo 为 null）；main 要求它等于已提交锚点（R19）。 */
  readonly sourceCapabilityId: string | null;
}

/**
 * 阶段 1 的应答（Q-B2-2）：
 * - `granted`：一次性 save-target；`sameAsCurrent` 只有在目标与锚点文件确定为同一文件时为 true（阶段 2 会重新判定）；
 * - `canceled`：用户取消，不登记任何能力；
 * - `refused`：`busy` / `source-mismatch` / `identity-unknown` / `not-a-regular-file` / `not-found` / `capability-invalid`。
 */
export type RequestSaveTargetReply =
  | {
      readonly kind: 'granted';
      readonly capabilityId: string;
      readonly displayName: string;
      readonly displayPath: string;
      readonly sameAsCurrent: boolean;
    }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'refused'; readonly error: SaveError };

/** `save-document` 普通 Save 分支：`capabilityId` 是当前文件的 active 能力；键集合恰为这四个。 */
export interface SaveDocumentRequest {
  readonly capabilityId: string;
  readonly documentId: number;
  readonly source: string;
  readonly encoding: JcxEncoding;
}

/** `save-document` Save As 分支（阶段 2）：`capabilityId` 是阶段 1 授予的 save-target；另加 R19 字段。 */
export interface SaveAsDocumentRequest extends SaveDocumentRequest {
  readonly sourceCapabilityId: string | null;
}

/**
 * `save-document` 的应答（Q-B2-6）。三态只取决于是否越过提交点（`rename` / `link` 成功返回）与提交后的复核：
 * - `saved` / `committed-unconfirmed`：目标已写入本次字节；`ticket` 只在 Save As 且 `saved` 时非 null——renderer 必须
 *   以它经 `activate-document` 激活新能力，之后才能提交会话切换；
 * - `not-committed`：目标零改动。
 */
export type SaveDocumentReply =
  | {
      readonly outcome: Exclude<SaveCommitOutcome, 'not-committed'>;
      readonly writeEncoding: JcxEncoding;
      readonly byteBom: ByteBom;
      readonly encodingRoundTrip: EncodingRoundTrip;
      readonly displayName: string;
      readonly displayPath: string;
      readonly ticket: DocumentActivationTicket | null;
    }
  | { readonly outcome: Extract<SaveCommitOutcome, 'not-committed'>; readonly error: SaveError };
