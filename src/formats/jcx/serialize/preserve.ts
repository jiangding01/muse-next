/**
 * JCX preserve 序列化（M1.7 T2，方案 v1.1 §1/§5）。
 *
 * `serializePreserve` 是 `printAst` 的薄封装：AST 自身已携带 `encoding` /
 * `hasBom` / `hasTrailingNewline`（M1.5 T1），`printAst` 只读每个节点的
 * `raw` / `children` / `eol` 原样拼接原文，因此 preserve 模式不需要重新
 * 扫描、不做任何归一化——`bytes → loadJcx → serializePreserve` 与原字节
 * 逐字节相等（Level 3 round-trip）依赖的正是这条不变量。
 *
 * **AST 编辑约定**（方案 §5，供未来编辑器/T3-T5 之外的调用方参考）：若替换了
 * AST 中的某个节点（例如把一个 leaf 换成结构展开后的新对象），该节点及其
 * 祖先的 `span` 会失效——`printAst` 从不读 `span`，只读 `raw` / `children` /
 * `eol`，所以打印结果仍然正确；但 `span` 失效后不能再用它做定位，也不能再
 * 通过旧的 `AstPath` 去 `DomainIndex.byPath` 查找。重建一份内部一致（`span`
 * / `path` / `DomainIndex` 都对得上）的快照，唯一方式是
 * `loadJcx(serializeJcx(...).text)`——重新走一遍词法/AST/parse，而不是就地
 * 修补旧快照的派生字段。
 */

import type { JcxAstDocument } from '../ast';
import { printAst } from '../ast';
import type { LoadResult } from '../loadJcx';
import { encodeJcx } from './encodeJcx';
import type { PreserveOptions, SerializeResult } from './types';

/** `LoadResult` 独有 `ast` 字段，裸 `JcxAstDocument` 没有；用 `in` 判别，不用 `as`。 */
function resolveAst(input: JcxAstDocument | LoadResult): JcxAstDocument {
  return 'ast' in input ? input.ast : input;
}

/**
 * preserve 模式：AST → 原文文本 → 目标编码字节。
 *
 * `options.encoding` 缺省时沿用 AST 自身记录的编码（`ast.encoding`，即源文件
 * 探测到的编码）；显式传入不同编码时（例如把 GB18030 源转码为 UTF-8 输出），
 * `text` 不变，只有 `bytes` 按新编码重新生成。
 */
export function serializePreserve(
  input: JcxAstDocument | LoadResult,
  options: PreserveOptions,
): SerializeResult {
  const ast = resolveAst(input);
  const text = printAst(ast);
  const encoding = options.encoding ?? ast.encoding;
  const { bytes, diagnostics } = encodeJcx(text, encoding, {
    ...(options.onUnencodable === undefined ? {} : { onUnencodable: options.onUnencodable }),
  });

  return { text, bytes, encoding, diagnostics };
}
