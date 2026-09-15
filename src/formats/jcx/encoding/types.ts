/**
 * JCX 编码检测结果类型（M1.4 T2，§4 Encoding）。
 */

export type JcxEncoding = 'utf-8' | 'gb18030';

export interface DecodedJcx {
  /**
   * 解码后的文本。**不剥离 BOM**——若源文件带 BOM，`text` 首字符
   * 仍是 U+FEFF，写回（preserve 模式）时需要原样保留（§27.2）。
   */
  readonly text: string;

  /** 检测到的编码（§4.3）。 */
  readonly encoding: JcxEncoding;

  /** 源文件是否带 BOM（目前仅 UTF-8 BOM 可能为 true，§4.3/§5.5）。 */
  readonly hasBom: boolean;
}
