/**
 * canonical 序列化 —— `%%` 指令与 text block（M1.7 T3，方案 v1.1 §3 / 决策 9、10）。
 *
 * 指令拼接（决策 10 + spec §27.3「`%%` 后无空格」CONFIRMED）：
 * `%%${name} ${rawValue.trim()}`。`RawDirective.rawValue` 是 AST
 * `directiveValue` 叶子的原文，**天生带着 `%%name` 与值之间的分隔空白**
 * （见 `parse/directives.ts`），canonical 规范化空白（拍板 D）故去掉它；
 * 行尾空白同样去除（spec §27.3）。源文本里 `%% continueall yes`、
 * `%%\tindent 2.5cm` 这类变体（词法上 `%%` 与 name 之间的空白由 lexer 单独
 * 记为 whitespace token，name 仍是 `continueall`/`indent`）因此统一写成
 * `%%continueall yes` / `%%indent 2.5cm`。值 trim 后为空时只写 `%%${name}`，
 * 不留尾随空格。
 *
 * **给 T6（L2 投影）的约定**：`rawValue` 的**前导空白属于 canonical
 * normalization 的一部分**——`%% x` 与 `%%x` 在 canonical 之后都变成 `%%x`，
 * re-parse 得到的 `rawValue` 与原 `rawValue` 只差这段空白。所以 L2 投影比较
 * `directives` 时必须按同一规则归一化（对两侧 `rawValue` 取 `trimStart()`，
 * 与本文件一致），否则会把「规范化」误判成「信息丢失」。
 *
 * `showFinger` 不单独生成：它是 `%%showfinger` 的派生值，原指令已经在
 * `directives` 里（`domain/score.ts` `RawDirective` 注释：事实层永久保留全部
 * 指令），再按 `showFinger` 补一行会产生重复指令。`chordShapes` 同理不反推
 * （方案 §3 表：gchord 不从 chordShapes 反推）。
 *
 * text block（spec §11）：`%%begintext` + `lines` **原样**（前导空白是有效对齐
 * 信息，禁止 trim）+ `closed ? '%%endtext' : 什么都不写`——决策 9/拍板 M：
 * 未闭合是事实，canonical 不补 `%%endtext`。
 *
 * **未闭合的 text block 必须排在整个文档最后**（M1.7 T4 补充）：没有
 * `%%endtext` 的块会把其后的所有行都吃进块内容里，写在 body 之前就等于让
 * 重新解析时整个正文消失——那不是「不补 endtext」，是丢正文。因此
 * `renderDirectives` 只输出**已闭合**的块，未闭合的由
 * `renderTrailingTextBlocks` 在组装末尾输出（两者各自保持数组内顺序）。
 *
 * **directives 与 textBlocks 的相对顺序**：Domain 把两者分别存进两个数组，
 * **没有保存它们交错的文档顺序**，从 Domain 无法还原。canonical 规则固定为
 * 「先全部 directives，再全部 textBlocks」，各自保持数组内顺序（拍板 F：
 * 没有事实信息就不猜）。这不影响语义——两者都不参与 body 事件流。
 */

import type { Score } from '../../../../domain';

/** 渲染 `%%` 指令行 + text block（方案 §3 行序：位于 `K:` 之后、`V:` 之前）。 */
export function renderDirectives(score: Score): string[] {
  const lines: string[] = [];

  for (const directive of score.directives) {
    const value = directive.rawValue.trim();
    lines.push(value.length === 0 ? `%%${directive.name}` : `%%${directive.name} ${value}`);
  }

  for (const block of score.textBlocks) {
    if (!block.closed) {
      continue;
    }
    lines.push('%%begintext');
    lines.push(...block.lines);
    lines.push('%%endtext');
  }

  return lines;
}

/** 未闭合 text block（见文件头）：由 `canonical/index.ts` 放在全文最后。 */
export function renderTrailingTextBlocks(score: Score): string[] {
  const lines: string[] = [];
  for (const block of score.textBlocks) {
    if (block.closed) {
      continue;
    }
    lines.push('%%begintext');
    lines.push(...block.lines);
  }
  return lines;
}
