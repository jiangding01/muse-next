/**
 * canonical 序列化 —— 组装（M1.7 T3 骨架，方案 v1.1 §3 / spec §27.3）。
 *
 * 输出 = header → `%%` 指令 / text block → 每声部 `V:` 声明 → body。
 * **body 由 T4/T5 落地**，本任务留空数组占位：T3 只保证骨架（行序、编码、
 * 末尾换行）与 header/指令/`V:` 三块内容正确。
 *
 * 固定输出形态（spec §27.3，Muse Next 决定）：一律 UTF-8、无 BOM、LF 行尾、
 * 末尾恒有换行。因此 `encodeJcx` 恒以 `'utf-8'` 调用，也不需要
 * `onUnencodable`——UTF-8 能编码任何合法 Unicode 标量值。
 */

import type { Score } from '../../../../domain';
import { encodeJcx } from '../encodeJcx';
import type { CanonicalOptions, SerializeResult } from '../types';
import { renderVoiceBody } from './body';
import { renderIgnoredFields } from './bodyFields';
import type { CanonicalBodyLine } from './body';
import { renderDirectives, renderTrailingTextBlocks } from './directives';
import { renderHeader } from './header';
import { renderVoiceDeclaration } from './voice';
import type { CanonicalDiagnostic } from './voice';

export type { CanonicalDiagnostic } from './voice';
export { canonicalVoiceLabel, renderVoiceDeclaration } from './voice';
export { renderDirectives, renderTrailingTextBlocks } from './directives';
export { renderHeader } from './header';
export { renderVoiceBody } from './body';
export { renderIgnoredFields } from './bodyFields';
export type { CanonicalBodyInput, CanonicalBodyLine, CanonicalVoiceBody } from './body';

/**
 * canonical 的产出比 `SerializeResult` 多一项 `bodyLines`：T5 插 `w:` 行需要
 * 「哪一行覆盖了哪段事件」这条映射，而 `SerializeResult` 是两种模式共用的公开
 * 形状，不该为 canonical 专有信息扩容。公开 `serializeJcx` 返回的仍是
 * `SerializeResult`（结构上多一个字段不影响）。
 */
export interface CanonicalResult extends SerializeResult {
  readonly bodyLines: readonly CanonicalBodyLine[];
}

export function serializeCanonical(score: Score, options: CanonicalOptions): CanonicalResult {
  const lines: string[] = [...renderHeader(score, options), ...renderDirectives(score)];
  const diagnostics: CanonicalDiagnostic[] = [];
  /** T5 需要的「行 → 事件区间」映射；本函数只把它交回给调用方（暂由测试消费）。 */
  const bodyLines: CanonicalBodyLine[] = [];

  for (const voice of score.voices) {
    const declaration = renderVoiceDeclaration(voice);
    lines.push(declaration.line);
    diagnostics.push(...declaration.diagnostics);
  }

  // body 区开头：`ignoredFields` 重放（body 区非法 header 字段 / 非 V 的 inline field）。
  const ignored = renderIgnoredFields(score.ignoredFields);
  lines.push(...ignored.lines);
  diagnostics.push(...ignored.diagnostics);

  // body（事件 + relation 反写 + 行边界 + body 区 `L:`）：T4。
  // `w:` 行由 T5 按 `CanonicalBodyLine.lyricRangeEnd` 插到对应行之后。
  let unitLength = score.unitLength;
  for (const voice of score.voices) {
    const body = renderVoiceBody(voice, {
      headerUnitLength: score.unitLength,
      incomingUnitLength: unitLength,
    });
    unitLength = body.outgoingUnitLength;
    diagnostics.push(...body.diagnostics);
    bodyLines.push(...body.lines);
    lines.push(...body.lines.map((line: CanonicalBodyLine) => line.text));
  }

  // 未闭合 text block 会吃掉其后的所有行，只能放在全文最后（见 `directives.ts`）。
  lines.push(...renderTrailingTextBlocks(score));

  // 全空（例如一个既无 header 字段、又关掉 magic header 的空 Score）时输出空文本，
  // 而不是一行孤零零的换行。
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  const encoded = encodeJcx(text, 'utf-8');

  return {
    text,
    bodyLines,
    bytes: encoded.bytes,
    encoding: 'utf-8',
    diagnostics: [...diagnostics, ...encoded.diagnostics],
  };
}
