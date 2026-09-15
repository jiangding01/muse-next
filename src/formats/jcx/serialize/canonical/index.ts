/**
 * canonical 序列化 —— 组装（M1.7 T3/T5，方案 v1.1 §3 / spec §27.3）。
 *
 * 输出 = header → `%%` 指令 / text block → 每声部 `V:` 声明 → body。
 * body（事件 + relation + 行边界 + body 区 `L:`）由 `body.ts`（T4）产出，
 * `w:` 行由本文件（T5）按 `CanonicalBodyLine.range` / `lyricRangeEnd` 插入：
 * `body.ts` 已经把「哪一行覆盖哪段事件、哪一行是某条正文的收尾行」算好，
 * 本文件不重新推导行边界，只做「歌词行插在哪」这一件事（`./lyrics`）。
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
import {
  collectShadowedLyricLines,
  groupBoundLyricLines,
  lyricRangeKey,
  renderLeadingLyricLines,
  renderLyricLine,
} from './lyrics';
import { renderVoiceDeclaration } from './voice';
import type { CanonicalDiagnostic } from './voice';

export type { CanonicalDiagnostic } from './voice';
export { canonicalVoiceLabel, renderVoiceDeclaration } from './voice';
export { renderDirectives, renderTrailingTextBlocks } from './directives';
export { renderHeader } from './header';
export { renderVoiceBody } from './body';
export { renderIgnoredFields } from './bodyFields';
export {
  collectShadowedLyricLines,
  groupBoundLyricLines,
  lyricRangeKey,
  renderLeadingLyricLines,
  renderLyricLine,
} from './lyrics';
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
  // `w:` 行（T5）按 `CanonicalBodyLine.range` / `lyricRangeEnd` 插到对应行前后，
  // 见 `./lyrics` 文件头对「行边界已由 T4 算好、T5 只管插入」的说明。
  let unitLength = score.unitLength;
  /** 整份文档正文区是否已经出现过任何内容（跨声部，见 `renderLeadingLyricLines`）。 */
  let bodyContentSeen = false;
  for (const voice of score.voices) {
    const body = renderVoiceBody(voice, {
      headerUnitLength: score.unitLength,
      incomingUnitLength: unitLength,
    });
    unitLength = body.outgoingUnitLength;
    diagnostics.push(...body.diagnostics);
    bodyLines.push(...body.lines);

    const hasContent = body.lines.length > 0;
    const leading = renderLeadingLyricLines(voice, !bodyContentSeen && hasContent);
    diagnostics.push(...leading.diagnostics);
    const boundLyrics = groupBoundLyricLines(voice);

    let leadingInserted = false;
    /** 哪些 `boundLyrics` 的 key 真被某一行的 `lyricRangeEnd` 命中过（/check P2②）。 */
    const consumedKeys = new Set<string>();
    for (const line of body.lines) {
      if (!leadingInserted && line.range !== null) {
        lines.push(...leading.lines);
        leadingInserted = true;
      }
      lines.push(line.text);
      if (line.lyricRangeEnd !== null) {
        const key = lyricRangeKey(line.lyricRangeEnd);
        consumedKeys.add(key);
        const bound = boundLyrics.get(key) ?? [];
        for (const lyricLine of bound) {
          lines.push(renderLyricLine(lyricLine));
        }
      }
    }
    // 兜底：body 全是非事件行（理论上不会发生，`renderVoiceBody` 事件为空时
    // 连 `[V:n]` 都不产出），仍不能静默丢 leading 歌词。
    if (!leadingInserted) {
      lines.push(...leading.lines);
    }
    // `body.ts` 的 `collectRanges` 按 `lastEventId` 去重登记：两条 bodyRange
    // 共享同一个收尾事件但 `firstEventId` 不同时，后一条永远不会被任何
    // `lyricRangeEnd` 命中——不是「没有绑定目标」，是「被同收尾的另一条歌词
    // 遮住」，必须单独发现、单独发 warning，不能静默丢字。
    diagnostics.push(...collectShadowedLyricLines(voice, boundLyrics, consumedKeys));

    if (hasContent) {
      bodyContentSeen = true;
    }
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
