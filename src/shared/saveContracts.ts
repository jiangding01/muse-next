/**
 * 保存的跨进程纯数据契约（`docs/M3_EDITOR_CORE_PLAN.md` §12、§13.4，M3 T4 B1；Gate A R15）。
 *
 * - 只有类型，没有运行时逻辑；类型依赖只来自 shared 与 parse façade（shared 架构守卫）。
 * - B1 只定义错误码与结果三态；通道常量、请求 / 应答载荷在 B2 的 IPC 落地时再定义。
 * - `message` 由 main 固定生成，不透传原始 fs 错误文本或路径（§13.4）。
 */

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
