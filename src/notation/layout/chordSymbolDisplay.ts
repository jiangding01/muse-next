/**
 * notation/layout —— 和弦符号的**展示文本**（T6.5）。
 *
 * JCX 里的和弦符号写作 `"G"` / `"D/#F"`（spec §25），那对双引号是**语法定界符**，
 * 不是和弦名的一部分——谱面上画出来会变成 `"G"` 这样多出一对引号的怪样子（人工复验
 * 发现）。本文件只做一件事：展示时剥掉最外层的一对引号。
 *
 * 三条边界，都是有意的：
 *
 * 1. **不改 Domain、不改 serializer**：`ChordSymbol.raw` 保留原文，往返序列化仍然
 *    逐字节相等。剥引号是**渲染层的展示决定**，不是事实修正。
 * 2. **不解析语义**：不拆 root / quality / slash bass，不做任何大小写或记号归一。
 *    spec §25 对和弦语法的描述是 `DOC-ONLY`，渲染层没有依据去解释它——原样转述。
 * 3. **只认「同时以 `"` 开头并以 `"` 结尾且长度 ≥ 2」**：只有一侧带引号（`"G`）、
 *    完全不带引号、以及单个 `"` 字符，都**原样返回**——那些是作者实际写下的字符，
 *    渲染层替它补全或截断都属于臆造。
 */

/** 和弦符号 `raw` → 展示文本：剥掉最外层的一对 JCX 双引号，其余原样返回。 */
export function chordSymbolDisplayText(raw: string): string {
  const quote = '"';
  if (raw.length >= 2 && raw.startsWith(quote) && raw.endsWith(quote)) {
    return raw.slice(1, -1);
  }
  return raw;
}
