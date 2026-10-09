/**
 * 跨进程的文档纯数据契约（`docs/M3_EDITOR_CORE_PLAN.md` §7.1、§13，T0 最小集合）。
 *
 * 只放 T0 会话合同直接引用的类型。DecodedDocument、DecodeFailure、错误码、SaveResult、守卫请求等
 * 在 T1 / T4 / T5 对应通道落地时再定义。本文件不含任何运行时逻辑；`src/editor/**` 只能 `import type` 本目录。
 */

/** 原始文件字节是否以 UTF-8 BOM（EF BB BF）开头；只来自 main 对实际字节的检测（§6.3）。 */
export type ByteBom = 'utf8' | 'none';

/** 打开时 main 判定的字节往返安全性（§11.4）。 */
export type EncodingRoundTrip = 'exact' | 'unsafe';

/**
 * main 发放的文件能力令牌（§13.1）。
 *
 * 这只是在类型层表达「不透明、只能原样交回 main」的意图，**不是**安全边界：renderer 完全可以构造出同样形状的值。
 * 真正的授权保证始终是 main 的能力表校验令牌。
 */
export interface FileCapability {
  readonly id: string;
}

/**
 * 会话中的文件引用（§7.1）。`displayName` / `displayPath` 只用于展示，永远不能作为读写参数提交给 main（§13）。
 */
export interface FileReference {
  readonly capability: FileCapability;
  readonly displayName: string;
  readonly displayPath: string;
}
