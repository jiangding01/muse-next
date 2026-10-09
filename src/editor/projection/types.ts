/**
 * SourceProjection 的数据合同（`docs/M3_EDITOR_CORE_PLAN.md` §6）。
 *
 * Editor View normalization ≠ Source normalization：exact source 保留全部原字符；editor view 只是它的投影——
 * 受保护的开头 U+FEFF 不直接展示，CRLF 与 LF 都呈现为一个 LF，孤立 CR 呈现为可见占位符 U+240D。
 */

/** 孤立 CR 在 editor view 中的可见占位符（§6.1）。 */
export const CR_PLACEHOLDER = '\u240D';

export type LineEnding = 'lf' | 'crlf';

/** 会话内冻结的投影参数：打开 / 新建时确定，此后每个版本沿用。 */
export interface ProjectionFrame {
  /** Exact Source 是否以 U+FEFF 开头（文本事实，不是字节 BOM，§6.3）。 */
  readonly protectedLeadingFeff: boolean;
  /** 新插入换行使用的序列；只用于新换行，不重写已有换行（§6.4）。 */
  readonly dominantEol: LineEnding;
}

export interface SourceProjection {
  readonly source: string;
  readonly view: string;
  readonly frame: ProjectionFrame;
  /** `protectedLeadingFeff ? 1 : 0`。 */
  readonly protectedPrefixLength: 0 | 1;
  /** 每个 CRLF 的 CR 在 source 中的偏移，升序。view 中对应一个 LF。 */
  readonly crlfSourceStarts: readonly number[];
  /** 每个孤立 CR 在 source 中的偏移，升序（占位符位置表，§6.2）。 */
  readonly loneCrSourceOffsets: readonly number[];
}
